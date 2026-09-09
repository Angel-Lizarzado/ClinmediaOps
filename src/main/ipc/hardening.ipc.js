// IPC Handlers: Blindaje (hardening WordPress)
//
// Canales:
//   hardening:get-measures   → catálogo de medidas para pintar la UI
//   hardening:run-domain     → aplica (y verifica) sobre UN dominio
//   hardening:verify-domain  → solo verifica, sin tocar nada
//   hardening:run-batch      → recorre una lista de dominios en secuencia
//   hardening:abort          → pide parada del lote en curso
//   hardening:unlock         → levanta DISALLOW_FILE_MODS de un dominio
//
// Eventos hacia el renderer:
//   hardening:progress  — avance en vivo, por dominio y por medida
//   hardening:result    — resultado consolidado de un dominio

const { getSshService } = require('../../services/ssh-service');
const { getConfigManager } = require('../../services/config-manager');
const {
  verifyHardening,
  hardenAndVerify,
  unlockFileMods,
  normalizeMeasures,
  MEASURES,
  DEFAULT_MEASURES,
  LOGIN_SLUG,
} = require('../../services/hardening/hardeningService');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { getAppStateManager } = require('../state/AppStateManager');

const EMIT = getStandardEmitter('scanner');

// Lote en curso: permite abortar entre dominios. Es local al módulo a
// propósito — solo puede haber un lote de blindaje a la vez.
let abortarLote = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getServerConfig(serverName) {
  const configManager = getConfigManager();
  if (!configManager.getConfig()) await configManager.initialize();
  const config = configManager.getConfig();
  const server = config.destinationServers?.find((s) => s.name === serverName);
  if (!server) throw new Error(`Servidor "${serverName}" no encontrado en la configuración`);
  return server;
}

function registerHardeningHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  /** Envía un evento al renderer si la ventana sigue viva. */
  const sendToRenderer = (canal, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(canal, payload);
    }
  };

  /**
   * Puente de progreso: lo que el script bash emite en vivo llega acá y de acá
   * a la UI. Es lo que permite ver qué está haciendo en cada momento en vez de
   * mirar una barra que no se mueve durante quince minutos.
   */
  const hacerOnProgress = (extra = {}) => (payload) => {
    sendToRenderer('hardening:progress', { ...payload, ...extra, timestamp: Date.now() });
    if (payload.msg) {
      const nivel = payload.status === 'fail' ? 'warn' : 'info';
      EMIT.log(nivel, `[BLINDAJE] ${payload.msg}`, payload.domain);
    }
  };

  // ── Catálogo de medidas ─────────────────────────────────────────────────────
  ipcMain.removeHandler('hardening:get-measures');
  ipcMain.handle('hardening:get-measures', async () => ({
    success: true,
    measures: MEASURES,
    defaults: DEFAULT_MEASURES,
    loginSlug: LOGIN_SLUG,
  }));

  // ── Un dominio: aplicar + verificar ─────────────────────────────────────────
  ipcMain.removeHandler('hardening:run-domain');
  ipcMain.handle('hardening:run-domain', async (event, { domain, serverName, measures, dryRun = false }) => {
    let client = null;
    try {
      const serverConfig = await getServerConfig(serverName);
      const sshService = getSshService();
      client = await sshService.connect(serverConfig.sshCredentials, `harden-${domain}-${Date.now()}`);

      EMIT.info(`Blindaje ${dryRun ? '(simulación) ' : ''}iniciado para ${domain}`, domain);

      const epConfig = getConfigManager().getConfig()?.elementorPro || null;

      const resultado = await hardenAndVerify(client, domain, {
        measures: normalizeMeasures(measures),
        dryRun,
        onProgress: hacerOnProgress(),
        elementorPro: epConfig,
      });

      sendToRenderer('hardening:result', resultado);
      EMIT.log(
        resultado.success ? 'success' : 'error',
        resultado.success
          ? `Blindaje terminado — cumplimiento ${resultado.score}%`
          : `Blindaje falló: ${resultado.error}`,
        domain
      );

      return resultado;
    } catch (error) {
      EMIT.error(`Blindaje falló: ${error.message}`, domain);
      const fallo = { domain, success: false, error: error.message };
      sendToRenderer('hardening:result', fallo);
      return fallo;
    } finally {
      if (client) {
        try { await getSshService().disconnect(client); } catch (_) { /* no crítico */ }
      }
    }
  });

  // ── Un dominio: solo verificar ──────────────────────────────────────────────
  ipcMain.removeHandler('hardening:verify-domain');
  ipcMain.handle('hardening:verify-domain', async (event, { domain, serverName, measures }) => {
    let client = null;
    try {
      const serverConfig = await getServerConfig(serverName);
      const sshService = getSshService();
      client = await sshService.connect(serverConfig.sshCredentials, `verify-${domain}-${Date.now()}`);

      const resultado = await verifyHardening(client, domain, {
        measures: normalizeMeasures(measures),
        onProgress: hacerOnProgress(),
      });

      sendToRenderer('hardening:result', { domain, success: true, verify: resultado, score: resultado.score });
      return { domain, success: true, verify: resultado, score: resultado.score };
    } catch (error) {
      EMIT.error(`Verificación falló: ${error.message}`, domain);
      return { domain, success: false, error: error.message };
    } finally {
      if (client) {
        try { await getSshService().disconnect(client); } catch (_) { /* no crítico */ }
      }
    }
  });

  // ── Lote ────────────────────────────────────────────────────────────────────
  //
  // Estrictamente secuencial y reusando UNA sola conexión SSH para todo el lote:
  // con cientos de dominios, abrir y cerrar una conexión por dominio dispara las
  // alarmas de fuerza bruta del propio servidor.
  ipcMain.removeHandler('hardening:run-batch');
  ipcMain.handle('hardening:run-batch', async (event, { domains, serverName, measures, dryRun = false }) => {
    if (isOperationRunning.value) {
      return { success: false, error: '[COLA] Ya hay una operación en curso. Espere a que finalice.' };
    }
    if (!Array.isArray(domains) || domains.length === 0) {
      return { success: false, error: 'No se recibió ningún dominio' };
    }

    isOperationRunning.value = true;
    abortarLote = false;

    const appState = getAppStateManager();
    const medidas = normalizeMeasures(measures);
    const resultados = [];
    let client = null;

    try {
      const serverConfig = await getServerConfig(serverName);
      const sshService = getSshService();

      appState.update('hardening', {
        isRunning: true,
        totalDomains: domains.length,
        currentIndex: 0,
        results: domains.map((d) => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });

      client = await sshService.connect(serverConfig.sshCredentials, `harden-batch-${Date.now()}`);
      EMIT.info(`Lote de blindaje ${dryRun ? '(simulación) ' : ''}— ${domains.length} dominios`);

      const epConfig = getConfigManager().getConfig()?.elementorPro || null;

      for (let i = 0; i < domains.length; i++) {
        if (abortarLote) {
          EMIT.warn('Lote de blindaje abortado por el usuario');
          break;
        }

        const domain = domains[i];

        appState.update('hardening', {
          currentIndex: i,
          currentDomain: domain,
          currentProgress: Math.round((i / domains.length) * 100),
          currentMessage: `Blindando ${domain}`,
        });
        sendToRenderer('hardening:progress', {
          domain, phase: 'batch', measure: 'lote', status: 'running',
          msg: `(${i + 1}/${domains.length}) ${domain}`, index: i, total: domains.length,
        });

        let resultado;
        try {
          resultado = await hardenAndVerify(client, domain, {
            measures: medidas,
            dryRun,
            onProgress: hacerOnProgress({ index: i, total: domains.length }),
            elementorPro: epConfig,
          });
        } catch (err) {
          // Un dominio que falla no puede cortar el lote: se registra y sigue.
          resultado = { domain, success: false, error: err.message };
          EMIT.error(`Blindaje falló: ${err.message}`, domain);
        }

        resultados.push(resultado);
        sendToRenderer('hardening:result', resultado);

        // Reflejar en el estado global para que la UI sobreviva un desmontaje
        const actual = appState.getState('hardening');
        const otros = (actual.results || []).filter((r) => r.domain !== domain);
        otros.push({
          domain,
          status: resultado.success ? (resultado.score === 100 ? 'clean' : 'infected') : 'error',
          message: resultado.success ? `Cumplimiento ${resultado.score}%` : (resultado.error || 'Falló'),
          score: resultado.score ?? null,
          isProtected: resultado.success && resultado.score === 100,
        });
        appState.update('hardening', { results: otros });
      }

      const conFallos = resultados.filter((r) => !r.success).length;
      const promedio = resultados.length
        ? Math.round(resultados.reduce((acc, r) => acc + (r.score || 0), 0) / resultados.length)
        : 0;

      appState.update('hardening', {
        isRunning: false,
        currentProgress: 100,
        currentMessage: `Lote terminado — cumplimiento promedio ${promedio}%`,
      });
      EMIT.success(`Lote de blindaje terminado — cumplimiento promedio ${promedio}%`);

      return {
        success: true,
        aborted: abortarLote,
        dryRun,
        total: resultados.length,
        failed: conFallos,
        averageScore: promedio,
        results: resultados,
      };
    } catch (error) {
      EMIT.error(`Lote de blindaje falló: ${error.message}`);
      appState.update('hardening', { isRunning: false });
      return { success: false, error: error.message, results: resultados };
    } finally {
      abortarLote = false;
      isOperationRunning.value = false;
      if (client) {
        try { await getSshService().disconnect(client); } catch (_) { /* no crítico */ }
      }
    }
  });

  // ── Lote de solo verificación ───────────────────────────────────────────────
  //
  // Existe por la misma razón que run-batch: sin esto la UI tenía que hacer el
  // bucle en el renderer llamando a verify-domain, lo que abre y cierra UNA
  // conexión SSH por dominio. Con cientos de dominios eso dispara las alarmas
  // de fuerza bruta del propio servidor. Acá se reusa una sola conexión y
  // responde al mismo botón de abortar que el lote de aplicación.
  ipcMain.removeHandler('hardening:verify-batch');
  ipcMain.handle('hardening:verify-batch', async (event, { domains, serverName, measures }) => {
    if (isOperationRunning.value) {
      return { success: false, error: '[COLA] Ya hay una operación en curso. Espere a que finalice.' };
    }
    if (!Array.isArray(domains) || domains.length === 0) {
      return { success: false, error: 'No se recibió ningún dominio' };
    }

    isOperationRunning.value = true;
    abortarLote = false;

    const appState = getAppStateManager();
    const medidas = normalizeMeasures(measures);
    const resultados = [];
    let client = null;

    try {
      const serverConfig = await getServerConfig(serverName);
      const sshService = getSshService();

      appState.update('hardening', {
        isRunning: true,
        totalDomains: domains.length,
        currentIndex: 0,
        results: domains.map((d) => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });

      client = await sshService.connect(serverConfig.sshCredentials, `verify-batch-${Date.now()}`);
      EMIT.info(`Verificación de blindaje — ${domains.length} dominios`);

      for (let i = 0; i < domains.length; i++) {
        if (abortarLote) {
          EMIT.warn('Verificación abortada por el usuario');
          break;
        }

        const domain = domains[i];

        appState.update('hardening', {
          currentIndex: i,
          currentDomain: domain,
          currentProgress: Math.round((i / domains.length) * 100),
          currentMessage: `Verificando ${domain}`,
        });
        sendToRenderer('hardening:progress', {
          domain, phase: 'batch', measure: 'lote', status: 'running',
          msg: `(${i + 1}/${domains.length}) ${domain}`, index: i, total: domains.length,
        });

        let resultado;
        try {
          const verificacion = await verifyHardening(client, domain, {
            measures: medidas,
            onProgress: hacerOnProgress({ index: i, total: domains.length }),
          });
          resultado = { domain, success: true, verify: verificacion, score: verificacion.score };
        } catch (err) {
          // Un dominio que falla no puede cortar el lote.
          resultado = { domain, success: false, error: err.message };
          EMIT.error(`Verificación falló: ${err.message}`, domain);
        }

        resultados.push(resultado);
        sendToRenderer('hardening:result', resultado);

        const actual = appState.getState('hardening');
        const otros = (actual.results || []).filter((r) => r.domain !== domain);
        otros.push({
          domain,
          status: resultado.success ? (resultado.score === 100 ? 'clean' : 'infected') : 'error',
          message: resultado.success ? `Cumplimiento ${resultado.score}%` : (resultado.error || 'Falló'),
          score: resultado.score ?? null,
          isProtected: resultado.success && resultado.score === 100,
        });
        appState.update('hardening', { results: otros });
      }

      const promedio = resultados.length
        ? Math.round(resultados.reduce((acc, r) => acc + (r.score || 0), 0) / resultados.length)
        : 0;

      appState.update('hardening', {
        isRunning: false,
        currentProgress: 100,
        currentMessage: `Verificación terminada — cumplimiento promedio ${promedio}%`,
        averageScore: promedio,
      });
      EMIT.success(`Verificación terminada — cumplimiento promedio ${promedio}%`);

      return {
        success: true,
        aborted: abortarLote,
        total: resultados.length,
        failed: resultados.filter((r) => !r.success).length,
        averageScore: promedio,
        results: resultados,
      };
    } catch (error) {
      EMIT.error(`Verificación por lote falló: ${error.message}`);
      appState.update('hardening', { isRunning: false });
      return { success: false, error: error.message, results: resultados };
    } finally {
      abortarLote = false;
      isOperationRunning.value = false;
      if (client) {
        try { await getSshService().disconnect(client); } catch (_) { /* no crítico */ }
      }
    }
  });

  // ── Abortar ─────────────────────────────────────────────────────────────────
  // Marca la bandera: el lote corta entre dominios, nunca a mitad de uno.
  // Interrumpir un dominio a mitad de camino puede dejar su wp-config o su
  // .htaccess a medio escribir.
  ipcMain.removeHandler('hardening:abort');
  ipcMain.handle('hardening:abort', async () => {
    abortarLote = true;
    EMIT.warn('Parada solicitada — el lote se detendrá al terminar el dominio actual');
    return { success: true };
  });

  // ── Levantar el candado ─────────────────────────────────────────────────────
  ipcMain.removeHandler('hardening:unlock');
  ipcMain.handle('hardening:unlock', async (event, { domain, serverName }) => {
    let client = null;
    try {
      const serverConfig = await getServerConfig(serverName);
      const sshService = getSshService();
      client = await sshService.connect(serverConfig.sshCredentials, `unlock-${domain}-${Date.now()}`);
      const resultado = await unlockFileMods(client, domain);
      EMIT.info(`Candado levantado en ${domain} — recordá volver a blindar al terminar`, domain);
      return resultado;
    } catch (error) {
      return { domain, success: false, error: error.message };
    } finally {
      if (client) {
        try { await getSshService().disconnect(client); } catch (_) { /* no crítico */ }
      }
    }
  });
}

module.exports = { registerHardeningHandlers };
