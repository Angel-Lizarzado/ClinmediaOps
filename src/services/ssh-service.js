const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { getConfigManager } = require('./config-manager');

// Timeout por defecto de cualquier comando remoto. Sin esto, un comando que
// nunca cierra su stream deja la promesa colgada para siempre.
// Se elige 30 min a propósito: es el techo que ya usaban los comandos lentos
// (creación de suscripción, restore de BD), así que ningún flujo que hoy
// funciona se rompe. Solo corta los cuelgues indefinidos.
// Pasar `timeoutMs: 0` explícitamente lo desactiva para casos puntuales.
const DEFAULT_COMMAND_TIMEOUT_MS = 1800000; // 30 minutos

// Inactividad tras la cual se cierra una conexión del pool.
const POOL_IDLE_TIMEOUT_MS = 180000; // 3 minutos

class SshService {
  constructor() {
    this.configManager = getConfigManager();
    this.clients = new Map(); // taskId -> client
    this.connectionPool = new Map(); // cacheKey -> { client, timer, active }
  }

  /**
   * Resolve and validate a private key from any available source.
   * Returns the key content as string, or null if nothing found.
   */
  _resolvePrivateKey(sshConfig) {
    // 1. If the caller explicitly passed a privateKey content, validate and use it
    if (sshConfig.privateKey) {
      const keyStr = sshConfig.privateKey.toString();
      if (keyStr.startsWith('-----BEGIN')) {
        return keyStr;
      }
      console.warn('[SSH-KEY] privateKey del caller NO empieza con -----BEGIN, ignorando. Contenido:', keyStr.slice(0, 60));
    }

    // 2. If the caller gave us a privateKeyPath, resolve and read it
    if (sshConfig.privateKeyPath) {
      try {
        let resolved = this.resolvePath(sshConfig.privateKeyPath);
        // Autocorrección: si termina en .pub, quitar el sufijo para buscar la llave privada
        if (resolved.endsWith('.pub')) {
          resolved = resolved.slice(0, -4);
          console.log('[SSH-KEY] privateKeyPath terminaba en .pub, corregido a:', resolved);
        }
        const content = fs.readFileSync(resolved, 'utf8');
        if (content.startsWith('-----BEGIN')) {
          return content;
        }
        console.warn('[SSH-KEY] Archivo en privateKeyPath no es una llave válida:', resolved);
      } catch (err) {
        const resolvedPath = this.resolvePath(sshConfig.privateKeyPath);
        console.error(`[SSH-KEY-ERROR] No se pudo leer la llave privada en la ruta: "${resolvedPath}". Código: ${err.code || 'desconocido'}. Mensaje: ${err.message}. Verifica que la ruta en la configuración del servidor sea correcta y que el archivo exista.`);
        // No relanzamos — seguimos al paso 3 para intentar con el path por defecto
      }
    }

    // 3. Try default key path from config-manager (sshKeys.privateKeyPath)
    try {
      const config = this.configManager.getConfig();
      if (config?.sshKeys?.privateKeyPath) {
        let keyPath = this.resolvePath(config.sshKeys.privateKeyPath);
        // Autocorrección: si termina en .pub, quitar el sufijo para buscar la llave privada
        if (keyPath.endsWith('.pub')) {
          keyPath = keyPath.slice(0, -4);
          console.log('[SSH-KEY] config.sshKeys.privateKeyPath terminaba en .pub, corregido a:', keyPath);
        }
        const content = fs.readFileSync(keyPath, 'utf8');
        if (content.startsWith('-----BEGIN')) {
          return content;
        }
        console.warn('[SSH-KEY] Archivo en config.sshKeys.privateKeyPath no es válido:', keyPath);
      }
    } catch (err) {
      const cfg = this.configManager.getConfig();
      const badPath = cfg?.sshKeys?.privateKeyPath || '(no configurado)';
      const resolvedPath = this.resolvePath(badPath);
      console.error(`[SSH-KEY-ERROR] No se pudo leer la llave desde config.sshKeys.privateKeyPath: "${badPath}" → resuelto a "${resolvedPath}". Código: ${err.code || 'desconocido'}. ${err.message}`);
    }

    // 4. AUTO-SSH: Buscar en os.homedir()/.ssh/id_rsa (¡la terminal de Windows lo usa!)
    const homeDir = os.homedir();
    const autoPaths = [
      path.join(homeDir, '.ssh', 'id_rsa'),
      path.join(homeDir, '.ssh', 'id_ed25519'),
      path.join(homeDir, '.ssh', 'id_ecdsa'),
      path.join(homeDir, '.ssh', 'identity'),
    ];
    for (const autoPath of autoPaths) {
      try {
        if (fs.existsSync(autoPath)) {
          const content = fs.readFileSync(autoPath, 'utf8');
          if (content.startsWith('-----BEGIN')) {
            return content;
          }
        }
      } catch { /* skip */ }
    }

    console.warn('[SSH-KEY] No se encontró ninguna llave privada válida en ninguna fuente.');
    return null;
  }

