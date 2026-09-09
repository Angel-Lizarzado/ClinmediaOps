// IPC Handlers: Extraction Operations
// get-extraction-status, module:clear-results, extraction:run-batch, extraction:check-status
// module:get-status (extraction case)

const { getExtractionService } = require('../../services/extraction-service');
const { getProgressEmitter } = require('../../services/progress-emitter');
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getAppStateManager } = require('../state/AppStateManager');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { verifyKillSwitch } = require('../utils/security');

const EMIT = getStandardEmitter('extraction');
let isExtracting = false;

function registerExtractionHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // Get current extraction state (for UI restoration on mount)
  ipcMain.removeHandler('get-extraction-status');
  ipcMain.handle('get-extraction-status', async () => {
    return getAppStateManager().getState('extraction');
  });

  // Clear extraction results
  ipcMain.removeHandler('module:clear-results');
  ipcMain.handle('module:clear-results', async () => {
    const appState = getAppStateManager();
    const state = appState.getState('extraction');
    state.results = [];
    appState.update('extraction', { results: [] });
    return { success: true };
  });

  // Run batch extraction
  ipcMain.removeHandler('extraction:run-batch');
  ipcMain.handle('extraction:run-batch', async (event, { accountName, cloudName, domains }) => {
    if (isExtracting || isOperationRunning.value) {
      return { success: false, error: '[COLA] Ya hay una operación en curso. Espere a que finalice.' };
    }
    isExtracting = true;
    isOperationRunning.value = true;

    try {
      // ── Dead Man's Switch: Fail-Close estricto ──
      await verifyKillSwitch();

      const extractionService = getExtractionService();
      const progressEmitter = getProgressEmitter();
      const appState = getAppStateManager();
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();

      // RESET antes de correr — evita acumulación de resultados/logs de corridas anteriores
      appState.resetModuleState('extraction');

      appState.update('extraction', {
        isRunning: true,
        currentDomain: '',
        currentProgress: 0,
        currentMessage: 'Preparando lote de extracción...',
        totalDomains: domains.length,
        currentIndex: 0,
        domainsQueue: domains,
        batchAccountName: accountName,
        batchCloudName: cloudName,
        results: domains.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });

      EMIT.info(`Preparando lote de ${domains.length} dominios...`);
      sendExtractionLog('Preparando lote de extracción...', 'info');
      event.sender.send('extraction:state-changed', appState.getState('extraction'));
      await new Promise(r => setTimeout(r, 150));

      const batchResults = [];

      // Helper para actualizar en tiempo real el estado de un dominio en el AppState e IPC
      const updateDomainState = (domain, status, message) => {
        const st = appState.getState('extraction');
        if (st && Array.isArray(st.results)) {
          const idx = st.results.findIndex(r => r.domain === domain);
          if (idx >= 0) {
            st.results[idx] = { domain, status, message };
          } else {
            st.results.push({ domain, status, message });
          }
          appState.update('extraction', { results: st.results });
        }
        event.sender.send('extraction:state-changed', appState.getState('extraction'));
        // También emitimos domain-process-result para compatibilidad en frontend
        event.sender.send('domain-process-result', { module: 'EXTRACT', domain, status, message });
      };

      // Bucle secuencial estricto
      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];

        appState.update('extraction', {
          currentDomain: domain,
          currentIndex: i,
          currentProgress: Math.round((i / domains.length) * 100),
          currentMessage: `[EXTRACCIÓN] Iniciando: ${domain}`,
        });
        sendExtractionLog(`[EXTRACCIÓN] Iniciando: ${domain}`, 'info', domain);
        event.sender.send('extraction:state-changed', appState.getState('extraction'));

        // ── 2. Idempotencia: Verificar estado previo en el workspace ──
        // Forzar recarga del JSON para evitar caché obsoleta en iteraciones secuenciales
        workspaceManager._invalidateDominiosCache(accountName, cloudName);
        const currentDominiosProcesados = await workspaceManager.getDominiosProcesados(accountName, cloudName);
        const found = currentDominiosProcesados.find(d => d.dominio === domain);
        
        let physicalFilesExist = false;
        try {
          const safeDomain = extractionService.getSafeDomainPath(domain);
          const domainPath = workspaceManager.getDomainPath(accountName, cloudName, safeDomain);
          
          const fs = require('fs');
          if (fs.existsSync(domainPath)) {
            const items = fs.readdirSync(domainPath);
            const filesExist = items.some(item => item === `${safeDomain}.tar.gz` || item === `${safeDomain}.tar` || item === `${safeDomain}.zip`);
            const dbExists = items.some(item => item === `${safeDomain}.sql`);
            physicalFilesExist = filesExist && dbExists;
          }
        } catch (err) {
          console.warn(`[PHYSICAL-CHECK-WARN] Error al verificar archivos físicos para ${domain}:`, err.message);
        }

        if (found && found.extractionStatus === 'success' && physicalFilesExist) {
          console.log(`[SKIP] Dominio ${domain} ya extraído en corrida anterior y verificado físicamente.`);
          sendExtractionLog(`[SKIP] Dominio ${domain} ya extraído en corrida anterior.`, 'info', domain);
          
          updateDomainState(domain, 'success', 'Saltado (ya extraído)');
          
          batchResults.push({ domain, success: true, skipped: true });
          continue;
        }

        // Emitir estado processing para iniciar
        updateDomainState(domain, 'processing', 'Ejecutando extracción...');

        const taskId = progressEmitter.createTask('extraction', domain, `[EXTRACCIÓN] Iniciando: ${domain}`);

        const progressHandler = (progressData) => {
          if (progressData.domain === domain) {
            appState.update('extraction', {
              currentProgress: progressData.progress ?? 0,
              currentMessage: progressData.message || '',
            });
            sendExtractionLog(progressData.message || '', progressData.progress === 100 ? 'success' : 'info', domain);
            
            // Actualizar mensaje de la descarga en el resultado de la tabla en tiempo real
            updateDomainState(domain, 'downloading', progressData.message || 'Descargando...');
          }
        };

        progressEmitter.on('progress', progressHandler);

        try {
          const result = await extractionService.extractWordPress(accountName, cloudName, domain, taskId);
          batchResults.push({ domain, success: true, result });

          // ── Guardar extractionStatus: 'success' de forma atómica en el JSON ──
          await workspaceManager.updateDominiosProcesados(accountName, cloudName, [{
            dominio: domain,
            extractionStatus: 'success',
            errorReason: null,
            lastExtractionRun: new Date().toISOString()
          }]);

          sendExtractionLog(`[OK] ${domain}: Extracción completada`, 'success', domain);
          updateDomainState(domain, 'success', 'Extracción completada');
        } catch (error) {
          console.error(`[EXTRACCIÓN] Falló ${domain}:`, error.message);
          EMIT.error(`Falló ${domain}: ${error.message}`, domain);
          batchResults.push({ domain, success: false, error: error.message });

          // ── Guardar extractionStatus: 'failed' en el JSON del Workspace ──
          try {
            await workspaceManager.updateDominiosProcesados(accountName, cloudName, [{
              dominio: domain,
              extractionStatus: 'failed',
              errorReason: error.message,
              lastExtractionRun: new Date().toISOString()
            }]);
          } catch (writeErr) {
            console.warn('[WORKSPACE] Error guardando estado de fallo:', writeErr.message);
          }

          sendExtractionLog(`[ERROR] ${domain}: ${error.message}`, 'error', domain);
          updateDomainState(domain, 'error', error.message);
        } finally {
          progressEmitter.off('progress', progressHandler);
        }

        event.sender.send('extraction:state-changed', appState.getState('extraction'));
      }

      appState.update('extraction', {
        isRunning: false,
        currentDomain: '',
        currentProgress: 100,
        currentMessage: 'Extracción masiva finalizada',
      });
      sendExtractionLog('Extracción masiva finalizada', 'success');
      event.sender.send('extraction:state-changed', appState.getState('extraction'));

      const successCount = batchResults.filter(r => r.success).length;
      return {
        success: true,
        results: batchResults,
        total: batchResults.length,
        successCount,
        errors: batchResults.length - successCount,
      };
    } catch (error) {
      console.error('[ERROR] Batch de extracción falló:', error.message);
      EMIT.error(`Batch de extracción falló: ${error.message}`);
      getAppStateManager().update('extraction', { isRunning: false });
      event.sender.send('extraction:state-changed', getAppStateManager().getState('extraction'));
      return { success: false, error: error.message };
    } finally {
      isExtracting = false;
      isOperationRunning.value = false;
    }
  });

  // Check extraction status for a domain
  ipcMain.removeHandler('extraction:check-status');
  ipcMain.handle('extraction:check-status', async (event, { accountName, cloudName, domain }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const status = await workspaceManager.checkExtractionStatus(accountName, cloudName, domain);
      return { success: true, status };
    } catch (error) {
      console.error('Failed to check extraction status:', error);
      return { success: false, error: error.message };
    }
  });

  // ── Extracción Ultra-Lite (solo uploads + config.json + SQL crudo) ──
  ipcMain.removeHandler('extraction:extract-ultra-lite');
  ipcMain.handle('extraction:extract-ultra-lite', async (event, { accountName, cloudName, domains }) => {
    // Se chequean AMBOS locks. Antes solo miraba el local, así que una extracción
    // Ultra-Lite podía arrancar encima de un deploy en curso y colisionar por SSH.
    if (isExtracting || isOperationRunning.value) {
      return { success: false, error: '[COLA] Ya hay una operación en curso. Espere a que finalice.' };
    }

    isExtracting = true;
    isOperationRunning.value = true;

    const appState = getAppStateManager();
    const batchResults = [];

    // Helper para actualizar en tiempo real el estado de un dominio en el AppState e IPC
    const updateDomainState = (domain, status, message) => {
      const st = appState.getState('extraction');
      if (st && Array.isArray(st.results)) {
        const idx = st.results.findIndex(r => r.domain === domain);
        if (idx >= 0) {
          st.results[idx] = { domain, status, message };
        } else {
          st.results.push({ domain, status, message });
        }
        appState.update('extraction', { results: st.results });
      }
      event.sender.send('extraction:state-changed', appState.getState('extraction'));
      event.sender.send('domain-process-result', { module: 'EXTRACT', domain, status, message });
    };

    // TODO lo que sigue va dentro del try: la preparación tiene awaits que pueden
    // fallar y antes quedaban fuera, dejando los locks tomados de forma permanente
    // (la app necesitaba reinicio para volver a extraer).
    try {
      const progressEmitter = getProgressEmitter();
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const extractionService = getExtractionService();

      // RESET antes de correr — evita acumulación de resultados/logs de corridas anteriores
      appState.resetModuleState('extraction');
      appState.update('extraction', {
        isRunning: true,
        currentDomain: '',
        currentProgress: 0,
        currentMessage: 'Iniciando extracción Ultra-Lite...',
        totalDomains: domains.length,
        currentIndex: 0,
        domainsQueue: domains,
        batchAccountName: accountName,
        batchCloudName: cloudName,
        results: domains.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });

      event.sender.send('extraction:state-changed', appState.getState('extraction'));
      await new Promise(r => setTimeout(r, 150));

      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        appState.update('extraction', { 
          currentDomain: domain, 
          currentIndex: i, 
          currentProgress: Math.round((i / domains.length) * 100), 
          currentMessage: `[ULTRA-LITE] Procesando: ${domain}` 
        });

        updateDomainState(domain, 'downloading', 'Iniciando...');

        const taskId = progressEmitter.createTask('extraction', domain, `[ULTRA-LITE] Iniciando: ${domain}`);

        const progressHandler = (progressData) => {
          if (progressData.domain === domain) {
            appState.update('extraction', {
              currentProgress: progressData.progress ?? 0,
              currentMessage: progressData.message || '',
            });
            sendExtractionLog(progressData.message || '', progressData.progress === 100 ? 'success' : 'info', domain);
            updateDomainState(domain, 'downloading', progressData.message || 'Descargando...');
          }
        };

        progressEmitter.on('progress', progressHandler);

        try {
          const result = await extractionService.extractWordPressUltraLite(accountName, cloudName, domain, taskId);
          batchResults.push({ domain, success: true, result });

          await workspaceManager.updateDominiosProcesados(accountName, cloudName, [{
            dominio: domain,
            extractionStatus: 'success',
            errorReason: null,
            lastExtractionRun: new Date().toISOString(),
          }]);

          sendExtractionLog(`[OK] ${domain}: Ultra-Lite completado`, 'success', domain);
          updateDomainState(domain, 'success', 'Ultra-Lite completado');
        } catch (error) {
          console.error(`[ULTRA-LITE] Falló ${domain}:`, error.message);
          EMIT.error(`[ULTRA-LITE] Falló ${domain}: ${error.message}`, domain);
          batchResults.push({ domain, success: false, error: error.message });

          try {
            await workspaceManager.updateDominiosProcesados(accountName, cloudName, [{
              dominio: domain,
              extractionStatus: 'failed',
              errorReason: error.message,
              lastExtractionRun: new Date().toISOString(),
            }]);
          } catch (_) {}

          sendExtractionLog(`[ERROR] ${domain}: ${error.message}`, 'error', domain);
          updateDomainState(domain, 'error', error.message);
        } finally {
          progressEmitter.off('progress', progressHandler);
        }

        event.sender.send('extraction:state-changed', appState.getState('extraction'));
      }

      appState.update('extraction', { isRunning: false, currentDomain: '', currentProgress: 100, currentMessage: 'Ultra-Lite batch finalizado' });
      sendExtractionLog('Extracción Ultra-Lite finalizada', 'success');
      event.sender.send('extraction:state-changed', appState.getState('extraction'));

      const successCount = batchResults.filter(r => r.success).length;
      return { success: true, results: batchResults, total: batchResults.length, successCount, errors: batchResults.length - successCount };
    } catch (error) {
      console.error('[ERROR] Batch Ultra-Lite falló:', error.message);
      EMIT.error(`Batch Ultra-Lite falló: ${error.message}`);
      appState.update('extraction', { isRunning: false });
      event.sender.send('extraction:state-changed', appState.getState('extraction'));
      return { success: false, error: error.message };
    } finally {
      isExtracting = false;
      isOperationRunning.value = false;
    }
  });

  // Extract-specific log helpers
  function sendExtractionLog(message, type = 'info', domain = '') {
    EMIT.emit(type, message, domain);
    const appState = getAppStateManager();
    if (!message) return;
    const state = appState.getState('extraction');
    const logs = state.recentLogs || [];
    const isDownload = message.startsWith('Descargando:');
    const isTransfer = message.startsWith('Trasladando');
    if (isDownload || isTransfer) {
      let replaced = false;
      const prefix = isDownload ? 'Descargando:' : 'Trasladando';
      for (let i = logs.length - 1; i >= 0; i--) {
        if (logs[i].message.startsWith(prefix)) {
          logs[i] = { message, timestamp: Date.now() };
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        logs.push({ message, timestamp: Date.now() });
      }
    } else {
      logs.push({ message, timestamp: Date.now() });
    }
    if (logs.length > 50) logs.shift();
    appState.update('extraction', { recentLogs: logs });

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('extraction:log', { message, type, timestamp: Date.now() });
    }
  }
}

module.exports = { registerExtractionHandlers };
