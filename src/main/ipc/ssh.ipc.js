// Handlers IPC: Operaciones SSH / Servidor
// Canales: ssh:inject-key, ssh:test-connection, ssh:generate-key
//          check-ssh-status, server:check-connection, server:test-connection
//          server:diagnostics, server:tail-log, server:exec-command
//          server:maintenance, get-detailed-storage

const { getConfigManager } = require('../../services/config-manager');
const { getSshService }    = require('../../services/ssh-service');
const { getPleskCliService } = require('../../services/plesk-cli-service');
const { getAppStateManager } = require('../state/AppStateManager');

// ─── Helper: config garantizada ────────────────────────────────────────────────
// El ConfigManager es un singleton. Si ya tiene config en memoria (app corriendo),
// evitamos la llamada async a keytar + lectura de disco en cada handler.
async function getConfig() {
  const mgr = getConfigManager();
  if (!mgr.getConfig()) {
    await mgr.initialize();
  }
  return mgr.getConfig();
}

// ─── Helper: buscar config de servidor destino ─────────────────────────────────
function findDestinationServer(config, serverName) {
  const server = config.destinationServers?.find(s => s.name === serverName);
  if (!server) throw new Error(`Servidor "${serverName}" no encontrado en la configuración`);
  return server;
}

// ─── Helper: buscar config de servidor por tipo (origin/destination) ───────────
function findServerConfig(config, { serverType, serverId, accountName }) {
  if (serverType === 'origin') {
    const account = config.accounts.find(a => a.name === accountName);
    if (!account) throw new Error(`Cuenta "${accountName}" no encontrada`);
    const cloud = account.originClouds?.find(c => c.name === serverId);
    if (!cloud) throw new Error(`Nube de origen "${serverId}" no encontrada en cuenta "${accountName}"`);
    return cloud;
  }
  if (serverType === 'destination') {
    const server = config.destinationServers?.find(s => s.name === serverId);
    if (!server) throw new Error(`Servidor de destino "${serverId}" no encontrado`);
    return server;
  }
  throw new Error(`Tipo de servidor inválido: ${serverType}`);
}

// ─── Caché en memoria: almacena resultados de get-detailed-storage ───────────
// Persiste mientras la app esté abierta. Evita llamadas SSH repetitivas al
// navegar entre servidores. TTL: 60 minutos.
// Estructura: { [serverName]: { data: StorageData, debugLogs: string[], timestamp: number } }
const STORAGE_CACHE = {};
const STORAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutos

// ─── Helper: sanitizar daysRetention contra inyección de comandos ──────────────
// Solo permite enteros positivos. Si el valor no es numérico, usa 10 como defecto.
function sanitizeDays(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

// ─── Directorio de dumps de Plesk ─────────────────────────────────────────────
// Ruta fija a propósito: nunca se construye desde input del renderer.
const PLESK_DUMPS_DIR = '/var/lib/psa/dumps';

// ─── Helper: normalizar un host escrito por el usuario ────────────────────────
// Acepta "https://ejemplo.com:22", "ejemplo.com", "1.2.3.4" y devuelve el
// hostname pelado. Devuelve null si no queda nada usable.
function normalizeHost(rawHost) {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim();
  if (!trimmed) return null;

  try {
    const withProtocol = trimmed.includes('://') ? trimmed : `ssh://${trimmed}`;
    const parsed = new URL(withProtocol);
    // hostname quita el puerto y desenvuelve los corchetes de IPv6
    return parsed.hostname.replace(/^\[|\]$/g, '') || null;
  } catch {
    // Fallback: cortar el puerto a mano
    const sinPuerto = trimmed.split('/')[0].split(':')[0];
    return sinPuerto || null;
  }
}

// ─── Helper: ¿es una IPv4 literal? ────────────────────────────────────────────
function isIpv4(value) {
  const partes = value.split('.');
  if (partes.length !== 4) return false;
  return partes.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// ─────────────────────────────────────────────────────────────────────────────
function registerSshHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // ── Inyectar llave SSH ──────────────────────────────────────────────────────
  ipcMain.handle('ssh:inject-key', async (event, params) => {
    const { host, port, username, password, serverType, serverId, accountName } = params;
    const sshService = getSshService();
    let client = null;
    try {
      if (host) {
        // Modo directo: credenciales crudas desde el formulario modal
        client = await sshService.connect(
          { host, port: port || 22, username, password, forcePasswordAuth: true },
          `key-injection-form-${Date.now()}`,
          20000
        );

        let publicKeyPath = '~/.ssh/id_rsa.pub';
        try {
          const config = await getConfig();
          if (config?.sshKeys?.publicKeyPath) publicKeyPath = config.sshKeys.publicKeyPath;
        } catch { /* usar ruta por defecto */ }

        const keyName = publicKeyPath.split(/[/\\]/).pop() || publicKeyPath;
        console.log(`[SSH] Inyectando llave "${keyName}" en ${host}:${port || 22}...`);

        await sshService.injectPublicKey(client, publicKeyPath);
        await sshService.disconnect(client);
        return { success: true, host, username };
      }

      // Modo configuración: buscar credenciales en config guardada
      const config = await getConfig();
      const serverConfig = findServerConfig(config, { serverType, serverId, accountName });

      client = await sshService.connect(serverConfig.sshCredentials, `key-injection-${serverId}`);
      const publicKeyPath = config.sshKeys?.publicKeyPath || '~/.ssh/id_rsa.pub';
      await sshService.injectPublicKey(client, publicKeyPath);
      await sshService.disconnect(client);

      return { success: true, serverType, serverId, accountName };
    } catch (error) {
      // El cliente puede haber quedado abierto si injectPublicKey falla a mitad
      if (client) {
        try { await sshService.disconnect(client); } catch (_) { }
      }
      console.error('[SSH] Error al inyectar llave:', error.message);
      return { success: false, error: error.message, serverType, serverId, accountName, host };
    }
  });

  // ── Probar conexión SSH (alias de bajo nivel) ───────────────────────────────
  ipcMain.handle('ssh:test-connection', async (event, sshCredentials) => {
    try {
      const result = await getSshService().testConnection(sshCredentials);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ── Generar par de llaves ED25519 ───────────────────────────────────────────
  ipcMain.handle('ssh:generate-key', async () => {
    try {
      const result = getSshService().generateSshKey();
      // Refrescar config en memoria para que la UI detecte la nueva llave
      try { await getConfigManager().initialize(); } catch { /* no crítico */ }
      return result;
    } catch (error) {
      console.error('[SSH] Error al generar llave:', error.message);
      return { success: false, error: error.message };
    }
  });

  // ── Estado global de conexión SSH ──────────────────────────────────────────
  ipcMain.handle('check-ssh-status', async () => {
    try {
      const service = getSshService();
      let connected  = false;
      let serverId   = null;
      let serverName = null;

      if (service.clients?.size > 0) {
        const [firstId] = service.clients.keys();
        connected  = true;
        serverId   = firstId;
        // CORRECCIÓN: serverName estaba siempre null — lo derivamos del taskId
        serverName = firstId?.replace(/^(storage-detail-|diagnostics-|tail-|exec-|maintenance-)/, '') ?? null;
      }

      getAppStateManager().update('sshConnection', {
        isConnected: connected,
        serverId,
        serverName,
        lastChecked: Date.now(),
      });

      return { connected, serverId, serverName };
    } catch {
      return { connected: false, serverId: null, serverName: null };
    }
  });

  // ── Verificar conexión de servidor específico ───────────────────────────────
  ipcMain.handle('server:check-connection', async (event, { serverId }) => {
    try {
      const service = getSshService();
      const connected = service.clients?.has(serverId) ?? false;
      return { connected, serverId, serverName: serverId };
    } catch {
      return { connected: false, serverId: serverId || '', serverName: '' };
    }
  });

  // ── Probar conexión de servidor (alias con naming consistente) ──────────────
  ipcMain.handle('server:test-connection', async (event, sshCredentials) => {
    try {
      const result = await getSshService().testConnection(sshCredentials);
      return { success: true, connected: result.connected, error: result.error };
    } catch (error) {
      return { success: false, connected: false, error: error.message };
    }
  });

  // ── Diagnóstico de servidor ─────────────────────────────────────────────────
  ipcMain.handle('server:diagnostics', async (event, { serverType, serverId, accountName }) => {
    if (isOperationRunning.value) {
      return { success: false, error: '[COLA] Operación en curso. Espere a que finalice antes de ejecutar diagnóstico.' };
    }
    try {
      const config       = await getConfig();
      const serverConfig = findServerConfig(config, { serverType, serverId, accountName });
      const stats        = await getSshService().getServerStats(serverConfig.sshCredentials, `diagnostics-${serverId}`);
      return { success: true, stats };
    } catch (error) {
      console.error('[SSH] Diagnóstico fallido:', error.message);
      return { success: false, error: error.message };
    }
  });

  // ── Leer últimas 50 líneas del log de Plesk ────────────────────────────────
  ipcMain.handle('server:tail-log', async (event, { serverName }) => {
    let client = null;
    try {
      const config       = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService   = getSshService();

      client = await sshService.connect(serverConfig.sshCredentials, `tail-${serverName}`);
      const result = await sshService.executeCommand(client, 'tail -n 50 /var/log/plesk/panel.log');
      return { success: true, log: result.stdout || '' };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      if (client) try { await getSshService().disconnect(client); } catch (_) { }
    }
  });

  // ── Ejecutar comando SSH arbitrario ────────────────────────────────────────
  // ⚠️  USO INTERNO EXCLUSIVO: Este canal ejecuta comandos sin restricción en el
  //     servidor de destino. NUNCA exponer directamente a input del usuario final.
  ipcMain.handle('server:exec-command', async (event, { serverName, command }) => {
    let client = null;
    try {
      const config       = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService   = getSshService();

      client = await sshService.connect(serverConfig.sshCredentials, `exec-${serverName}`);
      const result = await sshService.executeCommand(client, command);
      return { success: true, stdout: result.stdout || '', stderr: result.stderr || '' };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      if (client) try { await getSshService().disconnect(client); } catch (_) { }
    }
  });

  // ── Mantenimiento de servidor (fire-and-forget vía ipcMain.on) ─────────────
  ipcMain.on('server:maintenance', async (event, { serverType, serverId, accountName, action }) => {
    const sshService      = getSshService();
    const pleskCliService = getPleskCliService();
    let client = null;
    try {
      const config       = await getConfig();
      const serverConfig = findServerConfig(config, { serverType, serverId, accountName });

      client = await sshService.connect(serverConfig.sshCredentials, `maintenance-${serverId}`);
      try {
        switch (action) {
          case 'clear-cache': await pleskCliService.clearCache(client);    break;
          case 'restart':     await pleskCliService.rebootServer(client);  break;
          case 'shutdown':    await pleskCliService.shutdownServer(client); break;
          default:            throw new Error(`Acción de mantenimiento desconocida: ${action}`);
        }
      } finally {
        await sshService.disconnect(client);
        client = null;
      }

      mainWindow.webContents.send('server:maintenance-completed', { success: true, serverType, serverId, accountName, action });
    } catch (error) {
      if (client) try { await sshService.disconnect(client); } catch (_) { }
      console.error('[SSH] Error en mantenimiento:', error.message);
      mainWindow.webContents.send('server:maintenance-completed', { success: false, error: error.message, serverType, serverId, accountName, action });
    }
  });

  // ── Radiografía de almacenamiento + estimación de purga ───────────────────
  ipcMain.handle('get-detailed-storage', async (event, { serverName, daysRetention = 10, forceRefresh = false }) => {
    let client = null;
    const debugLogs = [];
    const log = (msg) => {
      const hora = new Date().toISOString().split('T')[1].slice(0, 8);
      debugLogs.push(`[${hora}] ${msg}`);
    };

    // daysRetention viene del renderer — sanitizar antes de interpolar en el comando SSH
    const dias = sanitizeDays(daysRetention);

    // ── Hit de caché: devuelve resultado guardado si es reciente y no se pidió forzar
    if (!forceRefresh) {
      const cached = STORAGE_CACHE[serverName];
      if (cached && (Date.now() - cached.timestamp) < STORAGE_CACHE_TTL_MS) {
        const edadMin = ((Date.now() - cached.timestamp) / 60000).toFixed(1);
        console.log(`[STORAGE-CACHE] HIT para "${serverName}" (edad: ${edadMin} min). Retornando datos cacheados.`);
        return {
          success: true,
          data: cached.data,
          debugLogs: [`[CACHE] Datos de "${serverName}" servidos desde caché (${edadMin} min de antigüedad)`],
          fromCache: true,
        };
      }
      if (STORAGE_CACHE[serverName]) {
        console.log(`[STORAGE-CACHE] EXPIRED para "${serverName}". Consultando servidor...`);
      }
    } else {
      console.log(`[STORAGE-CACHE] FORCE REFRESH para "${serverName}". Invalidando caché...`);
      delete STORAGE_CACHE[serverName];
    }

    try {
      log(`Iniciando diagnóstico detallado para: ${serverName}`);
      const config       = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService   = getSshService();

      log(`Conectando por SSH a ${serverConfig.sshCredentials.host || 'Host Desconocido'}...`);
      client = await sshService.connect(serverConfig.sshCredentials, `storage-detail-${serverName}`);
      log('Conexión SSH establecida con éxito.');

      // Timeout helper: si el comando excede ms, resuelve con sentinel en lugar de rechazar
      const conTimeout = (promise, ms, nombre) =>
        Promise.race([
          promise.then(res => {
            log(`Comando [${nombre}] OK. Output: ${(res.stdout || '').length} bytes`);
            return res;
          }),
          new Promise(r => setTimeout(() => {
            log(`⚠️ TIMEOUT (>${ms}ms) en comando [${nombre}]`);
            r({ stdout: 'TIMEOUT_ERROR' });
          }, ms)),
        ]);

      // ─── Comandos SSH ───────────────────────────────────────────────────────
      //
      // cmdBackups: du -s sobre /var/lib/psa/dumps/ es seguro a nivel raíz.
      //   Plesk guarda subdirectorios con millones de archivos temporales, pero
      //   du -s opera de forma recursiva eficiente usando getdents64 del kernel.
      const cmdBackups = "du -s /var/lib/psa/dumps/ 2>/dev/null | awk '{print $1}' || echo '0'";

      // cmdLogs: mismo patrón, directorio /var/log/
      const cmdLogs = "du -s /var/log/ 2>/dev/null | awk '{print $1}' || echo 'ERROR'";

      // cmdVhosts: consulta MySQL en vez de du recursivo sobre vhosts (instantáneo).
      //   $() es sintaxis Bash pura — sobrevive el transporte SSH como string literal.
      //   Los backticks JS que evaluaría Node antes del envío quedan completamente evitados.
      const cmdVhosts = 'mysql -uadmin -p$(cat /etc/psa/.psa.shadow 2>/dev/null) psa -N -e "SELECT SUM(real_size) FROM domains WHERE webspace_id = 0;" 2>/dev/null || echo \'ERROR\'';

      // cmdEstimation: filtra por extensiones reales de Plesk Obsidian (.tzst, .tar*, .zip)
      //   -maxdepth 2 evita recursión profunda en subdirectorios temporales de Plesk.
      //   -type f garantiza que -mtime opere sobre la fecha real del archivo, no del directorio.
      //   `dias` ya fue sanitizado a entero positivo — sin riesgo de inyección.
      const cmdEstimation = `find /var/lib/psa/dumps/ -maxdepth 2 -type f \\( -name "backup_*.tzst" -o -name "backup_*.tar*" -o -name "backup_*.zip" \\) -mtime +${dias} -exec du -ch {} + 2>/dev/null | grep total$ | awk '{print $1}' || echo 'EMPTY'`;

      log('Disparando Promise.all para los 4 comandos de almacenamiento...');
      const [backups, vhosts, logs, estimation] = await Promise.all([
        conTimeout(sshService.executeCommand(client, cmdBackups),    6000,  'Backups'),
        conTimeout(sshService.executeCommand(client, cmdVhosts),     6000,  'Vhosts (MySQL)'),
        conTimeout(sshService.executeCommand(client, cmdLogs),       6000,  'Logs'),
        conTimeout(sshService.executeCommand(client, cmdEstimation), 12000, 'Estimación'),
      ]);

      log(`RAW Backups: "${(backups.stdout    || '').trim()}"`);
      log(`RAW Vhosts:  "${(vhosts.stdout     || '').trim()}"`);
      log(`RAW Logs:    "${(logs.stdout       || '').trim()}"`);
      log(`RAW Estim.:  "${(estimation.stdout || '').trim()}"`);

      // ─── Parsers ────────────────────────────────────────────────────────────

      // KB numérico (du -s devuelve bloques de 1K en Linux)
      const kb2gb = (raw, etiqueta) => {
        const clean = (raw || '').trim();
        if (!clean || clean === 'TIMEOUT_ERROR' || clean === 'ERROR' || clean === '0') {
          log(`[${etiqueta}] Valor inválido o cero → N/D`);
          return 'N/D';
        }
        const val = parseInt(clean, 10);
        if (!val || val <= 0) return 'N/D';
        const resultado = `${(val / 1024 / 1024).toFixed(2)} GB`;
        log(`[${etiqueta}] ${val} KB → ${resultado}`);
        return resultado;
      };

      // Bytes numéricos (MySQL devuelve real_size en bytes)
      const bytes2gb = (raw, etiqueta) => {
        const clean = (raw || '').trim();
        if (!clean || clean === 'TIMEOUT_ERROR' || clean === 'ERROR' || clean === '0') {
          log(`[${etiqueta}] Valor inválido o cero → N/D`);
          return 'N/D';
        }
        const val = parseInt(clean, 10);
        if (!val || val <= 0) return 'N/D';
        const resultado = `${(val / 1024 / 1024 / 1024).toFixed(2)} GB`;
        log(`[${etiqueta}] ${val} B → ${resultado}`);
        return resultado;
      };

      // Human-readable multilínea (du -ch puede dividir en múltiples lotes → múltiples "total")
      // Suma todos los totales parciales en Node y devuelve una única cifra consolidada.
      const parseEstimacion = (raw, etiqueta) => {
        const clean = (raw || '').trim();
        if (!clean || clean === 'TIMEOUT_ERROR' || clean === 'EMPTY' || clean === '0') {
          log(`[${etiqueta}] Sin datos para purgar → 0 GB`);
          return '0 GB';
        }

        const lineas = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        let totalBytes = 0;

        for (const linea of lineas) {
          // Captura: número decimal + sufijo Linux (G/M/K/T/B)
          const m = linea.match(/^([\d.]+)\s*([GMKT]?)$/i);
          if (m) {
            const valor = parseFloat(m[1]) || 0;
            const unidad = (m[2] || '').toUpperCase();
            if      (unidad === 'T') totalBytes += valor * 1024 ** 4;
            else if (unidad === 'G') totalBytes += valor * 1024 ** 3;
            else if (unidad === 'M') totalBytes += valor * 1024 ** 2;
            else if (unidad === 'K') totalBytes += valor * 1024;
            else                     totalBytes += valor;
          }
        }

        if (totalBytes === 0) {
          log(`[${etiqueta}] Suma = 0 → 0 GB`);
          return '0 GB';
        }

        let resultado;
        if      (totalBytes >= 1024 ** 3) resultado = `${(totalBytes / 1024 ** 3).toFixed(2)} GB`;
        else if (totalBytes >= 1024 ** 2) resultado = `${(totalBytes / 1024 ** 2).toFixed(2)} MB`;
        else                              resultado = `${(totalBytes / 1024).toFixed(2)} KB`;

        log(`[${etiqueta}] ${lineas.length} líneas sumadas → ${resultado}`);
        return resultado;
      };

      const datos = {
        backups:          kb2gb(backups.stdout,         'Backups'),
        vhosts:           bytes2gb(vhosts.stdout,       'Vhosts'),
        logs:             kb2gb(logs.stdout,            'Logs'),
        estimatedSavings: parseEstimacion(estimation.stdout, 'Estimación'),
      };

      // ── Guardar en caché antes de retornar ──
      STORAGE_CACHE[serverName] = { data: datos, debugLogs: [...debugLogs], timestamp: Date.now() };
      log(`Resultado guardado en caché para "${serverName}" (TTL: 60 min)`);

      // ── Propagar al AppStateManager para acceso global ──
      try {
        getAppStateManager().update('storageMetrics', { [serverName]: { data: datos, timestamp: Date.now() } });
      } catch (_) { /* no crítico */ }

      return { success: true, data: datos, debugLogs, fromCache: false };

    } catch (error) {
      log(`❌ ERROR CRÍTICO: ${error.message}`);
      console.error('[SSH] get-detailed-storage falló:', error.message);
      return {
        success: false,
        error: error.message,
        debugLogs,
        data: { backups: 'N/D', vhosts: 'N/D', logs: 'N/D', estimatedSavings: '—' },
      };
    } finally {
      // Persistir log de debug en el servidor destino (no crítico)
      if (client) {
        try {
          const logContent = debugLogs.join('\n').replace(/"/g, '\\"');
          await getSshService().executeCommand(client, `printf '%s\n' "${logContent}" > /tmp/kraken_cli_debug.log`);
        } catch (_) { }
        try { await getSshService().disconnect(client); } catch (_) { }
      }
    }
  });

  // ── Resolver un host a IP ───────────────────────────────────────────────────
  // Lo usa ServerFormModal para reemplazar el dominio por su IP al dar de alta
  // un servidor. El canal estaba en la whitelist del preload pero nunca tuvo
  // handler: la UI recibía "No handler registered".
  ipcMain.handle('server:resolve-ip', async (event, { host } = {}) => {
    const hostname = normalizeHost(host);
    if (!hostname) {
      return { success: false, error: 'Host vacío o inválido' };
    }

    // Si ya es una IP, no hay nada que resolver
    if (isIpv4(hostname)) {
      return { success: true, ip: hostname, alreadyIp: true };
    }

    try {
      const dns = require('dns');
      const ips = await dns.promises.resolve4(hostname);
      if (!ips || ips.length === 0) {
        return { success: false, error: `"${hostname}" no tiene registros A` };
      }
      return { success: true, ip: ips[0], alreadyIp: false };
    } catch (error) {
      return { success: false, error: `No se pudo resolver "${hostname}": ${error.message}` };
    }
  });

  // ── Purgar backups viejos de Plesk ──────────────────────────────────────────
  // Elimina los archivos de /var/lib/psa/dumps más viejos que `daysRetention`.
  // El canal estaba en la whitelist del preload pero nunca tuvo handler.
  //
  // OPERACIÓN DESTRUCTIVA. La confirmación vive en la UI (DrawerDangerZone pide
  // tipear el nombre del servidor). Acá se protege por construcción:
  //   - La ruta es una constante, jamás viene del renderer.
  //   - daysRetention pasa por sanitizeDays (solo enteros positivos).
  //   - `find` se limita a esa ruta, sin seguir symlinks (-P por defecto).
  //   - `dryRun` permite medir sin borrar.
  ipcMain.handle('purge-plesk-backups', async (event, { serverName, daysRetention = 10, dryRun = false } = {}) => {
    let client = null;
    const dias = sanitizeDays(daysRetention);

    try {
      const config = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService = getSshService();

      client = await sshService.connect(serverConfig.sshCredentials, `purge-backups-${serverName}`);

      // El directorio tiene que existir: si Plesk no está donde esperamos,
      // se aborta en vez de correr un find sobre una ruta inexistente.
      const check = await sshService.executeCommand(
        client,
        `test -d ${PLESK_DUMPS_DIR} && echo OK || echo MISSING`,
        { timeoutMs: 30000 }
      );
      if ((check.stdout || '').trim() !== 'OK') {
        return { success: false, error: `No existe el directorio de dumps ${PLESK_DUMPS_DIR} en "${serverName}"` };
      }

      // Medir primero: cantidad de archivos y bytes que se van a liberar.
      const medir = `find ${PLESK_DUMPS_DIR} -mindepth 1 -type f -mtime +${dias} -printf '%s\\n' 2>/dev/null | awk '{n++; s+=$1} END {printf "%d %d", n+0, s+0}'`;
      const medicion = await sshService.executeCommand(client, medir, { timeoutMs: 300000 });
      const [countRaw, bytesRaw] = (medicion.stdout || '0 0').trim().split(/\s+/);
      const archivos = parseInt(countRaw, 10) || 0;
      const bytes = parseInt(bytesRaw, 10) || 0;

      if (archivos === 0) {
        return {
          success: true,
          dryRun,
          deletedFiles: 0,
          freedBytes: 0,
          message: `No hay backups con más de ${dias} días en "${serverName}"`,
        };
      }

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          deletedFiles: 0,
          candidateFiles: archivos,
          freedBytes: 0,
          candidateBytes: bytes,
          message: `${archivos} archivos (${formatBytes(bytes)}) superan los ${dias} días`,
        };
      }

      const borrar = `find ${PLESK_DUMPS_DIR} -mindepth 1 -type f -mtime +${dias} -delete 2>/dev/null; echo DONE`;
      const resultado = await sshService.executeCommand(client, borrar, { timeoutMs: 900000 });
      if (!(resultado.stdout || '').includes('DONE')) {
        return { success: false, error: `La purga no terminó correctamente: ${resultado.stderr || 'sin salida'}` };
      }

      // Los datos de almacenamiento cacheados quedaron obsoletos.
      delete STORAGE_CACHE[serverName];

      return {
        success: true,
        dryRun: false,
        deletedFiles: archivos,
        freedBytes: bytes,
        message: `${archivos} archivos eliminados, ${formatBytes(bytes)} liberados en "${serverName}"`,
      };
    } catch (error) {
      console.error('[SSH] purge-plesk-backups falló:', error.message);
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try { await getSshService().disconnect(client); } catch (_) { }
      }
    }
  });
}

// ─── Helper: bytes a unidad legible ───────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const unidades = ['KB', 'MB', 'GB', 'TB'];
  let valor = bytes / 1024;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  return `${valor.toFixed(1)} ${unidades[i]}`;
}

module.exports = { registerSshHandlers };