  /**
   * Multiplexación SSH: Conecta (o reutiliza) un cliente SSH por host.
   * Util para escaneos masivos de flota sin activar alarmas de firewall por múltiples logins.
   */
  async connectCached(sshConfig, readyTimeout = 40000) {
    const cacheKey = `${sshConfig.host}:${sshConfig.port}:${sshConfig.username}`;
    const poolEntry = this.connectionPool.get(cacheKey);

    if (poolEntry && poolEntry.client) {
      const client = poolEntry.client;
      if (client._sock && !client._sock.destroyed) {
        console.log(`[SSH-POOL] Reutilizando conexión existente para ${cacheKey} (Multiplexación)`);
        // Reiniciamos el timer de inactividad
        this._resetIdleTimer(cacheKey);
        return client;
      } else {
        // El socket estaba muerto, limpiamos y conectamos de nuevo
        console.log(`[SSH-POOL] Conexión existente para ${cacheKey} estaba muerta. Reconectando...`);
        this._removeCachedClient(cacheKey);
      }
    }

    console.log(`[SSH-POOL] Creando NUEVA conexión compartida para ${cacheKey}`);
    const client = await this.connect(sshConfig, `pool-${cacheKey}`, readyTimeout);

    // Registrar la entrada ANTES de enganchar los listeners: si la conexión muere
    // de inmediato, el handler debe encontrar la entrada para poder limpiarla.
    this.connectionPool.set(cacheKey, { client, timer: null, active: 0 });

    // Monitor for unexpected closes
    client.on('close', () => {
      console.log(`[SSH-POOL] Conexión compartida cerrada: ${cacheKey}`);
      this._removeCachedClient(cacheKey, client);
    });

    client.on('error', () => {
      console.log(`[SSH-POOL] Conexión compartida con error: ${cacheKey}`);
      this._removeCachedClient(cacheKey, client);
    });

    this._resetIdleTimer(cacheKey);

    return client;
  }

  _resetIdleTimer(cacheKey) {
    const poolEntry = this.connectionPool.get(cacheKey);
    if (!poolEntry) return;

    if (poolEntry.timer) {
      clearTimeout(poolEntry.timer);
      poolEntry.timer = null;
    }

    // Con una operación en vuelo NO se arma el timer: una transferencia larga
    // no emite comandos y el idle timeout la mataba a mitad de camino.
    if (poolEntry.active > 0) return;

    poolEntry.timer = setTimeout(() => {
      const current = this.connectionPool.get(cacheKey);
      // Guarda anti-race: si se reemplazó la entrada o hay actividad, no cerrar.
      if (!current || current !== poolEntry || current.active > 0) return;

      console.log(`[SSH-POOL] Cerrando conexión inactiva (Idle Timeout 3m) para ${cacheKey}`);
      try {
        if (poolEntry.client) poolEntry.client.end();
      } catch (e) { /* ignore */ }
      this.connectionPool.delete(cacheKey);
    }, POOL_IDLE_TIMEOUT_MS);
  }

  /**
   * Elimina una entrada del pool. Si se pasa `client`, solo elimina cuando
   * coincide — evita que el 'close' de una conexión vieja borre la nueva.
   */
  _removeCachedClient(cacheKey, client = null) {
    const poolEntry = this.connectionPool.get(cacheKey);
    if (!poolEntry) return;
    if (client && poolEntry.client !== client) return;
    if (poolEntry.timer) clearTimeout(poolEntry.timer);
    this.connectionPool.delete(cacheKey);
  }

  /**
   * Busca la entrada del pool que corresponde a un cliente.
   * @returns {[string, object]|null} par [cacheKey, poolEntry]
   */
  _findPoolEntry(client) {
    for (const [key, poolEntry] of this.connectionPool.entries()) {
      if (poolEntry.client === client) return [key, poolEntry];
    }
    return null;
  }

  /**
   * Marca el inicio de una operación larga sobre un cliente del pool
   * (descarga, subida, compresión remota). Mientras haya operaciones activas
   * el idle timeout queda suspendido.
   */
  _beginPoolActivity(client) {
    const found = this._findPoolEntry(client);
    if (!found) return;
    const [, poolEntry] = found;
    poolEntry.active += 1;
    if (poolEntry.timer) {
      clearTimeout(poolEntry.timer);
      poolEntry.timer = null;
    }
  }

  /**
   * Marca el fin de una operación larga. Al llegar a cero rearma el idle timeout.
   */
  _endPoolActivity(client) {
    const found = this._findPoolEntry(client);
    if (!found) return;
    const [cacheKey, poolEntry] = found;
    poolEntry.active = Math.max(0, poolEntry.active - 1);
    if (poolEntry.active === 0) {
      this._resetIdleTimer(cacheKey);
    }
  }

  /**
   * Envuelve una operación larga sobre un cliente del pool, suspendiendo el
   * idle timeout mientras dura y rearmándolo pase lo que pase.
   */
  async _withPoolActivity(client, fn) {
    this._beginPoolActivity(client);
    try {
      return await fn();
    } finally {
      this._endPoolActivity(client);
    }
  }

