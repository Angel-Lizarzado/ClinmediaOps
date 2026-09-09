const { app, BrowserWindow, ipcMain, globalShortcut, dialog } = require('electron');

// ── Candado de instancia única: impide que múltiples procesos de la app corran en simultáneo y bloqueen el instalador ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[APP] Otra instancia ya está en ejecución. Saliendo...');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── IPC: versión de la app ────────────────────────────────────────────────────
ipcMain.handle('app:get-version', () => app.getVersion());
const path = require('path');
const { autoUpdater } = require('electron-updater');
const ipc = require('./ipc');
const { getAppStateManager } = require('../main/state/AppStateManager');
const { collectTelemetry } = require('../main/services/telemetry-service');
const { verifyKillSwitch } = require('../main/utils/security');

let mainWindow;
let splashWindow;

// ── Auto-updater: solo activo en producción ──────────────────────────────────
let updaterInitialized = false;
let isDownloading = false;
const UPDATE_POLL_MS = 60 * 60 * 1000; // 60 minutos
let pollInterval = null;

function initializeAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[UPDATER] Modo desarrollo — autoUpdater deshabilitado.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATER] Buscando actualizaciones...');
    sendToRenderer('updater:checking', {});
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[UPDATER] Actualización disponible: v${info.version}`);
    isDownloading = true;
    sendToRenderer('updater:update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[UPDATER] La aplicación está al día.');
    sendToRenderer('updater:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[UPDATER] Descarga: ${Math.round(progress.percent)}%`);
    sendToRenderer('updater:download-progress', {
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[UPDATER] v${info.version} descargada y lista para instalar.`);
    isDownloading = false;
    sendToRenderer('updater:update-downloaded', {
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[UPDATER] Error:', err.message);
    isDownloading = false;
    sendToRenderer('updater:error', { message: err.message });
  });

  updaterInitialized = true;
  console.log('[UPDATER] Listeners registrados. Esperando señal del frontend para chequear...');
}

// Helper: envía al renderer solo si la ventana existe y terminó de cargar
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  } else {
    console.warn(`[UPDATER] mainWindow no disponible al enviar ${channel}`);
  }
}

// Helper: ejecuta el chequeo solo si no hay descarga en curso
function safeCheckForUpdates() {
  if (!updaterInitialized) return;
  if (isDownloading) {
    console.log('[UPDATER] Chequeo omitido — descarga en curso.');
    return;
  }
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[UPDATER] Error al chequear:', err.message);
  });
}

// El frontend dispara este evento cuando sus listeners IPC están activos.
ipcMain.on('app:frontend-ready', () => {
  console.log('[UPDATER] Frontend confirmó que está listo.');
  safeCheckForUpdates();

  // Polling cada 60 min (solo arranca una vez)
  if (!pollInterval && updaterInitialized) {
    pollInterval = setInterval(() => {
      console.log('[UPDATER] Chequeo periódico (60 min)...');
      safeCheckForUpdates();
    }, UPDATE_POLL_MS);
    console.log(`[UPDATER] Polling activo cada ${UPDATE_POLL_MS / 60000} minutos.`);
  }
});

// IPC: el usuario pide chequeo manual desde la UI
ipcMain.on('updater:check-manually', () => {
  console.log('[UPDATER] Chequeo manual solicitado por el usuario.');
  safeCheckForUpdates();
});

// IPC: el frontend puede pedir la instalación manual
ipcMain.on('updater:quit-and-install', () => {
  console.log('[UPDATER] Cerrando recursos y ventanas para instalar actualización...');
  shutdown();

  // Destruir TODAS las ventanas para liberar handles al binario
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    try {
      win.removeAllListeners('close');
      win.destroy();
    } catch { /* ya cerrada */ }
  }
  mainWindow = null;
  splashWindow = null;

  // isSilent=true activa el Restart Manager de Windows que gestiona
  // file locks del proceso actual. isForceRunAfter=true reabre la app.
  autoUpdater.quitAndInstall(true, true);
});

function createSplashWindow() {
  const iconPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'assets', 'icon.png') 
    : path.join(__dirname, '../../assets/icon.png');
  const iconUrl = 'file://' + iconPath.replace(/\\/g, '/');

  splashWindow = new BrowserWindow({
    width: 400,
    height: 400,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    icon: iconPath,
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'), {
    query: {
      v: app.getVersion(),
      icon: iconUrl
    }
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: '#0F172A',
    icon: path.join(__dirname, '../../assets/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.setMenu(null);

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../ui/build/index.html'));
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Signal "backend ready" to frontend once the window finishes loading
  mainWindow.webContents.on('did-finish-load', async () => {
    console.log('[BOOT] Backend: did-finish-load, emitiendo señal de backend ready');
    try {
      const { getConfigManager } = require('../services/config-manager');
      const cm = getConfigManager();
      if (cm) {
        await cm.initialize();
        const cfg = cm.getConfig();
        console.log('[BOOT] Backend: Config cargada y lista');
        if (cfg && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('config:updated', { success: true, config: cfg });
        }
      }
    } catch (err) {
      console.warn('[BOOT] Backend: configManager no disponible aún:', err.message);
    }

    // Emit full app state to renderer so React sees domain lists etc.
    try {
      const appState = getAppStateManager();
      if (appState) {
        appState.broadcastFullState();
        console.log('[BOOT] Backend: Full state broadcast sent');
      }
    } catch (err) {
      console.warn('[BOOT] Backend: Could not broadcast state:', err.message);
    }
  });

  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
      mainWindow.show();
      if (app.isPackaged) {
        mainWindow.focus();
      }
    }, 2500);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Protección de cierre: si hay migración/DNS/SSL en curso, preguntar antes de salir
  mainWindow.on('close', (e) => {
    if (ipc.isTaskRunning()) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Sí, cancelar todo y salir', 'No, seguir trabajando'],
        defaultId: 1,
        cancelId: 1,
        title: 'Confirmar Salida',
        message: 'Hay una migración o sincronización en curso. Si cierras la aplicación ahora, el proceso se interrumpirá abruptamente.\n\n¿Estás seguro de que quieres salir?'
      });
      if (choice === 0) {
        // Cortar de verdad: cerrar SSH y detener polls antes de destruir la ventana.
        // Antes solo se cerraba la ventana y los procesos quedaban colgando.
        shutdown();
        mainWindow.removeAllListeners('close');
        mainWindow.close();
      }
    }
  });
}

function initializeIpc() {
  ipc.initializeIpcHandlers(ipcMain, mainWindow);
  console.log('IPC channels initialized');
}

function initializeServices() {
  console.log('Services will be initialized lazily via IPC');
}

app.whenReady().then(async () => {
  // ── Dead Man's Switch: bloquea app completa si licencia no es válida ──
  try {
    await verifyKillSwitch();
  } catch (error) {
    dialog.showErrorBox("Error Crítico de Licencia", error.message);
    app.quit();
    return;
  }

  // ── Auto-updater: registrar listeners (el check se dispara cuando el frontend confirme ready) ──
  initializeAutoUpdater();

  // [CCD] Capa 1 — Recolección de telemetría de entorno
  try {
    const telemetry = collectTelemetry();
    console.log('[CCD] Telemetry payload:', JSON.stringify(telemetry));
  } catch (err) {
    console.warn('[CCD] Telemetry collection failed:', err.message);
  }

  // Inicializar AppStateManager (lazy-loads electron-store ESM) — NO bloqueante
  // El store carga en background. Mientras tanto, todo opera en memoria.
  getAppStateManager().init().catch(err => {
    console.warn('[BOOT] AppState persist store no disponible, operando en memoria:', err.message);
  });

  createSplashWindow();
  createMainWindow();
  initializeIpc();
  initializeServices();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Teardown idempotente: puede dispararse por before-quit y por window-all-closed.
let shutdownDone = false;
function shutdown() {
  if (shutdownDone) return;
  shutdownDone = true;

  console.log('[SHUTDOWN] Cerrando la aplicación...');

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  // Cierra conexiones SSH, detiene los polls de métricas y libera los
  // suscriptores de progreso. Sin esto quedaban procesos colgados al salir.
  try {
    ipc.cleanup();
    console.log('[SHUTDOWN] Handlers IPC liberados');
  } catch (err) {
    console.warn('[SHUTDOWN] Error durante el cleanup de IPC:', err.message);
  }

  try {
    getAppStateManager().dispose();
  } catch (err) {
    console.warn('[SHUTDOWN] Error al liberar AppState:', err.message);
  }
}

app.on('before-quit', shutdown);

module.exports = { createWindow: createMainWindow, initializeIpc, initializeServices };
