'use strict';

/**
 * @file cms.ipc.js
 * @description Handlers IPC para el CMS Reconstructor.
 *
 * Canales invoke:
 *   cms:audit-server       → Audita todos los dominios WP del servidor
 *   cms:start-batch        → Inicia reconstrucción de dominios seleccionados
 *   cms:flush-permalinks   → Flushea permalinks WP en lista de dominios (wp rewrite flush --hard)
 *   cms:abort              → Kill switch del batch/audit activo
 *   cms:get-state          → Devuelve estado persistido
 *
 * Canales send (main → renderer):
 *   cms:audit-progress → Progreso del audit por dominio
 *   cms:progress       → Progreso del batch de reconstrucción
 */

const { getConfigManager }   = require('../../services/config-manager');
const { getAppStateManager } = require('../state/AppStateManager');
const { runCmsBatch }        = require('../../services/sourcesync/cmsOrchestrator');
const { getSshService }      = require('../../services/ssh-service');
const { obtenerVersionesWP, obtenerVersionesPHP } = require('../../services/version-discovery-service');

// ─── Límite de concurrencia para el audit ─────────────────────────────────────
const AUDIT_CONCURRENCY = 5;

// ─── Estado del proceso activo ────────────────────────────────────────────────
let _abortController = null;
let _processRunning  = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConfig() {
  const mgr = getConfigManager();
  if (!mgr.getConfig()) await mgr.initialize();
  return mgr.getConfig();
}

function findServer(config, serverName) {
  const s = config.destinationServers?.find(s => s.name === serverName);
  if (!s) throw new Error(`Servidor "${serverName}" no encontrado en la configuración`);
  return s;
}

// Ejecuta un comando SSH con allowFail opcional
async function run(ssh, client, cmd, opts = {}) {
  const result = await ssh.executeCommand(client, cmd, { timeout: opts.timeout || 30000 });
  if (!opts.allowFail && result.code !== 0 && result.code !== null) {
    throw new Error((result.stderr || result.stdout || `exit ${result.code}`).slice(0, 300));
  }
  return result;
}

// Semáforo simple para concurrencia controlada
function createSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < max) { active++; return; }
      return new Promise(res => queue.push(res));
    },
    release() {
      active--;
      if (queue.length > 0) { active++; queue.shift()(); }
    },
  };
}

// ─── Registro de handlers ─────────────────────────────────────────────────────