  async connect(sshConfig, taskId = 'default', readyTimeout = 40000) {
    // --- KILL ZOMBIES: si ya hay una conexión con este taskId, la cerramos ---
    const existing = this.clients.get(taskId);
    if (existing) {
      try { existing.end(); } catch (e) { /* ignore */ }
      this.clients.delete(taskId);
    }

    const client = new Client();
    this.clients.set(taskId, client);

    return new Promise((resolve, reject) => {
      let settled = false;

      // --- Timeout forzado: si en 15 segundos no hay ready, reject ---
      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.clients.delete(taskId);
        try { client.end(); } catch (_) { /* ignore */ }
        reject(new Error('[SSH] Timeout forzado de conexión SSH — 15s sin respuesta'));
      }, 15000);

      const cleanup = () => {
        clearTimeout(connectTimeout);
      };

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(client);
      });

      client.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        console.error(`[SSH] Error de conexión (task ${taskId}):`, err.code || err.message);
        this.clients.delete(taskId);
        reject(err);
      });

      client.on('close', () => {
        this.clients.delete(taskId);
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('[SSH] Conexión cerrada antes de establecer — posible firewall o host inalcanzable'));
        }
      });

      client.on('timeout', () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.clients.delete(taskId);
        try { client.end(); } catch (_) { /* ignore */ }
        reject(new Error('[SSH] Timeout de handshake ssh2 — servidor no responde en ventana de negociación'));
      });

      // --- Resolver la llave privada con AUTO-SSH ---
      let privateKeyContent = null;
      // Si sshConfig ya trae privateKey (puede venir del caller como contenido o como ruta), lo procesamos
      if (sshConfig.privateKey) {
        const raw = sshConfig.privateKey;
        // Si es un string que parece contenido de llave, usarlo directamente
        if (typeof raw === 'string' && raw.startsWith('-----BEGIN')) {
          privateKeyContent = raw;
        } else {
          // Podría ser una ruta, delegar al resolvedor completo
          privateKeyContent = this._resolvePrivateKey(sshConfig);
        }
      }

      // Si no se definió aún (sin privateKey en sshConfig), ir al resolvedor completo
      // EXCEPCIÓN: si forcePasswordAuth=true, NO resolver auto-keys — usar solo password
      if (!privateKeyContent && !sshConfig.forcePasswordAuth) {
        privateKeyContent = this._resolvePrivateKey(sshConfig);
      }

      // --- Build connection config with EXTENDED algorithms ---
      const connectionConfig = {
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.username,
        readyTimeout,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        highWaterMark: 262144, // 256KB read buffer for SFTP (default 16KB)
        // Algoritmos modernos (como usa la terminal de Windows)
        algorithms: {
          kex: [
            'curve25519-sha256',
            'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256',
            'ecdh-sha2-nistp384',
            'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group14-sha1',
          ],
          cipher: [
            'aes256-gcm@openssh.com',
            'aes128-gcm@openssh.com',
            'aes256-ctr',
            'aes192-ctr',
            'aes128-ctr',
          ],
          hmac: [
            'hmac-sha2-256',
            'hmac-sha2-512',
            'hmac-sha1',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
          ],
        },
      };

      // --- TCP_NODELAY + Keepalive on the underlying socket after connect ---
      client.on('ready', () => {
        try {
          const sock = client._sock || client.sock;
          if (sock) {
            sock.setNoDelay(true);
            sock.setKeepAlive(true, 10000);
          }
        } catch (_) { /* non-critical */ }
      });

      // --- Try private key first, then password fallback ---
      if (privateKeyContent) {
        connectionConfig.privateKey = privateKeyContent;
      } else if (sshConfig.password) {
        connectionConfig.password = sshConfig.password;
      } else {
        const triedPaths = [];
        if (sshConfig.privateKeyPath) {
          triedPaths.push(`caller.privateKeyPath="${this.resolvePath(sshConfig.privateKeyPath)}"`);
        }
        try {
          const cfg = this.configManager.getConfig();
          if (cfg?.sshKeys?.privateKeyPath) {
            triedPaths.push(`config.sshKeys.privateKeyPath="${this.resolvePath(cfg.sshKeys.privateKeyPath)}"`);
          }
        } catch {}
        triedPaths.push(`auto-detected in ~/.ssh/{id_rsa,id_ed25519,id_ecdsa,identity}`);
        const errMsg = `[SSH] No se pudo resolver ninguna llave privada. Rutas intentadas: ${triedPaths.join(', ')}. Verifica que exista un archivo de llave privada válido (que comience con -----BEGIN) en alguna de estas rutas, o configura sshKeys.privateKeyPath en la configuración del servidor.`;
        console.error(errMsg);
        reject(new Error(errMsg));
        return;
      }

      client.connect(connectionConfig);
    });
  }

  async executeCommand(client, command, options = {}) {
    // Si es un cliente del pool de multiplexación, reiniciamos su timer de inactividad
    const found = this._findPoolEntry(client);
    if (found) this._resetIdleTimer(found[0]);

    // `timeoutMs` es nuestro, no de ssh2: se separa antes de pasar las opciones
    // de exec. `timeoutMs: 0` desactiva el timeout de forma explícita.
    const { timeoutMs, ...execOptions } = options;
    const effectiveTimeout = timeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : timeoutMs;

    return new Promise((resolve, reject) => {
      client.exec(command, execOptions, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';
        let timeoutTimer = null;
        let settled = false;

        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          fn(arg);
        };

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('close', (code, signal) => {
          finish(resolve, {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: code,
            signal: signal
          });
        });

        stream.on('error', (streamErr) => {
          finish(reject, streamErr);
        });

        if (effectiveTimeout > 0) {
          timeoutTimer = setTimeout(() => {
            try { stream.close(); } catch (e) { /* ignore */ }
            finish(reject, new Error(
              `Command timed out after ${effectiveTimeout}ms: ${command.substring(0, 80)}...`
            ));
          }, effectiveTimeout);
        }
      });
    });
  }

  /**
   * 🔥 v1.14.0: Ejecuta un comando SSH con streaming de salida en tiempo real.
   * NO reemplaza executeCommand — es una alternativa para procesos largos
   * donde se necesita ver el progreso chunk por chunk (ej: scripts Bash de despliegue).
   * @param {object} client - Cliente SSH2 conectado
   * @param {string} command - Comando a ejecutar
   * @param {function} onProgress - Callback llamado con cada chunk de stdout (string)
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async _executeStreamCommandImpl(client, command, onProgress) {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => {
          const chunk = data.toString();
          stdout += chunk;
          if (typeof onProgress === 'function') {
            try {
              onProgress(chunk);
            } catch (_) {
              // never let a callback break the stream
            }
          }
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('close', (code, signal) => {
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: code,
            signal: signal
          });
        });

        stream.on('error', (err) => {
          reject(err);
        });
      });
    });
  }

  async _injectPublicKeyImpl(client, publicKeyPath) {
    const resolvedPath = this.resolvePath(publicKeyPath);
    
    let publicKey;
    try {
      publicKey = fs.readFileSync(resolvedPath, 'utf8').trim();
    } catch (error) {
      throw new Error(`Could not read public key from ${resolvedPath}: ${error.message}`);
    }
    
    // Check if key already exists in authorized_keys
    const checkResult = await this.executeCommand(
      client,
      `grep -Fx "${publicKey}" ~/.ssh/authorized_keys 2>/dev/null || echo "not found"`
    );
    
    if (checkResult.stdout === 'not found') {
      // Key doesn't exist, add it
      await this.executeCommand(
        client,
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
      );
      
      return true;
    } else {
      return true;
    }
  }

  // ── Operaciones largas: envueltas para suspender el idle timeout del pool ──
  // La implementación real vive en _<nombre>Impl.

  async uploadFile(client, localPath, remotePath) {
    return this._withPoolActivity(client, () => this._uploadFileImpl(client, localPath, remotePath));
  }

  async downloadFile(client, remotePath, localPath) {
    return this._withPoolActivity(client, () => this._downloadFileImpl(client, remotePath, localPath));
  }

  async downloadFileWithProgress(client, remotePath, localPath, onProgress) {
    return this._withPoolActivity(client, () => this._downloadFileWithProgressImpl(client, remotePath, localPath, onProgress));
  }

  async streamRemoteCompress(client, remotePath, localPath, onProgress) {
    return this._withPoolActivity(client, () => this._streamRemoteCompressImpl(client, remotePath, localPath, onProgress));
  }

  async uploadFileFast(client, localPath, remotePath, onProgress) {
    return this._withPoolActivity(client, () => this._uploadFileFastImpl(client, localPath, remotePath, onProgress));
  }

  async executeStreamCommand(client, command, onProgress) {
    return this._withPoolActivity(client, () => this._executeStreamCommandImpl(client, command, onProgress));
  }

  async executeRemoteScript(client, scriptContent, scriptName = null) {
    return this._withPoolActivity(client, () => this._executeRemoteScriptImpl(client, scriptContent, scriptName));
  }

  async injectPublicKey(client, publicKeyPath) {
    return this._withPoolActivity(client, () => this._injectPublicKeyImpl(client, publicKeyPath));
  }

  async _uploadFileImpl(client, localPath, remotePath) {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        
        const readStream = fs.createReadStream(localPath);
        const writeStream = sftp.createWriteStream(remotePath);
        
        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });
        
        writeStream.on('error', (err) => {
          sftp.end();
          reject(err);
        });
        
        readStream.pipe(writeStream);
      });
    });
  }

  async _downloadFileImpl(client, remotePath, localPath) {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Ensure local directory exists
        const localDir = path.dirname(localPath);
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }
        
        const readStream = sftp.createReadStream(remotePath, { highWaterMark: 1048576 });
        const writeStream = fs.createWriteStream(localPath, { highWaterMark: 1048576 });
        
        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });
        
        writeStream.on('error', (err) => {
          sftp.end();
          reject(err);
        });
        
        readStream.pipe(writeStream);
      });
    });
  }

  async _downloadFileWithProgressImpl(client, remotePath, localPath, onProgress) {
    const sftp = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('[SFTP] Timeout: No se pudo establecer conexión SFTP en 10s'));
      }, 10000);

      client.sftp((err, sftp) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(sftp);
      });
    });

    let sftpEnded = false;
    const safeEnd = () => {
      if (!sftpEnded) {
        sftpEnded = true;
        try { sftp.end(); } catch (e) { /* ignore */ }
      }
    };

    try {
      // ---- Stat remote file with fallback chain ----
      let stat;
      try {
        stat = await new Promise((res, rej) =>
          sftp.stat(remotePath, (e, s) => e ? rej(e) : res(s))
        );
      } catch (_) {
        try {
          stat = await new Promise((res, rej) =>
            sftp.stat('./' + remotePath, (e, s) => e ? rej(e) : res(s))
          );
        } catch (_) {
          try {
            await new Promise((res, rej) =>
              sftp.readdir('.', (e, list) => e ? rej(e) : res(list))
            );
          } catch (re) {
            // Silently ignore — fallback to error below
          }
          throw new Error(`[SFTP] No se encontró ${remotePath} (tampoco ./${remotePath})`);
        }
      }

      const totalSize = stat.size;

      // ---- Ensure local directory exists ----
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      // ---- Download with fastGet (multi-channel parallel) ----
      const startTime = Date.now();
      let lastEmit = 0;

      await new Promise((resolve, reject) => {
        let watchdog;

        const resetWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            if (fs.existsSync(localPath)) {
              try { fs.unlinkSync(localPath); } catch (e) {}
            }
            safeEnd();
            reject(new Error('TIMEOUT DE DATOS'));
          }, 120000);
        };

        resetWatchdog();

        sftp.fastGet(remotePath, localPath, {
          concurrency: 16,
          chunkSize: 65536,
          highWaterMark: 1048576,
          step: (totalTransferred, chunk, total) => {
            resetWatchdog();
            const now = Date.now();
            if (now - lastEmit >= 500) {
              lastEmit = now;
              const pct = total > 0 ? Math.round((totalTransferred / total) * 100) : 0;
              const elapsed = (now - startTime) / 1000;
              const transferredMb = totalTransferred / 1024 / 1024;
              const totalMb = total / 1024 / 1024;
              const speed = elapsed > 0 ? (transferredMb / elapsed) : 0;
              const msg = `Descargando: ${transferredMb.toFixed(2)} MB / ${totalMb.toFixed(2)} MB (${speed.toFixed(2)} MB/s)`;
              if (onProgress) onProgress(totalTransferred, total, pct, msg);
            }
          }
        }, (err) => {
          if (watchdog) clearTimeout(watchdog);
          if (err) {
            if (fs.existsSync(localPath)) {
              try { fs.unlinkSync(localPath); } catch (e) {}
            }
            safeEnd();
            reject(err);
          } else {
            safeEnd();
            resolve();
          }
        });
      });
    } catch (error) {
      safeEnd();
      throw error;
    }
  }

  /**
   * Stream a remote tar.gz archive directly to a local file via SSH exec pipe.
   *
   * Instead of `tar -cf` (creates file on remote) + SFTP download (sequential),
   * this runs `tar -czf -` on remote and pipes stdout to a local write stream.
   * Compression and download happen simultaneously — the network saturates early.
   *
   * @param {Object} client - SSH2 client instance
   * @param {string} remotePath - Remote directory to compress
   * @param {string} localPath - Local file path (should end in .tar.gz)
   * @param {Function} onProgress - Callback(receivedBytes, totalEstimate, pct, message)
   */
  async _streamRemoteCompressImpl(client, remotePath, localPath, onProgress) {
    // ── 1. Estimate remote size via du (with ~5% compression overhead buffer) ──
    let estimatedSize = 0;
    try {
      const du = await this.executeCommand(client, `du -sb "${remotePath}" 2>/dev/null || echo "0"`);
      const match = du.stdout.match(/^(\d+)/);
      if (match) {
        // tar+gzip typically achieves 3-8x compression on WP sites;
        // we use 40% of original as a conservative estimate so the bar
        // doesn't stay at 99% for the last chunk.
        estimatedSize = Math.round(parseInt(match[1], 10) * 0.4);
      }
    } catch {
      // If du fails, we'll just report bytes without percentage
    }

    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    const writeStream = fs.createWriteStream(localPath);
    let totalBytes = 0;
    const startTime = Date.now();
    let lastEmit = 0;
    let execError = null;

    return new Promise((resolve, reject) => {
      client.exec(`tar -czf - -C "${remotePath}" .`, (err, stream) => {
        if (err) {
          writeStream.destroy();
          try { fs.unlinkSync(localPath); } catch (_) {}
          return reject(err);
        }

        // Stdout: compressed data stream
        stream.on('data', (chunk) => {
          writeStream.write(chunk);
          totalBytes += chunk.length;

          const now = Date.now();
          if (now - lastEmit >= 500 && onProgress) {
            lastEmit = now;
            const elapsed = (now - startTime) / 1000;
            const mb = totalBytes / 1024 / 1024;
            const speed = elapsed > 0 ? mb / elapsed : 0;

            let pct = 0;
            if (estimatedSize > 0) {
              pct = Math.min(Math.round((totalBytes / estimatedSize) * 100), 99);
            }

            const estMb = estimatedSize > 0
              ? `~${(estimatedSize / 1024 / 1024).toFixed(0)}`
              : '??';
            onProgress(
              totalBytes, estimatedSize || totalBytes,
              pct,
              `Descargando: ${mb.toFixed(2)} MB / ${estMb} MB (${speed.toFixed(2)} MB/s)`
            );
          }
        });

        // Stderr: capture errors
        stream.stderr.on('data', (data) => {
          execError = data.toString();
        });

        // Close: stream ended
        stream.on('close', (code) => {
          writeStream.end();
          if (code !== 0) {
            try { fs.unlinkSync(localPath); } catch (_) {}
            return reject(
              new Error(`[STREAM] tar falló (código ${code}): ${execError || 'error desconocido'}`)
            );
          }
          resolve();
        });

        stream.on('error', (err) => {
          writeStream.destroy();
          try { fs.unlinkSync(localPath); } catch (_) {}
          reject(err);
        });
      });
    });
  }

  /**
   * Upload file using sftp.fastPut with concurrency and real-time progress logging.
   * @param {Object} client - SSH2 client instance
   * @param {string} localPath - Local file path
   * @param {string} remotePath - Remote file path
   * @param {Function} onProgress - Callback(transferred, total, percent, message)
   */
  async _uploadFileFastImpl(client, localPath, remotePath, onProgress) {
    const sftp = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('[SFTP] Timeout: No se pudo establecer conexión SFTP en 10s'));
      }, 10000);

      client.sftp((err, sftp) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(sftp);
      });
    });

    let sftpEnded = false;
    const safeEnd = () => {
      if (!sftpEnded) {
        sftpEnded = true;
        try { sftp.end(); } catch (e) { /* ignore */ }
      }
    };

    try {
      const stat = require('fs').statSync(localPath);
      const totalSize = stat.size;

      const startTime = Date.now();
      let lastEmit = 0;

      await new Promise((resolve, reject) => {
        let watchdog;

        const resetWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            safeEnd();
            reject(new Error('TIMEOUT DE DATOS (upload)'));
          }, 300000); // 5 min total timeout for upload
        };

        resetWatchdog();

        sftp.fastPut(localPath, remotePath, {
          concurrency: 32,
          chunkSize: 262144, // 256KB — menos overhead que 64KB, satura mejor la red
          step: (totalTransferred, chunk, total) => {
            resetWatchdog();
            const now = Date.now();
            if (now - lastEmit >= 500) {
              lastEmit = now;
              const pct = total > 0 ? Math.round((totalTransferred / total) * 100) : 0;
              const elapsed = (now - startTime) / 1000;
              const transferredMb = totalTransferred / 1024 / 1024;
              const totalMb = total / 1024 / 1024;
              const speed = elapsed > 0 ? (transferredMb / elapsed) : 0;
              const msg = `Subiendo: ${transferredMb.toFixed(2)} MB / ${totalMb.toFixed(2)} MB (${speed.toFixed(2)} MB/s)`;
              if (onProgress) onProgress(totalTransferred, total, pct, msg);
            }
          }
        }, (err) => {
          if (watchdog) clearTimeout(watchdog);
          if (err) {
            safeEnd();
            reject(err);
          } else {
            safeEnd();
            resolve();
          }
        });
      });
    } catch (error) {
      safeEnd();
      throw error;
    }
  }

  async _executeRemoteScriptImpl(client, scriptContent, scriptName = null) {
    // Generate a unique script name with UUID if not provided
    const { v4: uuidv4 } = require('uuid');
    const scriptId = scriptName || `script_${uuidv4().replace(/-/g, '')}.sh`;
    const remoteScriptPath = `/tmp/${scriptId}`;
    
    // Upload script
    const tempLocalPath = path.join(__dirname, '..', '..', 'temp', scriptId);
    const tempDir = path.dirname(tempLocalPath);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    fs.writeFileSync(tempLocalPath, scriptContent);
    await this.uploadFile(client, tempLocalPath, remoteScriptPath);
    
    // Make script executable and run it
    await this.executeCommand(client, `chmod +x ${remoteScriptPath}`);
    const result = await this.executeCommand(client, remoteScriptPath);
    
    // Cleanup remote script
    try {
      await this.executeCommand(client, `rm -f ${remoteScriptPath}`);
    } catch (error) {
      console.warn(`Failed to cleanup remote script ${remoteScriptPath}:`, error.message);
    }
    
    // Cleanup local temp file
    try {
      fs.unlinkSync(tempLocalPath);
    } catch (error) {
      console.warn(`Failed to cleanup local temp file ${tempLocalPath}:`, error.message);
    }
    
    return result;
  }

  async disconnect(client) {
    if (client) {
      client.end();
    }
  }

  async disconnectAll() {
    for (const [taskId, client] of this.clients.entries()) {
      try {
        client.end();
      } catch (error) {
        console.warn(`Error disconnecting SSH client for task ${taskId}:`, error.message);
      }
    }
    this.clients.clear();

    // El pool de multiplexación se limpiaba nunca: sus conexiones y sus timers
    // de inactividad sobrevivían al cierre de la app.
    for (const [cacheKey, poolEntry] of this.connectionPool.entries()) {
      if (poolEntry.timer) clearTimeout(poolEntry.timer);
      try {
        if (poolEntry.client) poolEntry.client.end();
      } catch (error) {
        console.warn(`Error cerrando conexión del pool ${cacheKey}:`, error.message);
      }
    }
    this.connectionPool.clear();
  }

  /**
   * Genera un par de llaves RSA-4096 usando el módulo nativo `crypto` de Node.js.
   * No requiere ssh-keygen ni OpenSSH en el PATH — funciona en cualquier Windows.
   *
   * - Llave privada: formato PKCS#1 PEM (BEGIN RSA PRIVATE KEY) — compatible con ssh2 y OpenSSH.
   * - Llave pública: formato OpenSSH wire (ssh-rsa <base64> <comment>) — compatible con authorized_keys.
   *
   * @param {string} [keyPath='~/.ssh/id_rsa'] - Ruta destino sin extensión
   * @returns {{ success: boolean, publicKey: string, path: string }}
   */
  generateSshKey(keyPath = '~/.ssh/id_rsa') {
    const crypto = require('crypto');
    const resolvedPath = this.resolvePath(keyPath);
    const publicPath = resolvedPath + '.pub';

    // No sobrescribir si ya existe
    if (fs.existsSync(resolvedPath) || fs.existsSync(publicPath)) {
      throw new Error(
        `YA_EXISTE: Ya existe una llave SSH en ${resolvedPath}. No se sobrescribe por seguridad.`
      );
    }

    // Asegurar ~/.ssh con permisos correctos
    const sshDir = path.dirname(resolvedPath);
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true });
      try { fs.chmodSync(sshDir, 0o700); } catch { /* Windows ignora chmod */ }
    }

    // ── Generar par RSA-4096 ──────────────────────────────────────────────────
    const { privateKey: privObj, publicKey: pubObj } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
    });

    // ── Llave privada: PKCS#1 PEM (ssh2 y OpenSSH esperan este formato) ───────
    const privateKeyPem = privObj.export({ type: 'pkcs1', format: 'pem' });

    // ── Llave pública: OpenSSH wire format ────────────────────────────────────
    // Node exporta RSA pública en formato DER SubjectPublicKeyInfo (SPKI).
    // OpenSSH authorized_keys espera: "ssh-rsa <base64(wire)> <comment>"
    // El wire format RSA es: len("ssh-rsa") + "ssh-rsa" + len(e) + e + len(n) + n
    const spkiDer = pubObj.export({ type: 'spki', format: 'der' });

    // Parsear el DER SPKI para extraer el módulo (n) y el exponente (e)
    // El DER SPKI RSA tiene la forma:
    //   SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { SEQUENCE { INT n, INT e } } }
    // Buscamos el BIT STRING (tag 0x03) y dentro parseamos el inner SEQUENCE.
    function parseDerSpkiRsa(der) {
      let offset = 0;
      const readLen = (buf, pos) => {
        if (buf[pos] < 0x80) return { len: buf[pos], next: pos + 1 };
        const numBytes = buf[pos] & 0x7f;
        let len = 0;
        for (let i = 0; i < numBytes; i++) len = (len << 8) | buf[pos + 1 + i];
        return { len, next: pos + 1 + numBytes };
      };

      // Outer SEQUENCE
      offset++; // skip 0x30
      const outerLen = readLen(der, offset); offset = outerLen.next + outerLen.len;

      // La estructura DER de SPKI: los primeros bytes tras el outer SEQUENCE son
      // el AlgorithmIdentifier SEQUENCE. Saltamos directamente al BIT STRING (0x03).
      // Recomenzamos desde el inicio del outer SEQUENCE para navegar correctamente.
      let p = 1;
      const ol = readLen(der, p); p = ol.next;

      // AlgorithmIdentifier SEQUENCE
      p++; // 0x30
      const algoLen = readLen(der, p); p = algoLen.next + algoLen.len;

      // BIT STRING (0x03)
      p++; // skip tag 0x03
      const bsLen = readLen(der, p); p = bsLen.next;
      p++; // skip unused bits byte (0x00)

      // Inner SEQUENCE { INT n, INT e }
      p++; // 0x30
      const innerLen = readLen(der, p); p = innerLen.next;

      // INT n
      p++; // 0x02
      const nLen = readLen(der, p); p = nLen.next;
      const n = der.slice(p, p + nLen.len); p += nLen.len;

      // INT e
      p++; // 0x02
      const eLen = readLen(der, p); p = eLen.next;
      const e = der.slice(p, p + eLen.len);

      return { n, e };
    }

    const { n, e } = parseDerSpkiRsa(spkiDer);

    // Construir el wire format: cada campo es uint32_be(len) + bytes
    const encodeField = (buf) => {
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeUInt32BE(buf.length, 0);
      return Buffer.concat([lenBuf, buf]);
    };

    const keyType = Buffer.from('ssh-rsa');
    const wireKey = Buffer.concat([
      encodeField(keyType),
      encodeField(e),
      encodeField(n),
    ]);

    const comment = `kraken-cli@${os.hostname()}`;
    const publicKeyOpenSsh = `ssh-rsa ${wireKey.toString('base64')} ${comment}`;

    // ── Escribir archivos ─────────────────────────────────────────────────────
    fs.writeFileSync(resolvedPath, privateKeyPem, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(publicPath, publicKeyOpenSsh + '\n', { encoding: 'utf8', mode: 0o644 });

    console.log(`[SSH-KEY] Par RSA-4096 generado (módulo nativo crypto) en: ${resolvedPath}`);
    return { success: true, publicKey: publicKeyOpenSsh, path: resolvedPath };
  }

  resolvePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      console.warn('[SSH] resolvePath recibió ruta inválida:', filePath);
      return filePath;
    }
    // Paso 1: Expandir ~/ con os.homedir() (confiable en Windows y Linux)
    let normalized = filePath;
    if (normalized.startsWith('~/')) {
      normalized = path.join(os.homedir(), normalized.slice(2));
    } else if (normalized === '~') {
      normalized = os.homedir();
    }
    // Paso 2: Normalizar con path.resolve (convierte relativas a absolutas)
    return path.resolve(normalized);
  }

  async testConnection(sshConfig) {
    let client = null;
    try {
      // Build config — _resolvePrivateKey se encarga de la auto-detección
      const testConfig = {
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.username,
        privateKey: sshConfig.privateKey,
        privateKeyPath: sshConfig.privateKeyPath,
      };

      client = await this.connect(testConfig, 'test-connection', 40000);
      await this.executeCommand(client, 'echo "SSH connection test successful"');
      return { connected: true };
    } catch (error) {
      return { connected: false, error: error.message };
    } finally {
      if (client) {
        await this.disconnect(client);
      }
    }
  }

  async getServerInfo(client) {
    try {
      const [osResult, memoryResult, diskResult] = await Promise.all([
        this.executeCommand(client, 'uname -a').catch(() => ({ stdout: 'Unknown' })),
        this.executeCommand(client, 'free -h | grep Mem').catch(() => ({ stdout: 'Unknown' })),
        this.executeCommand(client, 'df -h /').catch(() => ({ stdout: 'Unknown' }))
      ]);
      
      return {
        os: osResult.stdout,
        memory: memoryResult.stdout,
        disk: diskResult.stdout
      };
    } catch (error) {
      console.warn('Failed to get server info:', error.message);
      return {
        os: 'Unknown',
        memory: 'Unknown',
        disk: 'Unknown'
      };
    }
  }

  async getServerStats(sshConfig, serverId = 'diagnostics') {
    let client = null;
    try {
      client = await this.connect(sshConfig, serverId);

      // ── Métricas instantáneas: df -BG + una sola ronda de comandos ──
      const [cpuResult, ramResult, diskResult, ramInfo, diskInfo, uptimeInfo, cpuCores] = await Promise.all([
        this.executeCommand(client, `top -bn1 | grep "Cpu(s)" | awk '{print 100 - $8"%"}'`),
        this.executeCommand(client, `free -m | awk '/Mem:/ { printf("%3.1f%%", $3/$2*100) }'`),
        this.executeCommand(client, `df -BG / | awk 'NR==2 {print $3"|"$2"|"$5}' | sed 's/G//g' | sed 's/%//g'`),
        this.executeCommand(client, `free -m | awk '/Mem:/ {print $2, $3}'`),
        this.executeCommand(client, `df -BG / | awk 'NR==2 {print $3, $2}' | sed 's/G//g'`),
        this.executeCommand(client, `uptime -p`),
        this.executeCommand(client, `nproc`)
      ]);

      const cpuPercent = parseFloat(cpuResult.stdout.trim().replace('%', '')) || 0;
      const ramPercent = parseFloat(ramResult.stdout.trim().replace('%', '')) || 0;

      // Disk: df -BG devuelve "Usado|Total|Porcentaje"
      const diskParts = diskResult.stdout.trim().split('|');
      const diskUsed = parseInt(diskParts[0]) || 0;
      const diskTotal = parseInt(diskParts[1]) || 0;
      const diskPercent = parseFloat(diskParts[2]) || 0;

      const ramParts = ramInfo.stdout.trim().split(/\s+/);
      const ramTotal = parseInt(ramParts[0]) || 0;
      const ramUsed = parseInt(ramParts[1]) || 0;

      return {
        ram: { used: ramUsed, total: ramTotal, percent: ramPercent },
        disk: { used: diskUsed, total: diskTotal, percent: diskPercent },
        cpu: { load: cpuPercent, cores: parseInt(cpuCores.stdout.trim()) || 1 },
        uptime: uptimeInfo.stdout.trim() || 'Unknown',
        raw: { cpu: cpuResult.stdout, ram: ramResult.stdout, disk: diskResult.stdout }
      };
    } catch (error) {
      console.error(`Failed to get server stats:`, error.message);
      throw new Error(`Server stats failed: ${error.message}`);
    } finally {
      if (client) {
        await this.disconnect(client);
      }
    }
  }

  parseDiskSize(size) {
    if (!size) return 0;
    const match = size.match(/^(\d+(?:\.\d+)?)([KMGTP]?)$/i);
    if (!match) return parseFloat(size) || 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers = { K: 1, M: 1024, G: 1024 * 1024, T: 1024 * 1024 * 1024, P: 1024 * 1024 * 1024 * 1024 };
    return Math.round(num * (multipliers[unit] || 1));
  }

  /**
   * 🔥 v1.14: Post-migration Elementor CSS regeneration + cache flush via WP-CLI.
   * WordPress sites with Elementor require CSS static file regeneration to avoid
   * broken UI after migration.
   *
   * NEVER throws — logs warning and returns false on any failure.
   *
   * @param {string} domain - Domain name (ej: ejemplo.com)
   * @param {string|null} oldUrl - Old site URL for search-replace (optional)
   * @param {string|null} newUrl - New site URL for search-replace (optional)
   * @param {object} sshClient - SSH2 client (connected)
   * @returns {Promise<boolean>} true if WP-CLI commands succeeded, false if skipped/errored
   */
  async fixWordPressElementor(domain, oldUrl = null, newUrl = null, sshClient) {
    const httpdocs = `/var/www/vhosts/${domain}/httpdocs`;
    const script = [
      `cd "${httpdocs}" 2>/dev/null || { echo "[ELEM-SKIP] httpdocs no encontrado"; exit 0; }`,
      'test -f wp-config.php || { echo "[ELEM-SKIP] No es WordPress"; exit 0; }',
      'wp core is-installed --allow-root 2>/dev/null || { echo "[ELEM-SKIP] WP no instalado"; exit 0; }',
      '',
      oldUrl && newUrl
        ? `wp search-replace "${oldUrl}" "${newUrl}" --skip-columns=guid --allow-root 2>&1`
        : 'echo "[ELEM] Skipping search-replace (no URLs provided)"',
      '',
      'echo "[ELEM] Regenerando CSS estático de Elementor..."',
      'wp plugin is-active elementor --allow-root 2>/dev/null && wp elementor flush_css --allow-root 2>&1 || echo "[ELEM] Elementor no activo — omitiendo flush_css"',
      '',
      'echo "[ELEM] Sincronizando librería de Elementor..."',
      'wp plugin is-active elementor --allow-root 2>/dev/null && wp elementor sync_library --allow-root 2>&1 || echo "[ELEM] Elementor no activo — omitiendo sync_library"',
      '',
      'echo "[ELEM] Flush de caché WordPress..."',
      'wp cache flush --allow-root 2>&1 || true',
      '',
      'echo "[ELEM] Limpiando transients..."',
      'wp transient delete --all --allow-root 2>&1 || true',
      '',
      'echo "[ELEM] Fix completado"',
    ].join('\n');

    try {
      const result = await this.executeCommand(sshClient, script);
      if (result.code !== 0) {
        console.warn(`[ELEM] fixWordPressElementor for ${domain} exited with code ${result.code}: ${result.stderr || result.stdout}`);
        return false;
      }
      if (result.stdout.includes('[ELEM-SKIP]') || result.stdout.includes('exit 0')) {
        console.log(`[ELEM] Skipped ${domain}: ${result.stdout.trim().split('\n').pop()}`);
        return false;
      }
      return true;
    } catch (error) {
      console.warn(`[ELEM] fixWordPressElementor failed for ${domain}: ${error.message}`);
      return false;
    }
  }
}

// Singleton instance
let instance = null;

function getSshService() {
  if (!instance) {
    instance = new SshService();
  }
  return instance;
}

module.exports = { SshService, getSshService };