function registerCmsHandlers(ipcMain, mainWindow) {

  const emit = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  // ── AUDIT: escanear todos los dominios WP del servidor ────────────────────
  ipcMain.handle('cms:audit-server', async (_event, { serverName }) => {
    if (_processRunning) return { success: false, error: 'Ya hay un proceso activo. Aborta el anterior primero.' };

    let config, server;
    try {
      config = await getConfig();
      server = findServer(config, serverName);
    } catch (err) {
      return { success: false, error: err.message };
    }

    _abortController = new AbortController();
    _processRunning  = true;

    const ssh = getSshService();
    let masterClient = null;

    try {
      // 1. Obtener lista de dominios via Plesk DB
      emit('cms:audit-progress', { type: 'audit-start', msg: `Conectando a "${serverName}"...` });
      masterClient = await ssh.connect(server.sshCredentials, `cms-audit-master-${Date.now()}`);

      const dbResult = await run(ssh, masterClient,
        `plesk db -sNe "SELECT d.name, h.php_handler_id FROM domains d LEFT JOIN hosting h ON d.id=h.dom_id WHERE d.status=0 ORDER BY d.name;"`,
        { timeout: 30000 }
      );

      const domains = [];
      const phpHandlerMap = {};

      const lines = dbResult.stdout.split('\n').map(d => d.trim()).filter(Boolean);
      for (const line of lines) {
        const [domainName, rawHandler] = line.split(/\s+/);
        if (domainName) {
          domains.push(domainName);
          if (rawHandler && rawHandler !== 'NULL') {
            // Extraer la versión de plesk-php82-fpm o fastcgi-74 -> 8.2 / 7.4
            const match = rawHandler.match(/\d{2,}/);
            if (match) {
              const nums = match[0];
              phpHandlerMap[domainName] = `${nums[0]}.${nums.slice(1)}`;
            } else {
              phpHandlerMap[domainName] = rawHandler;
            }
          } else {
            phpHandlerMap[domainName] = 'Desconocido';
          }
        }
      }
      if (domains.length === 0) {
        emit('cms:audit-progress', { type: 'audit-done', msg: 'No se encontraron dominios activos.', results: [] });
        return { success: true, domains: [] };
      }

      emit('cms:audit-progress', {
        type: 'audit-domains-found',
        msg: `${domains.length} dominios encontrados. Iniciando auditoría WP...`,
        total: domains.length,
      });

      // 2. Auditar cada dominio con concurrencia controlada
      const sem = createSemaphore(AUDIT_CONCURRENCY);
      const results = [];
      let processed = 0;

      await Promise.all(domains.map(async (domain) => {
        if (_abortController.signal.aborted) return;

        await sem.acquire();
        try {
          let client = null;
          try {
            client = await ssh.connect(server.sshCredentials, `cms-audit-${domain}-${Date.now()}`);

            // Detectar docroot
            const docrootRes = await run(ssh, client,
              `plesk bin site --info ${domain} 2>/dev/null | grep -i "Document root" | head -1 | awk '{print $NF}'`,
              { allowFail: true }
            );
            const docroot = docrootRes.stdout.trim() || `/var/www/vhosts/${domain}/httpdocs`;

            // Detectar usuario del sistema
            const userRes = await run(ssh, client,
              `stat -c '%U' ${docroot} 2>/dev/null || echo "root"`,
              { allowFail: true }
            );
            const sysUser = userRes.stdout.trim() || 'root';

            const wp = (cmd) => `cd ${docroot} && su -s /bin/bash ${sysUser} -c ${JSON.stringify(cmd)} 2>/dev/null`;

            // ¿Es WordPress?
            const isWpRes = await run(ssh, client, wp('wp core is-installed 2>&1'), { allowFail: true });
            const isWp = isWpRes.code === 0;

            if (!isWp) {
              processed++;
              emit('cms:audit-progress', { type: 'domain-audited', domain, processed, total: domains.length, isWp: false });
              results.push({ domain, isWp: false });
              return;
            }

            // Versión WP
            const versionRes = await run(ssh, client, wp('wp core version'), { allowFail: true, timeout: 15000 });
            const wpVersion  = versionRes.stdout.trim() || '?';

            // Checksums
            const checksumRes = await run(ssh, client, wp('wp core verify-checksums 2>&1'), { allowFail: true, timeout: 30000 });
            const checksumOk  = checksumRes.code === 0;

            // Plugins desactualizados
            const pluginRes  = await run(ssh, client,
              wp("wp plugin list --update=available --format=count 2>&1"),
              { allowFail: true, timeout: 30000 }
            );
            const pluginCount = parseInt(pluginRes.stdout.trim(), 10) || 0;

            // Handler PHP actual (Mapeo Bulk)
            const phpHandler = phpHandlerMap[domain] || 'Desconocido';

            const entry = { domain, isWp: true, wpVersion, checksumOk, pluginCount, phpHandler, docroot, sysUser };
            results.push(entry);
            processed++;

            emit('cms:audit-progress', {
              type: 'domain-audited',
              domain, processed, total: domains.length,
              isWp: true, wpVersion, checksumOk, pluginCount, phpHandler,
            });

          } catch (err) {
            results.push({ domain, isWp: null, error: err.message });
            processed++;
            emit('cms:audit-progress', {
              type: 'domain-audited',
              domain, processed, total: domains.length, error: err.message,
            });
          } finally {
            if (client) { try { await ssh.disconnect(client); } catch (_) {} }
          }
        } finally {
          sem.release();
        }
      }));

      emit('cms:audit-progress', {
        type: 'audit-done',
        msg: `Auditoría completa: ${results.filter(r => r.isWp).length} sitios WP de ${domains.length} dominios.`,
        results,
      });

      return { success: true, results };

    } catch (err) {
      emit('cms:audit-progress', { type: 'audit-error', msg: err.message });
      return { success: false, error: err.message };
    } finally {
      if (masterClient) { try { await ssh.disconnect(masterClient); } catch (_) {} }
      _processRunning  = false;
      _abortController = null;
    }
  });

  // ── START BATCH: reconstruir dominios seleccionados ───────────────────────
  ipcMain.handle('cms:start-batch', async (_event, {
    serverName, domains, localZipPath, targetPhpVersion, mode, dryRun, phpSwitch, excludedBlacklistSlugs,
  }) => {
    console.log(`\n[CMS IPC] ==========================================`);
    console.log(`[CMS IPC] RECIBIDO cms:start-batch`);
    console.log(`[CMS IPC] Servidor: ${serverName}, Dominios: ${domains.length}, Modo: ${mode}, DryRun: ${dryRun}`);
    if (excludedBlacklistSlugs?.length) {
      console.log(`[CMS IPC] Plugins excluidos de la lista negra: ${excludedBlacklistSlugs.join(', ')}`);
    }
    console.log(`[CMS IPC] ==========================================\n`);

    if (_processRunning) {
      console.warn(`[CMS IPC] Rechazado: Ya hay un proceso activo.`);
      return { success: false, error: 'Ya hay un proceso activo. Aborta el anterior primero.' };
    }

    let config, server;
    try {
      config = await getConfig();
      server = findServer(config, serverName);
    } catch (err) {
      return { success: false, error: err.message };
    }

    _abortController = new AbortController();
    _processRunning  = true;

    const state = getAppStateManager();
    state.update('cms', {
      isRunning: true, dryRun: !!dryRun, serverName,
      totalDomains: domains.length, processed: 0, succeeded: 0, failed: 0,
      history: [], startedAt: Date.now(), aborted: false,
    });

    emit('cms:progress', {
      type: 'batch-start',
      msg: `Iniciando batch — ${domains.length} dominios (${mode}${dryRun ? ' [DRY RUN]' : ''})`,
      total: domains.length,
    });

    // Fire-and-forget
    (async () => {
      try {
        const result = await runCmsBatch({
          domains, serverName,
          sshCredentials: server.sshCredentials,
          localZipPath: localZipPath || null,
          targetPhpVersion: targetPhpVersion || 'Mantener actual',
          mode: mode || 'full',
          dryRun: !!dryRun,
          phpSwitch: phpSwitch !== false,
          excludedBlacklistSlugs: Array.isArray(excludedBlacklistSlugs) ? excludedBlacklistSlugs : [],
          signal: _abortController.signal,
          onProgress: (event) => {
            emit('cms:progress', event);
            const current = state.getState('cms') || {};
            if (event.type === 'domain-done' || event.type === 'domain-error') {
              const history = [...(current.history || []), {
                domain: event.domain,
                status: event.success ? 'success' : 'error',
                error: event.error, duration: event.duration,
              }];
              state.update('cms', {
                processed: history.length,
                succeeded: history.filter(h => h.status === 'success').length,
                failed:    history.filter(h => h.status === 'error').length,
                history,
              });
            }
          },
        });

        state.update('cms', {
          isRunning: false, finishedAt: Date.now(),
          processed: result.processed, succeeded: result.succeeded,
          failed: result.failed, history: result.history,
        });

      } catch (err) {
        console.error('[CMS:BATCH] Error no capturado:', err.message);
        emit('cms:progress', { type: 'domain-error', msg: `Error crítico: ${err.message}`, level: 'error' });
      } finally {
        _processRunning  = false;
        _abortController = null;
      }
    })();

    return { success: true, message: `Batch iniciado con ${domains.length} dominios.` };
  });

  // ── FLUSH PERMALINKS: wp rewrite flush --hard en lista de dominios ────────
  ipcMain.handle('cms:flush-permalinks', async (_event, { serverName, domains }) => {
    if (_processRunning) return { success: false, error: 'Ya hay un proceso activo. Aborta el anterior primero.' };
    if (!domains?.length) return { success: false, error: 'Lista de dominios vacía.' };

    let config, server;
    try {
      config = await getConfig();
      server = findServer(config, serverName);
    } catch (err) {
      return { success: false, error: err.message };
    }

    _abortController = new AbortController();
    _processRunning  = true;

    const ssh = getSshService();
    const CONCURRENCY = 3;
    const sem = createSemaphore(CONCURRENCY);

    emit('cms:progress', {
      type: 'batch-start',
      msg: `Flusheando permalinks — ${domains.length} dominios`,
      total: domains.length,
    });

    // Fire-and-forget para no bloquear el IPC
    (async () => {
      try {
        await Promise.all(domains.map(async (domain) => {
          if (_abortController.signal.aborted) return;
          await sem.acquire();

          emit('cms:progress', { type: 'domain-start', domain });
          const t0 = Date.now();
          let client = null;

          try {
            client = await ssh.connect(server.sshCredentials, `flush-${domain}-${Date.now()}`);

            // Detectar docroot real (fallback estándar de Plesk)
            const docrootRes = await run(ssh, client,
              `plesk bin site --info ${domain} 2>/dev/null | grep -i "Document root" | head -1 | awk '{print $NF}'`,
              { allowFail: true }
            );
            const docroot = docrootRes.stdout.trim() || `/var/www/vhosts/${domain}/httpdocs`;

            // Detectar usuario del sistema
            const userRes = await run(ssh, client,
              `stat -c '%U' ${docroot} 2>/dev/null || echo "root"`,
              { allowFail: true }
            );
            const sysUser = userRes.stdout.trim() || 'root';

            emit('cms:progress', { type: 'domain-step', domain, msg: `docroot: ${docroot} (usuario: ${sysUser})`, level: 'info' });

            const wp = (cmd) => `cd ${docroot} && su -s /bin/bash ${sysUser} -c ${JSON.stringify(cmd)} 2>/dev/null`;

            // Verificar que es WordPress antes de continuar
            const isWpRes = await run(ssh, client, wp('wp core is-installed 2>&1'), { allowFail: true });
            if (isWpRes.code !== 0) {
              emit('cms:progress', { type: 'domain-step', domain, msg: `No es WordPress o WP-CLI no disponible — saltando`, level: 'warn' });
              emit('cms:progress', { type: 'domain-done', domain, success: true, duration: Date.now() - t0 });
              return;
            }

            // ── STEP 1: Leer permalink_structure de la BD; si está vacía, forzar /%postname%/
            const structRes = await run(ssh, client,
              wp('wp option get permalink_structure 2>&1'),
              { allowFail: true, timeout: 20000 }
            );
            const currentStructure = (structRes.stdout || '').trim();
            let finalStructure = currentStructure;

            if (!currentStructure || currentStructure === '0' || currentStructure.includes('Error')) {
              // Estructura vacía → WordPress usa links planos (?p=123), WP-CLI escribiría reglas vacías
              finalStructure = '/%postname%/';
              const setRes = await run(ssh, client,
                wp(`wp option update permalink_structure '${finalStructure}' 2>&1`),
                { allowFail: true, timeout: 20000 }
              );
              emit('cms:progress', { type: 'domain-step', domain,
                msg: `permalink_structure vacía → forzando a ${finalStructure} (${setRes.code === 0 ? 'ok' : 'warn'})`,
                level: setRes.code === 0 ? 'info' : 'warn',
              });
            } else {
              emit('cms:progress', { type: 'domain-step', domain,
                msg: `permalink_structure actual: ${currentStructure}`,
                level: 'info',
              });
            }

            // ── STEP 2: Escribir .htaccess directamente como root (sin depender de permisos del sysUser)
            //    Esto evita el caso donde WP-CLI silenciosamente falla por permisos del archivo

            const writeHtaccessCmd = `cat > "${docroot}/.htaccess" << 'HTEOF'\n# BEGIN WordPress\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteBase /\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n</IfModule>\n# END WordPress\nHTEOF`;
            const htaccessRes = await run(ssh, client, writeHtaccessCmd, { allowFail: true, timeout: 15000 });
            emit('cms:progress', { type: 'domain-step', domain,
              msg: `.htaccess escrito directamente (root) → ${htaccessRes.code === 0 ? 'ok' : htaccessRes.stderr?.slice(0, 80) || 'warn'}`,
              level: htaccessRes.code === 0 ? 'info' : 'warn',
            });

            // ── STEP 3: Corregir ownership del .htaccess para que WP pueda escribirlo en el futuro
            await run(ssh, client,
              `chown ${sysUser}:psacln "${docroot}/.htaccess" 2>/dev/null || chown ${sysUser}:${sysUser} "${docroot}/.htaccess" 2>/dev/null || true`,
              { allowFail: true }
            );
            await run(ssh, client, `chmod 644 "${docroot}/.htaccess"`, { allowFail: true });
            emit('cms:progress', { type: 'domain-step', domain, msg: `ownership .htaccess → ${sysUser}:psacln 644`, level: 'info' });


            emit('cms:progress', { type: 'domain-done', domain, success: true, duration: Date.now() - t0 });

          } catch (err) {
            emit('cms:progress', { type: 'domain-error', domain, msg: err.message, level: 'error', duration: Date.now() - t0 });
          } finally {
            if (client) { try { await ssh.disconnect(client); } catch (_) {} }
            sem.release();
          }
        }));

        emit('cms:progress', {
          type: 'batch-done',
          msg: `Flush de permalinks completado — ${domains.length} dominios procesados.`,
        });

      } catch (err) {
        emit('cms:progress', { type: 'batch-done', msg: `Error: ${err.message}`, level: 'error' });
      } finally {
        _processRunning  = false;
        _abortController = null;
      }
    })();

    return { success: true, message: `Flush iniciado para ${domains.length} dominios.` };
  });

  // ── ABORT ─────────────────────────────────────────────────────────────────
  ipcMain.handle('cms:abort', async () => {
    if (!_processRunning || !_abortController) return { success: false, error: 'No hay proceso activo.' };
    
    console.log(`[CMS IPC] Abortando proceso activo...`);
    _abortController.abort();
    
    // Forzar el cierre de TODAS las conexiones SSH para matar procesos colgados inmediatamente
    try {
      const ssh = getSshService();
      await ssh.disconnectAll();
      console.log(`[CMS IPC] Todas las conexiones SSH han sido terminadas forzosamente.`);
    } catch (err) {
      console.error(`[CMS IPC] Error al forzar cierre de SSH:`, err);
    }

    emit('cms:progress', { type: 'batch-done', msg: '⛔ Proceso abortado por el usuario.', level: 'warn' });
    const state = getAppStateManager();
    state.update('cms', { isRunning: false, aborted: true });
    
    // Forzamos el flag por si el finally tarda en ejecutar
    _processRunning = false;
    
    return { success: true };
  });

  // ── GET STATE ─────────────────────────────────────────────────────────────
  ipcMain.handle('cms:get-state', async () => {
    const state = getAppStateManager();
    return { success: true, state: state.getState('cms') };
  });

  // ── OBTENER VERSIONES WP Y PHP ────────────────────────────────────────────
  ipcMain.handle('reconstructor:obtener-versiones', async (_event, { serverName }) => {
    try {
      const [versionesWP, versionesPHP] = await Promise.all([
        obtenerVersionesWP(),
        obtenerVersionesPHP(serverName)
      ]);
      return { success: true, versiones: { wp: versionesWP, php: versionesPHP } };
    } catch (error) {
      console.error('[CMS:VERSIONES] Error obteniendo versiones:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('php:obtener-versiones', async (_event, configuracionSSH) => {
    try {
      const respuesta = await obtenerVersionesPHP(configuracionSSH);
      return respuesta;
    } catch (error) {
      console.error('[CMS:PHP-VERSIONES] Error en el canal IPC:', error.message);
      return { exito: false, error: error.message, versiones: [] };
    }
  });
}

module.exports = { registerCmsHandlers };
