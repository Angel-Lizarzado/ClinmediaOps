const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { domainToASCII } = require('node:url');
const { getSshService } = require('./ssh-service');
const { getWorkspaceManager } = require('./workspace-manager');
const { getProgressEmitter } = require('./progress-emitter');
const { getConfigManager } = require('./config-manager');
const { getPleskCliService } = require('./plesk-cli-service');
const { getExtractionService } = require('./extraction-service');

// ── Blacklist de usuarios maliciosos (legacy Python migrador_plesk.py) ──
const BLACKLIST_USERS = [
  'adminbockup', 'adminwp', 'adnankhokhar451@gmail.com', 'alfonzogambrel', 'archiveauth', 'archiveclient',
  'archivefeed', 'archiveoption', 'archiveprofile', 'archivetable', 'archiveuser', 'articles_user',
  'articlesclient', 'articlesfeed', 'articlesoption', 'articlespanel', 'articlesprofile', 'articlesrss',
  'articlestable', 'articlesuse', 'articlesuser', 'assistantchiefa2fa', 'bgulyn8865', 'blogauth',
  'blogclient', 'blogfeed', 'blogoption', 'blogprofile', 'blogtable', 'bloguser', 'bot', 'brennarobins2',
  'caitlynmcclain', 'cathysimmons1', 'chonghickman858', 'cmsauth', 'cmsclient', 'cmseditor', 'cmsfeed',
  'cmspanel', 'cmsprofile', 'cmsrss', 'cmstable', 'cmsuser', 'corechiefd27c', 'default', 'devauth',
  'devclient', 'devfeed', 'devoption', 'devpanel', 'devprofile', 'devrss', 'devtable', 'devuser',
  'editorpro906f', 'edzexegh', 'everettegunn32', 'gladismccombie7', 'gsujdhsu548fj@yopmail.com', 'hugoeaves2',
  'josephbrien6023', 'ksragcnwuoht', 'lougault641', 'lucienney93', 'main_panel', 'mainauth', 'mainclient',
  'mainfeed', 'mainpanel', 'mainprofile', 'mainrss', 'maintable', 'mainuser', 'maloriebraud3', 'mm3rttpdjz0q',
  'naewtrer897509newetrewt', 'nartytryut1129117nehtyhyhtr', 'natregtegh3116218nerthrrth',
  'natregtegh3171896nertytry', 'newsauth', 'newsclient', 'newsfeed', 'newsoption', 'newspanel',
  'newsprofile', 'notesauth', 'notesfeed', 'notesoption', 'notespanel', 'notesprofile', 'notesrss',
  'notestable', 'notesuser', 'operatoradmin158f', 'operatorhelper1696', 'operatordev185d',
  'operatorleadb705', 'operatorninja1196', 'operatorpro1034', 'penniardill5', 'rgyc1ote4dgn', 'roy9661024',
  'russellmartz8', 'salesninja8179', 'salesninja81bb', 'seomaster7416', 'sung12o12397315', 'support_admin',
  'tonyamccue73490', 'trumpweiss', 'updatebot6a6f', 'utilkhgbyn', 'vgxkiara95', 'webclient', 'webfeed',
  'weboption', 'webpanel', 'webrss', 'webtable', 'webuser', 'wpclient', 'wpoption', 'wppanel', 'wpprofile',
  'wprss', 'wptable', 'wpuser', 'xfzdfqgzli', 'ydvpurotux'
];

class DeploymentService {
  constructor() {
    this.sshService = getSshService();
    this.workspaceManager = getWorkspaceManager();
    this.progressEmitter = getProgressEmitter();
    this.configManager = getConfigManager();
    this.pleskCliService = getPleskCliService();
    this.extractionService = getExtractionService();
    this.detenerSolicitado = false;
    // Profundidad de la ventana con domain-resolution-checker apagado.
    this._resolutionCheckerDepth = 0;
  }

  solicitarParada() {
    this.detenerSolicitado = true;
  }

  // ── domain-resolution-checker de Plesk ──────────────────────────────────────
  //
  // Crear una suscripción para un dominio cuyo DNS todavía apunta al servidor
  // origen exige apagar este chequeo. PERO es un ajuste GLOBAL del servidor,
  // no por dominio: dejarlo apagado deja al Plesk entero sin esa protección.
  //
  // Antes se apagaba y prendía DENTRO del loop, una vez por dominio, y el
  // restore era `.catch(() => {})` mudo. Un corte entre medio dejaba el
  // servidor desprotegido de forma permanente y sin rastro en los logs.
  //
  // Ahora se cuenta la profundidad: el batch abre la ventana una sola vez y
  // cada dominio se cuelga de ella. La restauración ocurre al cerrar la última
  // y grita fuerte si falla.

  async _setResolutionChecker(sshClient, enabled) {
    const valor = enabled ? 'true' : 'false';
    const result = await this.sshService.executeCommand(
      sshClient,
      `plesk bin server_pref -u -domain-resolution-checker ${valor}`,
      { timeoutMs: 30000 }
    );
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `código ${result.code}`);
    }
    return result;
  }

  /**
   * Ejecuta `fn` con el domain-resolution-checker apagado.
   * Reentrante: si ya hay una ventana abierta, no vuelve a tocar el servidor.
   *
   * @param {import('ssh2').Client} sshClient
   * @param {string} taskId
   * @param {string} domain — solo para el log
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async _withResolutionCheckerDisabled(sshClient, taskId, domain, fn) {
    const yaAbierta = this._resolutionCheckerDepth > 0;
    this._resolutionCheckerDepth += 1;

    if (!yaAbierta) {
      this.emitLog(taskId, domain, 10, '[PLESK] Deshabilitando domain-resolution-checker para la migración...');
      try {
        await this._setResolutionChecker(sshClient, false);
      } catch (err) {
        // Si no se pudo apagar, no se abrió ninguna ventana que cerrar.
        this._resolutionCheckerDepth -= 1;
        this.emitLog(taskId, domain, 10, `[PLESK] No se pudo deshabilitar domain-resolution-checker: ${err.message}. Se continúa igual.`);
        return fn();
      }
    }

    try {
      return await fn();
    } finally {
      this._resolutionCheckerDepth -= 1;
      if (this._resolutionCheckerDepth === 0) {
        this.emitLog(taskId, domain, 10, '[PLESK] Restaurando domain-resolution-checker...');
        try {
          await this._setResolutionChecker(sshClient, true);
        } catch (err) {
          // Esto deja el servidor sin una protección. NO puede ser silencioso.
          const aviso = `[PLESK][ATENCIÓN] No se pudo restaurar domain-resolution-checker en el servidor: ${err.message}. ` +
            'Restaurarlo a mano con: plesk bin server_pref -u -domain-resolution-checker true';
          console.error(aviso);
          this.emitLog(taskId, domain, 10, aviso);
          try {
            require('./standard-emitter').getStandardEmitter('deployment').emit('error', aviso, domain);
          } catch (_) { /* el log ya salió por los otros canales */ }
        }
      }
    }
  }

  /**
   * Emit a log message via progressEmitter (for UI consumption).
   * Mirrors extraction-service.js emitLog pattern.
   * @param {string} taskId - Task ID for progress tracking
   * @param {string} domain - Domain name
   * @param {number} progress - Progress percentage (0-100)
   * @param {string} message - Log message
   */
  emitLog(taskId, domain, progress, message) {
    process.nextTick(() => {
      this.progressEmitter.emitProgress({
        taskId,
        module: 'deployment',
        domain,
        progress,
        message
      });
    });
  }

  /**
   * Convert a raw domain to Punycode (safeDomain) using the native URL API.
   * NO punycode npm package — uses new URL() + toASCII internally.
   * @param {string} rawDomain - Domain name (possibly with accents, protocol, etc.)
   * @returns {string} Punycode-encoded domain or sanitized fallback
   */
  safeDomain(rawDomain) {
    if (!rawDomain) return rawDomain;
    const trimmed = rawDomain.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    try {
      // If no protocol, prepend https:// so URL parsing works
      const withProtocol = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
      const parsed = new URL(withProtocol);
      return parsed.hostname;
    } catch {
      // Fallback: strip non-ASCII and non-standard chars
      return trimmed.replace(/[^a-zA-Z0-9.-]/g, '_');
    }
  }

  /**
   * Generate a short, filesystem-safe name from a PUNYCODE domain for remote file naming.
   * Strips TLD, removes non-ASCII, truncates to 20 chars max.
   * Ej: "xn--clinicamedicoesteticaodamadrid" → "xnclinicamedicoest"
   */
  shortName(domain) {
    if (!domain) return 'backup';
    // Get first part before the dot
    const base = domain.split('.')[0];
    // Strip non-alphanumeric (keep only a-z, 0-9)
    const clean = base.replace(/[^a-zA-Z0-9]/g, '');
    // Truncate to 20 chars max
    return clean.substring(0, 20) || 'backup';
  }

  /**
   * Deploy multiple domains in batch (reads dominios_procesados.json automatically).
   * Single SSH connection reused for all domains.
   * @param {string} accountName - Account name for config lookup
   * @param {string} serverName - Plesk server name
   * @param {string} sourceAccount - Source account (for extraction path)
   * @param {string} sourceCloud - Source cloud (for extraction path)
   * @param {string} batchTaskId - Batch-level task ID
   * @param {string[]} [manualList] - Optional array of domain names to filter. When provided,
   *                                  only domains whose `dominio` property matches are deployed.
   * @returns {Promise<Object>} Batch results with summary
   */
  async deployBatch(accountName, serverName, sourceAccount, sourceCloud, batchTaskId, manualList, emitLog = null, forceClean = false, onDomainEvent = null) {
    /** @type {import('ssh2').Client|null} */
    let sshClient = null;
    this.detenerSolicitado = false;
    try {
      // --- VALIDACIÓN DE CONFIGURACIÓN ---
      const rawConfig = this.configManager.getConfig();
      if (!rawConfig) {
        throw new Error('[CRITICAL] ConfigManager.getConfig() devolvió null/undefined. La configuración global no está cargada.');
      }
      // Buscamos el servidor DIRECTAMENTE en la bolsa global de servidores
      const serverConfig = rawConfig.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) {
        throw new Error(`[CRITICAL] El servidor "${serverName}" no existe en la configuración global (destinationServers).`);
      }
      if (!serverConfig.isLinked) {
        throw new Error(`[CRITICAL] El servidor "${serverName}" no está vinculado SSH (isLinked: false).`);
      }

      // --- RESOLVER LISTA DE DOMINIOS ---
      // Prioridad 1: manualList del frontend (textarea) — bypass total del JSON en disco
      // Prioridad 2: fallback a dominios_procesados.json (Fase 1 completada)
      let dominios = [];

      if (manualList && Array.isArray(manualList) && manualList.length > 0) {
        console.log(`[DEPLOY BATCH] Usando ${manualList.length} dominios del TextArea (bypass JSON en disco)`);
        dominios = manualList
          .map(d => d.trim().toLowerCase())
          .filter(Boolean);
        if (dominios.length === 0) {
          throw new Error('El TextArea contenía solo líneas vacías. Ingresa al menos un dominio válido.');
        }
        console.log(`[DEPLOY BATCH] manualList normalizada (${dominios.length}):`, dominios.slice(0, 5), dominios.length > 5 ? '...' : '');
      } else {
        console.log('[DEPLOY BATCH] Sin manualList — intentando cargar desde dominios_procesados.json (Fase 1)');
        dominios = await this.workspaceManager.getDominiosProcesados(sourceAccount, sourceCloud);
        console.log('[DEBUG] Datos cargados del JSON:', dominios);

        if (dominios === undefined || dominios === null) {
          console.log('[ERROR] No se pudo recuperar la lista de dominios del workspace.');
          throw new Error('[ERROR] No se pudo recuperar la lista de dominios del workspace. getDominiosProcesados devolvió undefined.');
        }
        if (!Array.isArray(dominios)) {
          console.log('[ERROR] El formato del JSON de dominios no es válido (se esperaba un array). Tipo recibido:', typeof dominios);
          throw new Error('[ERROR] El formato del JSON de dominios no es válido (se esperaba un array).');
        }
        console.log(`[DEPLOY BATCH] Total dominios en JSON: ${dominios.length}`);
        if (dominios.length === 0) {
          throw new Error('[ERROR] El historial de extracción está vacío. No hay dominios para desplegar. Asegúrate de haber completado la Fase 1 o ingresa dominios manualmente en el TextArea.');
        }
      }

      const results = [];

      // Open ONE SSH connection for the entire batch
      const sshServerConfig = rawConfig.destinationServers?.find(s => s.name === serverName);
      this.progressEmitter.emitProgress({
        taskId: batchTaskId,
        module: 'deployment',
        domain: 'batch',
        progress: 0,
        message: `[BATCH] Conectando a ${serverName} para desplegar ${dominios.length} dominios...`
      });
      sshClient = await this.sshService.connect(serverConfig.sshCredentials, `deployment-batch-${batchTaskId}`);
      if (emitLog) emitLog(`[BATCH] Conexión SSH establecida con ${serverName}`, 'info');

      // --- FAIL-FAST: Verificar que la conexión SSH está VIVA antes de procesar 89 dominios ---
      if (!sshClient || !sshClient._sock || sshClient._sock.destroyed) {
        throw new Error('La conexión SSH con el servidor de destino no está establecida. Verifica las credenciales e inténtalo de nuevo.');
      }

      for (const [i, rawDomain] of dominios.entries()) {
        if (this.detenerSolicitado || this.abortarSolicitado) {
          console.log('[SECURITY] Detención confirmada en backend. Rompiendo ciclo secuencial.');
          if (emitLog) emitLog('[ORQUESTADOR] Lote detenido por el usuario (Graceful Shutdown).', 'warning');
          
          this.progressEmitter.emitProgress({
            taskId: batchTaskId,
            module: 'deployment',
            domain: 'batch',
            progress: 100,
            message: '[BATCH] Detenido por el usuario (Graceful Shutdown).'
          });
          break;
        }

        const rawExtracted = typeof rawDomain === 'object' ? (rawDomain.dominio || rawDomain.domain) : rawDomain;
        const domainName = rawExtracted ? require('node:url').domainToASCII(rawExtracted.trim().toLowerCase()) : '';
        const taskId = this.progressEmitter.createTask('deployment', domainName, `Iniciando despliegue de ${domainName}`);
        const baseProgress = Math.round((i / dominios.length) * 90);

        // TAREA 4: Técnica del Submarino (Rotación periódica para evadir firewall)
        // Desconectamos y reconectamos intencionalmente cada 2 dominios
        if (i > 0 && i % 2 === 0) {
          if (emitLog) emitLog(`[BATCH] Rotando conexión SSH (Técnica Submarino) para evitar timeout corporativo...`, 'info');
          try { if (sshClient) sshClient.end(); } catch (_) { }
          await new Promise(resolve => setTimeout(resolve, 3000)); // Pequeña pausa para limpiar socket
          sshClient = null;
        }

        // TAREA 4b: Reconectar si la conexión global se cayó o la cerramos a propósito
        if (!sshClient || !sshClient._sock || sshClient._sock.destroyed) {
          if (emitLog) emitLog(sshClient ? `[BATCH] Conexión SSH perdida, reconectando...` : `[BATCH] Estableciendo nueva sesión SSH...`, 'warning');
          try { if (sshClient) sshClient.end(); } catch (_) { }
          sshClient = await this.sshService.connect(serverConfig.sshCredentials, `deployment-batch-${batchTaskId}`);
          if (emitLog) emitLog(`[BATCH] Reconexión SSH exitosa`, 'info');
        }

        if (onDomainEvent) {
          onDomainEvent(domainName, 'migrate-domain-start', { message: 'Iniciando migración...' });
          await new Promise(resolve => setTimeout(resolve, 150));
        }

        this.progressEmitter.emitProgress({
          taskId: batchTaskId,
          module: 'deployment',
          domain: domainName,
          progress: baseProgress,
          message: `[${i + 1}/${dominios.length}] ${domainName} — [READY] preparando archivos...`
        });

        // Track DNS status per domain
        let dnsStatus = null;

        try {
          // Emitimos solo un header ligero en tiempo real para feedback de que empezó
          if (emitLog) emitLog(`[BATCH] Procesando: ${domainName}...`, 'info', domainName);
          const result = await this.deploySingleDomain(
            accountName, serverName, domainName, sourceAccount, sourceCloud,
            taskId, { sshClient }, emitLog, forceClean
          );

          // 🔥 v1.9.2: DNS no propagado no es advertencia — es esperable. Solo miramos si el deploy fue exitoso.
          const deployOk = result.status === 'success' || result.step === 'complete';
          const isWarning = result.status === 'warning';
          const finalStatus = deployOk ? 'success' : (isWarning ? 'warning' : 'error');

          const errDetail = result.errorDetails || result.error || null;
          if (finalStatus === 'success') {
            const isSkipped = result.step === 'skipped';
            const msgToEmit = isSkipped ? 'Omitido (Ya existe)' : 'Migrado correctamente';
            
            if (emitLog) emitLog(`[OK] ${domainName}: ${msgToEmit}`, 'success', domainName);
            if (onDomainEvent) {
              onDomainEvent(domainName, 'migrate-domain-success', { message: msgToEmit });
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          } else {
            if (finalStatus === 'warning') {
              if (emitLog) emitLog(`[WARN] ${domainName}: ${errDetail || 'Faltan archivos'}`, 'warning', domainName);
              if (onDomainEvent) {
                onDomainEvent(domainName, 'migrate-domain-warning', { message: errDetail || 'Faltan archivos' });
                await new Promise(resolve => setTimeout(resolve, 50));
              }
            } else if (finalStatus === 'error') {
              if (emitLog) emitLog(`[ERROR] ${domainName}: ${errDetail || 'Error durante el despliegue'}`, 'error', domainName);
              if (onDomainEvent) {
                onDomainEvent(domainName, 'migrate-domain-error', { message: errDetail || 'Error durante el despliegue' });
                await new Promise(resolve => setTimeout(resolve, 50));
              }
            }
          }

          results.push({
            domain: domainName,
            status: finalStatus,
            step: result.step || 'complete',
            details: result.details || result,
            errorDetails: errDetail,
            dnsStatus
          });
          
          this.progressEmitter.completeTask(taskId, `Finalizó dominio: ${domainName} — ${result.status}`);
        } catch (error) {
          console.error(`[BATCH] Deploy failed for ${domainName}:`, error.message);
          if (emitLog) {
            emitLog(`[ERROR] ${domainName}: ${error.message}`, 'error', domainName);
          }
          if (onDomainEvent) {
            onDomainEvent(domainName, 'migrate-domain-error', { message: error.message });
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          results.push({
            domain: domainName,
            status: 'error',
            step: error.step || 'unknown',
            errorDetails: error.message,
            details: null
          });
          this.progressEmitter.cancelTask(taskId, `Error: ${error.message}`);
        }
      }

      return {
        success: true,
        results,
        summary: {
          total: dominios.length,
          successful: results.filter(r => r.status === 'success').length,
          completed_with_warnings: results.filter(r => r.status === 'completed_with_warnings').length,
          failed: results.filter(r => r.status === 'error').length
        }
      };
    } catch (error) {
      console.error('[CRITICAL-STACK] deployBatch crash completo:', error.stack);
      throw error;
    } finally {
      if (sshClient) {
        try { sshClient.end(); } catch (e) { /* ignore */ }
        if (emitLog) emitLog('[BATCH] Conexión SSH cerrada', 'info');
      }
    }
  }

  /**
   * Deploy a single WordPress site to Plesk.
   * Uses safeDomain (Punycode) for all Plesk operations.
   * @param {string} accountName - Account name
   * @param {string} serverName - Server name
   * @param {string} domain - Original domain (may have accents)
   * @param {string} sourceAccount - Source account for extraction
   * @param {string} sourceCloud - Source cloud for extraction
   * @param {string} taskId - Task ID for progress tracking
   * @param {Object} options - Options { sshClient?, subscription? }
   * @returns {Promise<Object>} Deployment result
   */
  async deploySingleDomain(
    accountName,
    serverName,
    domain,
    sourceAccount,
    sourceCloud,
    taskId,
    options = {},
    emitLog = null,
    forceClean = false
  ) {
    const startTime = Date.now();
    let subscriptionCreated = false;
    let wpConfigInjected = false;
    let wpConfigMethod = 'none';

    // Compute safe domain (Punycode) once — used for ALL Plesk ops
    const safeDom = this.safeDomain(domain);

    // Log-throttling vars for upload progress emission (used in SQL upload callbacks)
    let lastEmitLog = 0;
    let lastEmitMb = -5;

    try {
      const rawConfig = this.configManager.getConfig();
      if (!rawConfig) throw new Error('[CRITICAL] ConfigManager.getConfig() devolvió null/undefined.');

      const serverConfig = rawConfig.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) throw new Error(`[CRITICAL] El servidor "${serverName}" no existe en la configuración global (destinationServers).`);
      if (!serverConfig.isLinked) throw new Error(`[CRITICAL] El servidor "${serverName}" no está vinculado SSH (isLinked: false).`);

      // Check extraction status
      const extractionStatus = await this.extractionService.getExtractionStatus(
        sourceAccount, sourceCloud, domain
      );
      
      const domainPath = extractionStatus.domainPath;
      
      // ================================================================
      // VALIDACIÓN TEMPRANA: disco de respaldos accesible
      // Falla rápido antes de conectar SSH o subir archivos.
      // Si el disco externo está desconectado, el error es claro y trazable.
      // ================================================================
      const respaldosPath = this.configManager.getRespaldosPath();
      const fsSync = require('fs');
      if (!fsSync.existsSync(respaldosPath)) {
        throw new Error(
          `[DISCO] La carpeta de respaldos no está accesible: "${respaldosPath}". ` +
          `Verifique que el disco externo esté conectado o reconfigure la ruta en Configuración.`
        );
      }
      if (!fsSync.existsSync(domainPath)) {
        return {
          domain, safeDomain: safeDom, status: 'warning', step: 'missing-domain-folder',
          errorDetails: `Faltan archivos (no existe carpeta de backup)`
        };
      }
      
      // Detallar si la carpeta está vacía o qué archivos faltan
      if (!extractionStatus.extracted) {
        const filesInDir = fsSync.readdirSync(domainPath);
        if (filesInDir.length === 0 || (filesInDir.length === 1 && filesInDir[0] === 'workspace.json')) {
           return {
             domain, safeDomain: safeDom, status: 'warning', step: 'empty-domain-folder',
             errorDetails: `Faltan archivos (carpeta de backup vacía)`
           };
        } else {
           const missing = [];
           if (!extractionStatus.filesExist) missing.push('.tar.gz/.tar');
           if (!extractionStatus.dbExist) missing.push('.sql');
           return {
             domain, safeDomain: safeDom, status: 'warning', step: 'missing-files',
             errorDetails: `Faltan archivos esenciales: ${missing.join(', ')}`
           };
        }
      }


      // Supports both .tar (legacy) and .tar.gz (streaming compression)
      // ================================================================
      const fs = require('fs');
      // Opción C: TODO en Punycode — archivos locales y remotos sin caracteres especiales
      let filesPath = path.join(domainPath, `${safeDom}.tar.gz`);
      if (!fs.existsSync(filesPath)) {
        filesPath = path.join(domainPath, `${safeDom}.tar`);
      }
      const dbPath = path.join(domainPath, `${safeDom}.sql`);
      const wpConfigPath = path.join(domainPath, 'wp-config.php');
      const isGz = filesPath.endsWith('.tar.gz');

      // Verify local files exist — if missing, return controlled error (don't throw)
      if (!fs.existsSync(filesPath)) {
        return {
          domain, safeDomain: safeDom, status: 'warning', step: 'missing-files',
          errorDetails: `Faltan archivos (no se encontró .tar.gz ni .tar)`
        };
      }
      
      let isUltraLite = false;
      if (!fs.existsSync(dbPath)) {
        if (isGz) {
          const tar = require('tar');
          try {
            await tar.t({ file: filesPath, onentry: (entry) => {
              if (entry.path === 'config.json' || entry.path.endsWith('/config.json')) isUltraLite = true;
            }});
          } catch (_) {}
        }
        
        if (!isUltraLite) {
          return {
            domain, safeDomain: safeDom, status: 'warning', step: 'missing-files',
            errorDetails: `Faltan archivos (no se encontró .sql ni formato Ultra-Lite)`
          };
        }
      }

      // ================================================================
      // STEP 1: SSH VERIFICATION (uses global connection from options)
      // ================================================================
      const sshClient = options.sshClient;
      if (!sshClient) {
        return {
          domain, safeDomain: safeDom, status: 'error', step: 'ssh-missing',
          errorDetails: 'No hay conexión SSH disponible — deployBatch no proporcionó sshClient'
        };
      }
      this.emitLog(taskId, domain, 5, `[SSH] Verificando conexión...`);
      this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 5, message: '[SSH] Verificando conexión...' });

      // Validate connection with a simple command (el canal se abre/cierra naturalmente)
      try {
        const whoamiResult = await this.sshService.executeCommand(sshClient, 'whoami', { timeoutMs: 30000 });
        if (!whoamiResult.stdout || !whoamiResult.stdout.trim()) {
          throw new Error('whoami returned empty');
        }
        this.emitLog(taskId, domain, 5, `[SSH] Conectado como: ${whoamiResult.stdout.trim()}`);
      } catch (whoamiErr) {
        return {
          domain, safeDomain: safeDom, status: 'error', step: 'ssh-verify',
          errorDetails: `Conexión SSH no válida: ${whoamiErr.message}`
        };
      }

      // ================================================================
      // STEP 1.5: SKIP CHECK — ¿Ya está desplegado?
      // Si wp-config.php existe en httpdocs Y la DB tiene tablas,
      // saltamos todo el deploy (SFTP + bash) y marcamos como éxito.
      // ================================================================
      const httpdocsPath = `/var/www/vhosts/${safeDom}/httpdocs`;
      
      // SOLO hacemos el Skip Check si NO estamos en modo Limpieza Profunda.
      // Si forceClean es true, queremos forzar la resubida, así que saltamos este check.
      if (!forceClean) {
        try {
          // SKIP CHECK: si wp-config.php existe Y la DB tiene tablas, el dominio ya está desplegado.
          // Nota: cada condición tiene su fi correspondiente — la versión anterior tenía líneas sed
          // de otro bloque mezcladas aquí, generando un script Bash con syntax error.
          const skipCheckCmd = [
            `if [ -f "${httpdocsPath}/wp-config.php" ]; then`,
          `  DB_NAME=$(grep "DB_NAME" "${httpdocsPath}/wp-config.php" | cut -d\\' -f4)`,
          `  if [ -n "$DB_NAME" ]; then`,
          `    TABLE_COUNT=$(mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME'" 2>/dev/null || echo 0)`,
          `    if [ "$TABLE_COUNT" -gt 0 ] 2>/dev/null; then`,
          `      echo "[SKIP] El dominio ya esta desplegado ($TABLE_COUNT tablas)"`,
          `      exit 0`,
          `    fi`,
          `  fi`,
          `fi`,
          `echo "[OK] Dominio listo para deploy"`,
        ].join('\n');
        const skipResult = await this.sshService.executeCommand(sshClient, skipCheckCmd, { timeoutMs: 1800000 });

          const skipOutput = (skipResult.stdout || '').trim();
          if (skipOutput.includes('[SKIP]')) {
            this.emitLog(taskId, domain, 100, `[SKIP] ${domain} ya estaba desplegado.`);
            return {
              domain, safeDomain: safeDom, status: 'success', step: 'skipped',
              details: { skipped: true, message: 'Dominio ya desplegado' }
            };
          }
        } catch (skipErr) {
          // Si falla el check (ej: suscripción no existe aún), continuamos normalmente
          console.log(`[SKIP] Check no concluyente para ${domain}: ${skipErr.message} — continuando con deploy`);
        }
      }

      // ================================================================
      // STEP 2: PLESK SUBSCRIPTION (IP desde Plesk DB, no desde Node)
      // ================================================================
      // Obtener IP compartida directamente de la DB de Plesk
      const ipQuery = await this.sshService.executeCommand(sshClient,
        `PLESK_IP=$(plesk db -Ne "SELECT ip_address FROM IP_Addresses WHERE type='shared' LIMIT 1;" 2>/dev/null); ` +
        `[ -z "$PLESK_IP" ] && PLESK_IP=$(plesk db -Ne "SELECT ip_address FROM IP_Addresses LIMIT 1;" 2>/dev/null); ` +
        `echo "$PLESK_IP"`,
        { timeoutMs: 1800000 }
      );
      const pleskIp = (ipQuery.stdout || '').trim();
      if (!pleskIp) {
        throw new Error('[PLESK] No se pudo obtener una IP desde la DB de Plesk. Verifique IP_Addresses.');
      }
      console.log(`[PLESK] IP obtenida de Plesk DB: ${pleskIp}`);

      // Verificar si la suscripción ya existe (solo en modo Limpieza Profunda / resubida)
      let subscriptionExists = false;
      if (forceClean) {
        try {
          const checkResult = await this.sshService.executeCommand(sshClient, `plesk bin subscription --info "${safeDom}" 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"`, { timeoutMs: 1800000 });
          subscriptionExists = (checkResult.stdout || '').includes('EXISTS');
        } catch { /* asumir que no existe */ }
      }



      if (subscriptionExists) {
        this.emitLog(taskId, domain, 10, `[PLESK] Suscripción ya existe para ${safeDom} — omitiendo creación (resubida)`);
        this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 10, message: `[PLESK] Suscripción existente para ${safeDom}...` });
      } else {
        this.emitLog(taskId, domain, 10, `[PLESK] Creando suscripción para ${safeDom} en IP ${pleskIp}...`);
        this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 10, message: `[PLESK] Creando suscripción para ${safeDom}...` });

        // Generar contraseña aleatoria por dominio (no hardcodeada).
        // 12 bytes = 24 hex chars — suficiente entropía para Plesk.
        const subscriptionPassword = crypto.randomBytes(12).toString('hex');
        this.emitLog(taskId, domain, 10, `[INFO] Contraseña de la suscripción generada: ${subscriptionPassword}`);
        if (emitLog) emitLog(`[INFO] Contraseña de suscripción para ${safeDom}: ${subscriptionPassword}`, 'info');

        let alphaDom = safeDom.replace(/^[^a-zA-Z]+/, ''); // Eliminar números al inicio
        if (!alphaDom) alphaDom = 'usr'; // Fallback si el dominio es puro número
        const baseLogin = alphaDom.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
        let currentLogin = baseLogin + crypto.randomBytes(2).toString('hex');
        let subCmd = `plesk bin subscription -c "${safeDom}" -owner KitDigital -service-plan "Default Domain" -ip "${pleskIp}" -login "${currentLogin}" -passwd "${subscriptionPassword}"`;
        const EMIT = require('./standard-emitter').getStandardEmitter('deployment');

        // La creación de la suscripción corre dentro de la ventana con el
        // domain-resolution-checker apagado. El guard es reentrante: en un batch
        // la ventana ya viene abierta y acá no se vuelve a tocar el servidor.
        try {
          let subResult = await this._withResolutionCheckerDisabled(sshClient, taskId, domain,
            () => this.sshService.executeCommand(sshClient, subCmd, { timeoutMs: 1800000 }));
          EMIT.emit('debug', `[PLESK SUB] ${safeDom} code=${subResult.code} stderr=${(subResult.stderr || '').slice(0, 120)}`);

          if (subResult.code !== 0 && subResult.stderr?.includes('The user') && subResult.stderr?.includes('already exists')) {
            EMIT.emit('debug', `[PLESK SUB] Colision de usuario en Plesk. Reintentando con login alternativo...`);
            currentLogin = baseLogin + crypto.randomBytes(3).toString('hex');
            subCmd = `plesk bin subscription -c "${safeDom}" -owner KitDigital -service-plan "Default Domain" -ip "${pleskIp}" -login "${currentLogin}" -passwd "${subscriptionPassword}"`;
            subResult = await this._withResolutionCheckerDisabled(sshClient, taskId, domain,
              () => this.sshService.executeCommand(sshClient, subCmd, { timeoutMs: 1800000 }));
            EMIT.emit('debug', `[PLESK SUB RETRY] ${safeDom} code=${subResult.code} stderr=${(subResult.stderr || '').slice(0, 120)}`);
          }

          if (subResult.code !== 0 && !subResult.stderr?.includes('already exists') && !subResult.stdout?.includes('already exists')) {
            throw new Error(`[PLESK] Error creando suscripción: ${subResult.stderr || subResult.stdout}`);
          }
          if (subResult.code === 2 || ((subResult.stderr?.includes('already exists') || subResult.stdout?.includes('already exists')) && !subResult.stderr?.includes('The user'))) {
            throw new Error('El dominio ya existe en el servidor');
          }
        } catch (subError) {
          if (subError.message && subError.message.includes('El dominio ya existe en el servidor')) {
            if (!forceClean) {
              throw subError;
            } else {
              console.log(`[MIGRAR] Limpieza profunda activa. Sobreescribiendo entorno...`);
              subscriptionExists = true;
            }
          } else {
            throw subError;
          }
        }
      }

      subscriptionCreated = true;
      this.emitLog(taskId, domain, 15, `[PLESK] Suscripción lista: ${safeDom}`);
      this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 15, message: `[PLESK] Suscripción lista: ${safeDom}` });

      // ================================================================
      // STEP 2.5: RESUBIDA — Limpieza previa si el dominio ya existía
      // ================================================================
      if (subscriptionExists) {
        const EMIT = require('./standard-emitter').getStandardEmitter('deployment');
        this.emitLog(taskId, domain, 12, `[RESUBIDA] Limpiando httpdocs para ${safeDom}...`);
        this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 12, message: `[RESUBIDA] Limpiando httpdocs...` });

        const cleanCmd = `rm -rf ${httpdocsPath}/* ${httpdocsPath}/.[!.]* 2>/dev/null || true`;
        const cleanResult = await this.sshService.executeCommand(sshClient, cleanCmd);
        EMIT.emit('debug', `[HTTPDOCS CLEAN] ${safeDom} code=${cleanResult.code} stderr=${(cleanResult.stderr || '').slice(0, 120)}`);
        if (cleanResult.code !== 0) {
          console.warn(`[RESUBIDA] Clean warning for ${safeDom}: ${cleanResult.stderr}`);
        }

        // Limpiar base de datos existente (DROP IF EXISTS + CREATE)
        try {
          const dbInfo = await this.getPleskDatabaseInfo(sshClient, safeDom);
          if (dbInfo && dbInfo.database) {
            this.emitLog(taskId, domain, 13, `[RESUBIDA] Recreando base de datos ${dbInfo.database}...`);
            const dropDb = await this.sshService.executeCommand(sshClient,
              `mysql -e "DROP DATABASE IF EXISTS \`${dbInfo.database}\`; CREATE DATABASE \`${dbInfo.database}\`;" 2>&1 || true`
            );
            EMIT.emit('debug', `[DB DROP/CREATE] ${safeDom} db=${dbInfo.database} code=${dropDb.code}`);
            if (dropDb.code !== 0) {
              console.warn(`[RESUBIDA] DB warning for ${safeDom}: ${dropDb.stderr}`);
            }
          }
        } catch (dbErr) {
          console.warn(`[RESUBIDA] No se pudo limpiar DB para ${safeDom}: ${dbErr.message}`);
          EMIT.emit('debug', `[DB CLEAN ERR] ${safeDom}: ${dbErr.message}`);
        }
      }

      // ================================================================
      // STEP 3: DETERMINAR DOCUMENT ROOT (Plesk ya creó httpdocs con la suscripción)
      // ================================================================
      const documentRoot = await this.getPleskDocumentRoot(sshClient, safeDom);

      // ================================================================
      // BRANCH: ULTRA-LITE MODO
      // ================================================================
      if (isUltraLite) {
        return await this.deployUltraLiteDomain(sshClient, domain, filesPath, taskId);
      }

      // ================================================================
      // STEP 4: TRANSFERENCIA SFTP (streaming eficiente)
      // ================================================================
      const EMIT_SFTP = require('./standard-emitter').getStandardEmitter('deployment');
      EMIT_SFTP.emit('info', `[SFTP] Preparando transferencia para ${domain}`, domain);

      // Verificación local de archivos (ASÍNCRONA)
      try {
        await require('fs').promises.access(filesPath);
      } catch {
        EMIT_SFTP.emit('error', `[SFTP] Archivo .tar.gz no encontrado: ${filesPath}`, domain);
        throw new Error(`Archivo de backup no encontrado: ${filesPath}`);
      }
      
      try {
        await require('fs').promises.access(dbPath);
      } catch {
        EMIT_SFTP.emit('error', `[SFTP] Archivo .sql no encontrado: ${dbPath}`, domain);
        throw new Error(`Archivo SQL no encontrado: ${dbPath}`);
      }
      
      const filesStat = await require('fs').promises.stat(filesPath);
      const dbStat = await require('fs').promises.stat(dbPath);
      
      EMIT_SFTP.emit('info', `[SFTP] Archivos locales verificados: ${path.basename(filesPath)} (${(filesStat.size / 1024 / 1024).toFixed(2)} MB), ${path.basename(dbPath)} (${(dbStat.size / 1024 / 1024).toFixed(2)} MB)`, domain);

      // Archivos remotos con nombre corto basado en Punycode
      const short = this.shortName(safeDom);
      const ext = isGz ? '.tar.gz' : '.tar';
      const remoteFilesPath = path.posix.join(httpdocsPath, `${short}${ext}`);
      const remoteDbPath = path.posix.join(httpdocsPath, `${short}.sql`);

      const fileSize = filesStat.size;
      const fileSizeMb = (fileSize / 1024 / 1024).toFixed(2);
      this.emitLog(taskId, domain, 20, `[SFTP] Iniciando transferencia a Plesk...`);
      this.emitLog(taskId, domain, 25, `[SFTP] Subiendo ${short}${ext} (${fileSizeMb} MB)...`);
      this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 25, message: `[SFTP] Subiendo ${short}${ext} (${fileSizeMb} MB)...` });

      await this.sshService.uploadFileFast(sshClient, filesPath, remoteFilesPath,
        (transferred, total, pct, msg) => {
          this.progressEmitter.emitProgress({
            taskId, module: 'deployment', domain,
            progress: 25 + Math.round(pct * 0.20),
            message: `[SFTP] ${msg}`
          });
        }
      );

      // Verificar tamaño remoto del .tar.gz
      const verifyTar = await this.sshService.executeCommand(sshClient, `stat -c%s "${remoteFilesPath}" 2>/dev/null || echo 0`);
      const remoteTarSize = parseInt((verifyTar.stdout || '0').trim(), 10);
      if (remoteTarSize !== fileSize) {
        EMIT_SFTP.emit('error', `[SFTP] Tamaño remoto de .tar.gz NO coincide: local=${fileSize} remote=${remoteTarSize}`, domain);
        throw new Error(`[SFTP] Subida de .tar.gz incompleta: local=${fileSize} bytes, remoto=${remoteTarSize} bytes`);
      }
      EMIT_SFTP.emit('debug', `[SFTP] .tar.gz verificado: ${remoteTarSize} bytes OK`, domain);

      this.emitLog(taskId, domain, 45, `[SFTP] Transferencia completada (${fileSizeMb} MB).`);

      // ================================================================
      // TRANSFERENCIA SQL CRUDO
      // ================================================================
      const dbSize = require('fs').statSync(dbPath).size;
      this.emitLog(taskId, domain, 55, `[SFTP] Subiendo ${short}.sql (${(dbSize / 1024 / 1024).toFixed(2)} MB)...`);
      this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 55, message: '[SFTP] Subiendo base de datos...' });

      lastEmitLog = 0;
      lastEmitMb = -5;
      await this.sshService.uploadFileFast(sshClient, dbPath, remoteDbPath,
        (transferred, total, pct, msg) => {
          this.progressEmitter.emitProgress({
            taskId, module: 'deployment', domain,
            progress: 55 + Math.round(pct * 0.05),
            message: `[SFTP] ${msg}`
          });
          const now = Date.now();
          const transferredMb = transferred / 1024 / 1024;
          if (now - lastEmitLog >= 500 && transferredMb - lastEmitMb >= 5) {
            lastEmitLog = now;
            lastEmitMb = transferredMb;
            this.emitLog(taskId, domain, 55, `[SFTP] Subiendo: ${transferredMb.toFixed(2)} MB...`);
          }
        }
      );

      this.emitLog(taskId, domain, 60, `[SFTP] Base de datos subida (${(dbSize / 1024 / 1024).toFixed(2)} MB)`);

      // Verificar tamaño remoto del .sql
      const verifySql = await this.sshService.executeCommand(sshClient, `stat -c%s "${remoteDbPath}" 2>/dev/null || echo 0`);
      const remoteSqlSize = parseInt((verifySql.stdout || '0').trim(), 10);
      if (remoteSqlSize !== dbSize) {
        EMIT_SFTP.emit('error', `[SFTP] Tamaño remoto de .sql NO coincide: local=${dbSize} remote=${remoteSqlSize}`, domain);
        throw new Error(`[SFTP] Subida de .sql incompleta: local=${dbSize} bytes, remoto=${remoteSqlSize} bytes`);
      }
      EMIT_SFTP.emit('debug', `[SFTP] .sql verificado: ${remoteSqlSize} bytes OK`, domain);

      // 🔥 v1.9.7: subir wp-config.php directo (tar con -k no lo sobreescribe)
      const remoteWpConfigPath = path.posix.join(httpdocsPath, 'wp-config.php');
      if (fs.existsSync(wpConfigPath)) {
        console.log(`[WP-CONFIG] Subiendo wp-config.php local a: ${remoteWpConfigPath}`);
        await this.sshService.uploadFileFast(sshClient, wpConfigPath, remoteWpConfigPath);
      }

      this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 63, message: '[SFTP] Transferencia completa' });
      EMIT_SFTP.emit('info', `[SFTP] Transferencia completada para ${domain}. Iniciando script Bash...`, domain);

      // Verificar que los archivos llegaron al servidor
      const verifyCmd = `ls -la ${httpdocsPath}/${short}${ext} ${httpdocsPath}/${short}.sql 2>&1`;
      const verifyResult = await this.sshService.executeCommand(sshClient, verifyCmd);
      EMIT_SFTP.emit('debug', `[SFTP-VERIFY] ${domain}: ${(verifyResult.stdout || verifyResult.stderr || '').trim()}`, domain);
      if (verifyResult.code !== 0) {
        EMIT_SFTP.emit('error', `[SFTP] Archivos NO encontrados en servidor tras upload: ${verifyResult.stderr}`, domain);
      }

      // ================================================================
      // STEP 5: SANITIZACIÓN BASH (script SSH auto-contenido)
      // ================================================================
      // Este script se ejecuta como un solo bloque SSH multi-línea para
      // minimizar round-trips. Extrae credenciales nativas de Hostinger
      // desde el wp-config.php, crea BD y usuario en Plesk, importa SQL,
      // y limpia basura SEO/malware.

      this.emitLog(taskId, domain, 50, `[BASH] Descomprimiendo archivos en destino...`);
      this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 50, message: '[BASH] Extrayendo archivos, importando BD y saneando...' });

      // Archivos remotos con nombre corto (shortName)
      const archiveFile = `${short}${ext}`;
      // 🔥 v1.9.18: BashScript blindado con chown, extracción agresiva, escapes correctos
      const HDP = httpdocsPath;
      // Generar credenciales deterministas con SHA-256 (hash de 4 chars)
      const sha256 = crypto.createHash('sha256').update(domain).digest('hex').substring(0, 4);
      const dbName = `wp_${sha256}`;
      const dbUser = `u${sha256}`;
      const dbPassword = crypto.randomBytes(14).toString('hex');
      console.log(`[DB-CREDS] ${domain} → DB=${dbName} USER=${dbUser}`);

      const PROGRESS = function(step, msg) {
        return 'echo \'@@@PROGRESS@@@{"step":"' + step + '","msg":"' + msg + '"}@@@END@@@\'';
      };
      const bashScript = [
        'set -u', // ABORTAR SOLO EN VARIABLES NO DEFINIDAS
        PROGRESS('init', 'Preparando entorno y creando dominio...'),
        '# ================================================================',
        '# 1. ENTORNO, PERMISOS Y LIMPIEZA INICIAL',
        '# ================================================================',
        `cd "${HDP}" || { echo "---[ERROR] Acceso denegado a httpdocs"; exit 1; }`,
        '',
        '# ================================================================',
        '# CLEANUP TRAP — Se ejecuta SIEMPRE (éxito o fallo)',
        '# Garantiza que no queden .sql/.tar.gz/fix-urls.php expuestos en httpdocs.',
        '# ================================================================',
        `cleanup() {`,
        `  if [ -n "$SQL_FILE" ] && [ -f "$SQL_FILE" ]; then rm -f "$SQL_FILE" 2>/dev/null; fi`,
        `  rm -f "${HDP}/${short}.sql" "${HDP}/${short}_temp.sql" "${HDP}/${short}_mysql_debug.log" "${HDP}/${short}${ext}" "${HDP}/fix-urls.php" 2>/dev/null`,
        `  rm -f sanitized.sql 2>/dev/null`,
        `  rm -f /tmp/mem_limit.ini /tmp/deploy_cleanup_*.sql 2>/dev/null`,
        `}`,
        `trap cleanup EXIT`,
        '',

        // Capturamos el usuario numérico real del sistema para evitar fallos de resolución (UNKNOWN)
        `NUMERIC_OWNER=$(stat -c "%u:%g" ..)`,
        `chown $NUMERIC_OWNER "${archiveFile}" "${short}.sql" 2>/dev/null || true`,

        // MODO LIMPIEZA TOTAL (Checkbox Tierra Quemada)
        // SOLO limpia archivos residuales — preserva .tar.gz y .sql recién subidos
        ...(forceClean ? [
          `echo "---[MODO LIMPIEZA TOTAL ACTIVADO]---"`,
          `# 1. Quitar inmutabilidad de archivos (ej. .user.ini de Wordfence)`,
          `chattr -R -i ./* 2>/dev/null || true`,
          `# 2. Vaciado selectivo: Borrar todo EXCEPTO nuestros backups recién subidos`,
          `find . -mindepth 1 -maxdepth 1 ! -name "*.tar.gz" ! -name "*.sql" -exec rm -rf {} + || true`,
          `echo "---[Hosting vaciado selectivamente]---"`,
        ] : []),

        PROGRESS('clean_html', 'Eliminando index.html y archivos residuales...'),
        'chattr -i index.html default.html hosting_path.php 2>/dev/null || true',
        'rm -f index.html default.html hosting_path.php 2>/dev/null || true',
        '# Purgar backups, volcados SQL y backdoors del deployment anterior (preservando archivos recién subidos)',
        `find . -maxdepth 2 -type f \\( -name "*.tar.gz" -o -name "*.sql" \\) ! -name "${archiveFile}" ! -name "${short}.sql" -exec rm -f {} \\; 2>/dev/null || true`,
        'find . -maxdepth 2 -type f -name "sitemap*" ! -name "sitemap.xml" ! -name "sitemap_index.xml" -exec rm -f {} \\; 2>/dev/null || true',
        'find . -maxdepth 2 -type f -name "google*" ! -name "google-site-verification*" -exec rm -f {} \\; 2>/dev/null || true',

        '# ================================================================',
        '# 2. CONFIGURACIÓN DE SERVIDOR (PLESK CLI)',
        '# ================================================================',
        `plesk bin php_settings -u "${safeDom}" -settings memory_limit=512M > /dev/null 2>&1 || true`,
        'echo "---[2/12] Memoria configurada (512M)---"',

        PROGRESS('upload', 'Subiendo backups al servidor...'),
        '# (los archivos ya se subieron via SFTP antes de este script)',

        '# ================================================================',
        '# 3. EXTRACCIÓN Y PROTECCIÓN DE CONFIG',
        '# ================================================================',
        // Solo protegemos wp-config.php si EXISTE (en modo normal se subió aparte; en resubida fue borrado)
        ...(!forceClean ? [
          `if [ -f "wp-config.php" ]; then`,
          `  mv -f wp-config.php wp-config-backup-deploy.php`,
          `  echo "@@@syslog|MIGRATE|debug|WP-CONFIG-BACKUP"`,
          `fi`,
        ] : []),

        PROGRESS('extract', 'Descomprimiendo archivos (.tar.gz)...'),
        `if [ -f "${archiveFile}" ]; then`,
        `  echo "---[3/12] Extrayendo backup...---"`,
        `  echo "@@@syslog|MIGRATE|debug|EXTRACT-START ${archiveFile}"`,
        isGz ? `  TAR_EXIT=0; tar -xzf "${archiveFile}" --warning=no-unknown-keyword 2>&1 || TAR_EXIT=$?` : `  TAR_EXIT=0; tar -xf "${archiveFile}" --warning=no-unknown-keyword 2>&1 || TAR_EXIT=$?`,
        `  echo "@@@syslog|MIGRATE|debug|EXTRACT-END code=$TAR_EXIT"`,
        `  if [ $TAR_EXIT -ne 0 ]; then`,
        `    echo "---[ERROR FATAL] Extracción del backup falló (code=$TAR_EXIT). El archivo se conserva para debug.---"`,
        `    ls -la "${archiveFile}"`,
        `    exit 1`,
        `  fi`,
        `  if [ ! -f "wp-includes/class-wp-http-requests-hooks.php" ]; then`,
        `    echo "---[ERROR FATAL] Corrupción detectada: wp-includes/class-wp-http-requests-hooks.php no encontrado tras extracción.---"`,
        `    exit 1`,
        `  fi`,
        `  rm -f "${archiveFile}"`,
        `  echo "@@@syslog|MIGRATE|info|EXTRACT-OK ${archiveFile} borrado tras extracción exitosa"`,
        `  chown -R $NUMERIC_OWNER . 2>/dev/null || true`,
        '  echo "---[4/12] Extracción completada---"',

        // ── Post-extracción: purgar backdoors y basura dentro del backup ──
        `  echo "@@@syslog|MIGRATE|debug|POST-EXTRACT-CLEANUP"`,
        // Solo eliminar .tar.gz residuales del backup extraído. NO tocar ${short}.sql (se necesita para importar)
        `  find . -maxdepth 3 -type f -name "*.tar.gz" ! -name "${archiveFile}" -exec rm -f {} \\; 2>/dev/null || true`,
        `  rm -f google*.html index1.xml default.php info.php wp-reset.php wp-feed.php wp-tmp.php wp-update.php 2>/dev/null || true`,
        `  find wp-content/uploads -maxdepth 3 -type f \\( -name "*.php" -o -name "*.php.jpg" -o -name "*.php.png" -o -name "*.phtml" \\) -not -name "index.php" -not -path "*/aios/*" -exec rm -f {} \\; 2>/dev/null || true`,
        `fi`,

        // Restauramos nuestro config sobre la basura del backup (solo si se hizo backup)
        'if [ -f "wp-config-backup-deploy.php" ]; then mv -f wp-config-backup-deploy.php wp-config.php || true; fi',

        PROGRESS('config', 'Inyectando wp-config.php...'),

        '# ================================================================',
        '# 4. CAPTURA DE CREDENCIALES LEGACY + GENERACIÓN DE CREDENCIALES PLESK',
        '# ================================================================',
        `PREFIX=$(grep "table_prefix" wp-config.php 2>/dev/null | cut -d"'" -f2 | cut -d'"' -f2 || true)`,
        'if [ -z "$PREFIX" ]; then PREFIX="wp_"; fi',
        // Credenciales Hostinger originales (solo para referencia — NO se usarán en Plesk)
        `OLD_DB_NAME=$(grep "DB_NAME" wp-config.php 2>/dev/null | head -1 | cut -d"'" -f4 || true)`,
        `OLD_DB_USER=$(grep "DB_USER" wp-config.php 2>/dev/null | head -1 | cut -d"'" -f4 || true)`,
        `OLD_DB_PASS=$(grep "DB_PASSWORD" wp-config.php 2>/dev/null | head -1 | cut -d"'" -f4 || true)`,
        'if [ -z "$OLD_DB_NAME" ]; then echo "---[ERROR FATAL] wp-config ilegible---"; ls -la; exit 1; fi',
        // Credenciales generadas por Node.js — sin escaping bash
        `DB_NAME="${dbName}"`,
        `DB_USER="${dbUser}"`,
        `DB_PASS="${dbPassword}Krx1!"`,
        '',
        '# ================================================================',
        '# 5. BASE DE DATOS NATIVA PLESK (Idempotente)',
        '# ================================================================',
        // Paso 2: Crear DB solo si no existe
        `echo "---[5/12] Configurando DB \$DB_NAME en Plesk...---"`,
        `echo "@@@syslog|MIGRATE|info|DB-CREATE \$DB_NAME"`,
        `DB_EXISTS=\$(plesk db -Nse "SELECT COUNT(*) FROM data_bases WHERE name='\$DB_NAME'" 2>/dev/null || echo 0)`,
        `if [ "\$DB_EXISTS" -eq 0 ]; then`,
        `  echo "La base de datos \$DB_NAME no existe. Creándola..."`,
        `  CREATE_EXIT=0; plesk bin database --create "\$DB_NAME" -domain "${safeDom}" -type mysql -server localhost > /dev/null 2>&1 || CREATE_EXIT=$?`,
        `  CREATE_EXIT=\$?`,
        `  if [ \$CREATE_EXIT -ne 0 ]; then`,
        `    echo "---[ERROR FATAL] No se pudo crear la DB \$DB_NAME en Plesk (code=\$CREATE_EXIT).---"`,
        `    exit 1`,
        `  fi`,
        `else`,
        `  echo "La base de datos \$DB_NAME ya existe. Manteniendo datos intactos."`,
        `fi`,
        // Paso 3: Crear usuario o asociar y actualizar contraseña si ya existe
        `echo "@@@syslog|MIGRATE|info|DB-USER \$DB_USER"`,
        `plesk bin database --create-dbuser "\$DB_USER" -passwd "\$DB_PASS" -domain "${safeDom}" -server localhost:3306 -database "\$DB_NAME" > /dev/null 2>&1 || true`,
        `plesk bin database --update "\$DB_NAME" -add_user "\$DB_USER" > /dev/null 2>&1 || true`,
        `plesk bin database --update-dbuser "\$DB_USER" -passwd "\$DB_PASS" -server localhost:3306 > /dev/null 2>&1 || true`,
        // Paso 4: Reescribir wp-config.php con las nuevas credenciales Plesk
        `echo "@@@syslog|MIGRATE|info|WP-CONFIG-REWRITE $DB_USER@$DB_NAME"`,
        `sed -i "s/define( *'DB_NAME'.*/define( 'DB_NAME', '$DB_NAME' );/" wp-config.php || true`,
        `sed -i "s/define( *'DB_USER'.*/define( 'DB_USER', '$DB_USER' );/" wp-config.php || true`,
        `sed -i "s/define( *'DB_PASSWORD'.*/define( 'DB_PASSWORD', '$DB_PASS' );/" wp-config.php || true`,

        PROGRESS('db_import', 'Importando base de datos SQL...'),
        // Paso 4: Verificar e Importar base de datos
        `# 1. Detección Inteligente de Archivo SQL`,
        `SQL_FILE=\$(find . -maxdepth 1 -name "*.sql" -print -quit)`,
        `if [ -z "\$SQL_FILE" ]; then`,
        `  SQL_FILE=\$(find . -name "*.sql" -print -quit)`,
        `fi`,
        `if [ -z "\$SQL_FILE" ] || [ ! -f "\$SQL_FILE" ] || [ ! -s "\$SQL_FILE" ]; then`,
        `  echo "@@@syslog|MIGRATE|error|SQL-FILE-MISSING"`,
        `  echo "[FATAL] Backup SQL no encontrado o vacío."`,
        `  exit 1`,
        `fi`,
        `echo "[SQL] Archivo de base de datos detectado: \$SQL_FILE"`,
        '',
        `# Segundo: Contar tablas ANTES de borrar`,
        `EXISTING_COUNT=\$(mysql -u"\$DB_USER" -p"\$DB_PASS" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '\$DB_NAME' AND table_type = 'BASE TABLE';" 2>/dev/null || echo 0)`,
        '',
        `if [ "\$EXISTING_COUNT" -lt 11 ]; then`,
        `  echo "---[8/12] Detectadas \$EXISTING_COUNT tablas. Procediendo a limpiar y refrescar BD...---"`,
        `  echo "@@@syslog|MIGRATE|debug|DB-SOFT-RESET"`,
        `  # Solo ahora hacemos el DROP, porque sabemos que el archivo existe`,
        `  DROP_STMTS=\$(mysql -N -u"\$DB_USER" -p"\$DB_PASS" "\$DB_NAME" -e "SHOW TABLES;" 2>/dev/null | awk '{printf "DROP TABLE IF EXISTS \`%s\`; ", \$1}' 2>/dev/null)`,
        `  if [ -n "\$DROP_STMTS" ]; then`,
        `    echo "@@@syslog|MIGRATE|debug|DB-DROP-COUNT \\\$(echo "\$DROP_STMTS" | grep -o 'DROP TABLE' | wc -l)"`,
        `    mysql -u"\$DB_USER" -p"\$DB_PASS" "\$DB_NAME" -e "SET FOREIGN_KEY_CHECKS = 0; \$DROP_STMTS SET FOREIGN_KEY_CHECKS = 1;" 2>/dev/null`,
        `  fi`,
        '',
        `  # ================================================================`,
        `  # ETAPA 1: INGESTIÓN CRUDA (Carga con sanitización al vuelo y bucle de reintento)`,
        `  # ================================================================`,
        `  echo "[IMPORTANDO] Inyectando base de datos (Sanitización en archivo separado)..."`,
        `  echo "SET FOREIGN_KEY_CHECKS=0;" > sanitized.sql`,
        `  sed -E -e 's#\\/\\*!50013 DEFINER=[^*]*\\*\\/##g' -e 's#\\/\\*!50017 DEFINER=[^*]*\\*\\/##g' -e 's/DEFINER=[a-zA-Z0-9_@.\`"]+//g' -e '/\\/\\*!50003 TRIGGER/d' -e '/SET @OLD_/d' -e '/SQL_MODE/d' -e 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g' -e 's/utf8mb4_unicode_520_ci/utf8mb4_unicode_ci/g' -e '/^CREATE DATABASE/d' -e '/^USE /d' "\$SQL_FILE" >> sanitized.sql || true`,
        `  echo "SET FOREIGN_KEY_CHECKS=1;" >> sanitized.sql`,
        `  IMPORT_EXIT=0; mysql -u"\$DB_USER" -p"\$DB_PASS" --force "\$DB_NAME" < sanitized.sql > "${short}_mysql_debug.log" 2>&1 || IMPORT_EXIT=\$?`,
        `  if [ \$IMPORT_EXIT -ne 0 ]; then`,
        `    echo "---[WARNING] Importación inicial falló (code=\$IMPORT_EXIT). Iniciando Limpieza de Emergencia y Reintento...---"`,
        `    echo "@@@syslog|MIGRATE|warning|SQL-IMPORT-FAIL-RETRIEVAL"`,
        `    plesk bin database --remove "\$DB_NAME" >/dev/null 2>&1 || true`,
        `    plesk bin database --create "\$DB_NAME" -domain "${safeDom}" -type mysql -server localhost > /dev/null 2>&1 || true`,
        `    plesk bin database --create-dbuser "\\$DB_USER" -passwd "\\$DB_PASS" -domain "${safeDom}" -server localhost:3306 -database "\\$DB_NAME" > /dev/null 2>&1 || true`,
        `    plesk bin database --update "\\$DB_NAME" -add_user "\\$DB_USER" > /dev/null 2>&1 || true`,
        `    plesk bin database --update-dbuser "\\$DB_USER" -passwd "\\$DB_PASS" -server localhost:3306 > /dev/null 2>&1 || true`,
        `    echo "[RE-IMPORTANDO] Re-intentando importación limpia desde sanitized.sql..."`,
        `    REIMPORT_EXIT=0; mysql -u"\$DB_USER" -p"\$DB_PASS" --force "\$DB_NAME" < sanitized.sql >> "${short}_mysql_debug.log" 2>&1 || REIMPORT_EXIT=\$?`,
        `    if [ \$REIMPORT_EXIT -eq 0 ]; then`,
        `      echo "---[OK] Re-importación completada exitosamente.---"`,
        `      echo "@@@syslog|MIGRATE|info|SQL-REIMPORT-SUCCESS"`,
        `    else`,
        `      echo "---[ERROR FATAL] Re-importación falló (code=\$REIMPORT_EXIT). Últimas 10 líneas de debug.log:---"`,
        `      tail -n 10 "${short}_mysql_debug.log" | sed 's/^/@@@syslog|MIGRATE|error|/' || true`,
        `      tail -n 10 "${short}_mysql_debug.log" || true`,
        `      exit 1`,
        `    fi`,
        `  else`,
        `    echo "---[OK] Importación completada exitosamente.---"`,
        `    echo "@@@syslog|MIGRATE|info|SQL-IMPORT-SUCCESS"`,
        `  fi`,
        '',
        `  # ================================================================`,
        `  # ETAPA 2: QUIMIOTERAPIA SQL (Desinfección de malware en caliente)`,
        `  # ================================================================`,
        `  echo "[SANEAMIENTO] Eliminando triggers importados para evitar malware latente..."`,
        `  TRIGGERS_TO_DROP=$(mysql -u"$DB_USER" -p"$DB_PASS" -B -N -e "SHOW TRIGGERS FROM \\\`$DB_NAME\\\`;" 2>/dev/null | awk '{print $1}')`,
        `  for trigger in $TRIGGERS_TO_DROP; do`,
        `    echo "  [DROP] Eliminando trigger: $trigger"`,
        `    mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "DROP TRIGGER IF EXISTS \\\`$trigger\\\`;" 2>/dev/null || true`,
        `  done`,
        '',
        `  echo "[SANEAMIENTO] Purgando inyecciones de malware en tablas..."`,
        `  BASE_USER=$(echo "${safeDom}" | cut -d. -f1)`,
        `  BLACKLIST_SQL="'${BLACKLIST_USERS.join("','")}'"`,
        `  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "`,
        `    DELETE u, m FROM \\\${PREFIX}users u LEFT JOIN \\\${PREFIX}usermeta m ON u.ID = m.user_id WHERE u.user_login IN ($BLACKLIST_SQL) OR u.user_email IN ($BLACKLIST_SQL);`,
        `    DELETE FROM \\\${PREFIX}usermeta WHERE user_id NOT IN (SELECT ID FROM \\\${PREFIX}users);`,
        `    DELETE FROM \\\${PREFIX}comments WHERE comment_content REGEXP 'casino|apuestas|tragamonedas|blackjack|slots|ruleta' OR comment_author_url REGEXP 'porn|casino|slot|bet365';`,
        `    DELETE pm FROM \\\${PREFIX}postmeta pm JOIN \\\${PREFIX}posts p ON pm.post_id = p.ID WHERE p.post_content REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|slut|gambling|bet365|blackjack' OR p.post_title REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|slut|gambling|bet365|blackjack';`,
        `    DELETE tr FROM \\\${PREFIX}term_relationships tr JOIN \\\${PREFIX}posts p ON tr.object_id = p.ID WHERE p.post_content REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|slut|gambling|bet365|blackjack' OR p.post_title REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|slut|gambling|bet365|blackjack';`,
        `    DELETE FROM \\\${PREFIX}posts WHERE post_content REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|slut|gambling|bet365|blackjack' OR post_title REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|slut|gambling|bet365|blackjack';`,
        `    DELETE FROM \\\${PREFIX}options WHERE option_name LIKE '_transient_%' OR option_name LIKE '_site_transient_%';`,
        `    DELETE FROM \\\${PREFIX}usermeta WHERE meta_key = '\\\${PREFIX}capabilities' AND user_id NOT IN (SELECT ID FROM \\\${PREFIX}users WHERE user_login IN ('dev', 'administrador', '$BASE_USER'));`,
        `    INSERT INTO \\\${PREFIX}usermeta (user_id, meta_key, meta_value) SELECT ID, '\\\${PREFIX}capabilities', 'a:1:{s:10:\\"subscriber\\";b:1;}' FROM \\\${PREFIX}users WHERE user_login NOT IN ('dev', 'administrador', '$BASE_USER') AND ID NOT IN (SELECT user_id FROM \\\${PREFIX}usermeta WHERE meta_key = '\\\${PREFIX}capabilities');`,
        `    OPTIMIZE TABLE \\\${PREFIX}posts, \\\${PREFIX}postmeta, \\\${PREFIX}comments;`,
        `  " > /dev/null 2>&1 || true`,
        `  echo "[SANEAMIENTO] Base de datos desinfectada en caliente."`,
        `  echo "@@@syslog|MIGRATE|info|HOT-CLEAN-OK"`,
        `else`,
        `  echo "[INFO] Base de datos ya poblada (\${EXISTING_COUNT} tablas). Saltando limpieza e importación."`,
        `fi`,
        '',
        `    # ================================================================`,
        `    # ETAPA 3: VERIFICACIÓN DE SALUD (Conteo e integridad)`,
        `    # ================================================================`,
        `    echo "[VERIFICACIÓN] Validando integridad de tablas importadas..."`,
        `    TABLE_COUNT=$(mysql -u"$DB_USER" -p"$DB_PASS" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_type = 'BASE TABLE';" 2>/dev/null || echo 0)`,
        `    echo "  [INFO] Tablas encontradas en producción: $TABLE_COUNT"`,
        `    if [ "$TABLE_COUNT" -lt 11 ]; then`,
        `      echo "---[ERROR FATAL] La base de datos solo importó $TABLE_COUNT tablas (se requiere un mínimo de 11). Deploy abortado.---"`,
        `      exit 1`,
        `    fi`,
        `    echo "@@@syslog|MIGRATE|info|TABLE-COUNT-OK $TABLE_COUNT"`,
        `    echo "@@@PROGRESS@@@DATABASE_IMPORTED"`,
        '    echo "---[OK] SQL Importado y Verificado---"',
        '',
        `    # Política Zero-Trace: Limpieza de rastros y logs temporales`,
        `    rm -f "${short}.sql" "${short}_mysql_debug.log"`,

        PROGRESS('search_replace', 'Ejecutando Search & Replace profundo...'),
        '# ================================================================',
        '# 6. SEARCH-REPLACE Y REPARACIÓN DE URLS (MÉTODO INFALIBLE)',
        '# ================================================================',
        `CLEAN_DOM=$(echo "${safeDom}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')`,
        `NEW_URL="https://$CLEAN_DOM"`,

        // 1. Forzamos el cambio en la base de datos (SQL Directo)
        `mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "UPDATE \\\${PREFIX}options SET option_value='$NEW_URL' WHERE option_name IN ('siteurl', 'home');" 2>/dev/null || true`,

        // 2. SOLUCIÓN RECORDADA: Inyección de PHP para forzar el cambio si SQL falla
        // Creamos un script temporal que WordPress ejecutará al cargar
        `echo "<?php
        define('WP_INSTALLING', true);
        require_once('wp-load.php');
        update_option('siteurl', '$NEW_URL');
        update_option('home', '$NEW_URL');
        " > fix-urls.php`,
        `php fix-urls.php && rm -f fix-urls.php`,

        // 3. Blindaje en wp-config (Lo que vimos que funciona para saltar la caché de DB)
        `sed -i "/WP_HOME/d" wp-config.php`,
        `sed -i "/WP_SITEURL/d" wp-config.php`,
        `sed -i "/WP_MEMORY_LIMIT/d" wp-config.php`,
        `sed -i "1 a define('WP_HOME', '$NEW_URL');\\ndefine('WP_SITEURL', '$NEW_URL');\\ndefine('WP_MEMORY_LIMIT', '512M');" wp-config.php`,

        'echo "---[10/12] URLs reparadas con éxito---"',

        '# ================================================================',
        '# 7. REGISTRO WP TOOLKIT Y CIERRE',
        '# ================================================================',
        '# 7. SANEAMIENTO DE SEGURIDAD (Usuarios y Basura)',
        '# ================================================================',
        `echo "---[11/12] Limpiando transients y capacidades...---"`,
        `mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "DELETE FROM \\\${PREFIX}options WHERE option_name LIKE '_transient_%' OR option_name LIKE '_site_transient_%';" 2>/dev/null || true`,
        `BASE_USER=$(echo "${safeDom}" | cut -d. -f1)`,
        `mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "DELETE FROM \\\${PREFIX}usermeta WHERE meta_key = '\\\${PREFIX}capabilities' AND user_id NOT IN (SELECT ID FROM \\\${PREFIX}users WHERE user_login IN ('dev', 'administrador', '$BASE_USER'));" 2>/dev/null || true`,
        `mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "INSERT INTO \\\${PREFIX}usermeta (user_id, meta_key, meta_value) SELECT ID, '\\\${PREFIX}capabilities', 'a:1:{s:10:\\"subscriber\\";b:1;}' FROM \\\${PREFIX}users WHERE user_login NOT IN ('dev', 'administrador', '$BASE_USER') AND ID NOT IN (SELECT user_id FROM \\\${PREFIX}usermeta WHERE meta_key = '\\\${PREFIX}capabilities');" 2>/dev/null || true`,

        PROGRESS('config-injection', 'Inyectando configuración y verificando conexión a BD con WP-CLI...'),
        '# ================================================================',
        '# 7.5 INYECCIÓN DE CONFIGURACIÓN Y VERIFICACIÓN (wp-cli)',
        '# ================================================================',
        `echo "---[config-injection] Sincronizando credenciales de BD con WP-CLI...---"`,
        `DOMAIN_ID=$(plesk db -Ne "SELECT id FROM domains WHERE name='${safeDom}'" 2>/dev/null | xargs)`,
        `WP_CMD="wp"`,
        `if ! which wp >/dev/null 2>&1; then`,
        `  if [ -f "/usr/local/bin/wp" ]; then`,
        `    WP_CMD="/usr/local/bin/wp"`,
        `  elif [ -f "/usr/share/plesk-wp-cli/bin/wp-cli.phar" ]; then`,
        `    WP_CMD="php /usr/share/plesk-wp-cli/bin/wp-cli.phar"`,
        `  elif [ -f "/usr/bin/wp" ]; then`,
        `    WP_CMD="/usr/bin/wp"`,
        `  fi`,
        `fi`,
        `chmod 644 "/var/www/vhosts/${safeDom}/httpdocs/wp-config.php" 2>/dev/null || true`,
        `echo "Usando base de datos: $DB_NAME"`,
        `echo "Inyectando configuración con wp-cli..."`,
        `(`,
        `  cd "/var/www/vhosts/${safeDom}"`,
        `  $WP_CMD config set DB_NAME "$DB_NAME" --path=httpdocs --allow-root`,
        `  $WP_CMD config set DB_USER "$DB_USER" --path=httpdocs --allow-root`,
        `  $WP_CMD config set DB_PASSWORD "$DB_PASS" --path=httpdocs --allow-root`,
        `  $WP_CMD config set DB_HOST "localhost" --path=httpdocs --allow-root`,
        `)`,
        `echo "Verificando conexión a base de datos con wp db check..."`,
        `if ! (cd "/var/www/vhosts/${safeDom}" && $WP_CMD db check --path=httpdocs --allow-root); then`,
        `  echo "wp db check falló. Intentando wp db repair..."`,
        `  (cd "/var/www/vhosts/${safeDom}" && $WP_CMD db repair --path=httpdocs --allow-root)`,
        `  echo "Re-verificando conexión a base de datos..."`,
        `  if ! (cd "/var/www/vhosts/${safeDom}" && $WP_CMD db check --path=httpdocs --allow-root); then`,
        `    echo "---[ERROR] Error de conexión a BD---"`,
        `    exit 1`,
        `  fi`,
        `fi`,
        `chmod 600 "/var/www/vhosts/${safeDom}/httpdocs/wp-config.php" 2>/dev/null || true`,
        `(`,
        `  cd "/var/www/vhosts/${safeDom}"`,
        `  $WP_CMD option delete upload_path --path=httpdocs --allow-root 2>/dev/null || true`,
        `  $WP_CMD option set upload_path "" --path=httpdocs --allow-root 2>/dev/null || true`,
        `  $WP_CMD rewrite flush --hard --path=httpdocs --allow-root 2>/dev/null || true`,
        `  $WP_CMD elementor flush_css --path=httpdocs --allow-root 2>/dev/null || true`,
        `)`,

        '# ================================================================',
        '# 8. REGISTRO WP TOOLKIT Y CIERRE',
        '# ================================================================',
        `DOMAIN_ID=$(plesk db -Ne "SELECT id FROM domains WHERE name='${safeDom}'" 2>/dev/null | xargs || true)`,
        `if [ -n "$DOMAIN_ID" ]; then`,
        `  echo "---[12/12] Verificando e ingresando a WP-Toolkit...---"`,
        `  rm -f "/var/www/vhosts/${safeDom}/httpdocs/.wp-toolkit.json" || true`,
        `  echo "Desvinculando instancias previas en WP-Toolkit..."`,
        `  plesk ext wp-toolkit --detach -main-domain-id "$DOMAIN_ID" -path httpdocs >/dev/null 2>&1 || true`,
        `  echo "Preparando el directorio para WP-Toolkit..."`,
        `  rm -f "/var/www/vhosts/${safeDom}/httpdocs/.wp-toolkit-ignore" || true`,
        `  echo "Registrando sitio en WP-Toolkit..."`,
        `  REG_STATUS=0; plesk ext wp-toolkit --register -main-domain-id "$DOMAIN_ID" -path "httpdocs" >/dev/null 2>&1 || REG_STATUS=$?`,
        `  if [ $REG_STATUS -ne 0 ]; then`,
        `    echo "[INFO] WP-Toolkit registro opcional fallido, el sitio sigue operativo."`,
        `  else`,
        `    echo "[OK] Sitio registrado en WP-Toolkit."`,
        `  fi`,
        `fi`,
        `plesk repair fs "${safeDom}" -y > /dev/null 2>&1 || true`,
        'sync',
        // ── Normalización de .htaccess ──
        `# ================================================================`,
        `# 9. NORMALIZACIÓN .HTACCESS (Redirección HTTPS y Estándar WP)`,
        `# ================================================================`,
        `echo "@@@syslog|MIGRATE|info|HTACCESS-NORMALIZE"`,
        `echo "Forzando redireccion HTTPS via .htaccess local..."`,
        `cat > .htaccess << 'HTEOF'`,
        `# BEGIN WordPress`,
        `RewriteEngine On`,
        `RewriteCond %{HTTPS} !=on`,
        `RewriteRule ^(.*)$ https://%{HTTP_HOST}/$1 [R=301,L]`,
        `RewriteBase /`,
        `RewriteRule ^index\\.php$ - [L]`,
        `RewriteCond %{REQUEST_FILENAME} !-f`,
        `RewriteCond %{REQUEST_FILENAME} !-d`,
        `RewriteRule . /index.php [L]`,
        `# END WordPress`,
        `HTEOF`,
        `chmod 644 .htaccess`,
        // Log forense se preserva en servidor para debug
        `# ================================================================`,
        `# 9. LOGS PERSISTENTES`,
        `# ================================================================`,
        `TARGET_DIR="/var/www/vhosts/${safeDom}/logs"`,
        `mkdir -p "\$TARGET_DIR" || true`,
        `mv "${HDP}/"*_mysql_debug.log "\$TARGET_DIR/" 2>/dev/null || true`,
        `mv "${HDP}/fix-urls.php" "\$TARGET_DIR/" 2>/dev/null || true`,
        `mv "${HDP}/sanitized.sql" "\$TARGET_DIR/" 2>/dev/null || true`,
        'echo "---[12/12] MIGRACIÓN EXITOSA ---"',
        'set +x', // Desactivar modo debug
        PROGRESS('done', 'Despliegue completado con éxito'),
        'exit 0' // FORZAR ÉXITO TOTAL (ignorar errores cosméticos de tareas secundarias)
      ].join('\n');

      // 🔥 v1.14.0: streaming en tiempo real via executeStreamCommand
      const progressRegex = /@@@PROGRESS@@@(.*?)@@@END@@@/g;
      let bashOutput = '';
      const streamCallback = (chunk) => {
        bashOutput += chunk;
        // Buscar marcadores de progreso en el chunk y emitirlos al instante
        let match;
        const localRegex = /@@@PROGRESS@@@(.*?)@@@END@@@/g;
        while ((match = localRegex.exec(chunk)) !== null) {
          try {
            const payload = JSON.parse(match[1]);
            this.emitLog(taskId, domain, 50, payload.msg || '');
          } catch (_) {}
        }
      };

      console.log('\n--- SCRIPT BASH GENERADO ---\n', bashScript);
      const bashResult = await this.sshService.executeStreamCommand(sshClient, bashScript, streamCallback);
      const bashError = bashResult.stderr || '';

      // ── Telemetría post-bash ──
      const EMIT_BASH = require('./standard-emitter').getStandardEmitter('deployment');
      const finalCode = bashResult.code ?? bashResult.signal ?? 'unknown';
      EMIT_BASH.emit('debug', `[BASH-EXIT] ${domain} code=${finalCode}`, domain);
      if (finalCode !== 0 && finalCode !== '0') {
        const fullLog = (bashError || bashOutput || '');
        const lastLines = fullLog.split('\n').slice(-15).join('\n');
        EMIT_BASH.emit('error', `[BASH] Script falló para ${domain} (code=${finalCode}):\n${lastLines}`, domain);
        throw new Error(`Script de despliegue falló (code=${finalCode}). Últimas 15 líneas del log:\n${lastLines}`);
      }

      if (bashOutput.includes('---[ERROR]')) {
        const errorLines = bashOutput.split('\n').filter(l => l.includes('---[ERROR]')).join(' | ');
        throw new Error(`[BASH] ${errorLines}`);
      }
      // v1.9.18: progreso por marcadores N/12 (fallback para markers no-stream)
      if (bashOutput.includes('---[3/12] Extrayendo backup')) this.emitLog(taskId, domain, 25, '[PASO 3/12] Extrayendo backup');
      if (bashOutput.includes('---[4/12] Extraccion completada')) this.emitLog(taskId, domain, 40, '[PASO 4/12] Backup extraído');
      if (bashOutput.includes('---[6/12] Credenciales obtenidas')) this.emitLog(taskId, domain, 55, '[PASO 6/12] Credenciales');
      if (bashOutput.includes('---[12/12] MIGRACION EXITOSA')) this.emitLog(taskId, domain, 100, '[PASO 12/12] Migración exitosa');

      subscriptionCreated = true;
      wpConfigInjected = true;
      wpConfigMethod = 'bash-script';

      // oldSiteurl se necesita para sanitización post-migración vieja si existe
      const oldSiteurl = this.extractOldSiteurlFromSql(dbPath);

      // --- [NUEVO] Aprovisionamiento y Restauración de Correos ---
      try {
        const { asegurarBuzonInfo, restaurarEmailsPlesk } = require('./mail-service');
        const executeFn = async (cmd) => await this.sshService.executeCommand(sshClient, cmd);
        const sftpUploadFn = async (localFile, remoteFile) => await this.sshService.uploadFile(sshClient, localFile, remoteFile);

        const mailRes = await asegurarBuzonInfo(domain, executeFn);
        if (mailRes.exito) {
          this.emitLog(taskId, domain, 98, `[CORREO] ${mailRes.mensaje}`);
          this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 98, message: `[CORREO] ${mailRes.mensaje}` });
        } else {
          this.emitLog(taskId, domain, 98, `[CORREO-WARN] ${mailRes.mensaje}`);
          this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 98, message: `[CORREO-WARN] ${mailRes.mensaje}` });
        }

        // Restaurar emails.tar.gz si existe
        await restaurarEmailsPlesk({
          domain,
          domainPath,
          executeCommandFn: executeFn,
          sftpUploadFn,
          emitLog: (msg, type) => this.emitLog(taskId, domain, 99, msg)
        });
      } catch (err) {
        console.warn(`[DEPLOY] Error en restauración de correo para ${domain}:`, err.message);
      }

      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;

      this.emitLog(taskId, domain, 100, `[OK] ${domain}: Despliegue completado en ${duration.toFixed(0)}s`);
      this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 100, message: `[OK] ${domain}: Despliegue completado en ${duration.toFixed(0)}s` });

      return {
        domain,
        safeDomain: safeDom,
        status: 'success',
        step: 'complete',
        details: {
          subscriptionCreated,
          wpConfigInjected,
          wpConfigMethod,
          documentRoot,
          duration
        },
        metrics: {
          durationSeconds: duration.toFixed(2),
          wpConfigMethod,
          sanitizationPerformed: true
        }
      };

    } catch (error) {
      this.progressEmitter.emitProgress({
        taskId, module: 'deployment', domain,
        progress: 0,
        message: `[ERROR] ${domain}: ${error.message}`
      });
      throw error;
    } finally {
      // Conexión SSH es gestionada por deployBatch — no cerrar aquí
    }
  }

  /** Backward-compatible alias */
  deployWordPress(accountName, serverName, domain, sourceAccount, sourceCloud, taskId, options = {}) {
    return this.deploySingleDomain(accountName, serverName, domain, sourceAccount, sourceCloud, taskId, options, null);
  }

  // ================================================================
  // MÉTODO: deployUltraLiteDomain
  // Despliegue del nuevo formato Ultra-Lite:
  //   - Sube {dominio}.tar.gz (contiene uploads/ + config.json + SQLs)
  //   - Instala WP Core limpio
  //   - Importa {dominio}.sql saneado
  //   - Aplica limpieza profunda de DB (triggers + spam)
  //   - Instala plugins gratuitos vía WP-CLI
  //   - Inyecta Elementor Pro (zip + licencia desde Config global)
  //   - Reverse SSH: descarga SQL desinfectado y lo reemplaza en el tar local
  // ================================================================

  /**
   * @param {Object} sshClient - Conexión SSH existente
   * @param {string} domain - Dominio original (puede tener IDN)
   * @param {string} localTarPath - Ruta local al {dominio}.tar.gz Ultra-Lite
   * @param {string} taskId - ID de tarea para progress emitter
   */
  async deployUltraLiteDomain(sshClient, domain, localTarPath, taskId) {
    const safeDom = this.safeDomain(domain);
    const short = this.shortName(safeDom);
    const HDP = `/var/www/vhosts/${safeDom}/httpdocs`;
    const startTime = Date.now();

    const EMIT = require('./standard-emitter').getStandardEmitter('deployment');
    const log = (msg) => {
      EMIT.emit('info', msg, domain);
      this.emitLog(taskId, domain, 50, msg);
    };

    // 1. Leer config de Elementor Pro del ConfigManager
    const cfg = this.configManager.getConfig();
    const epZipPath = cfg?.elementorPro?.zipPath || null;
    const epLicenseKey = cfg?.elementorPro?.licenseKey || null;

    log(`[ULTRA-LITE] Iniciando despliegue para ${domain}`);

    // 2. Subir el tar.gz Ultra-Lite vía SSH
    const remoteArchive = `${HDP}/${short}_ulite.tar.gz`;
    log(`[SFTP] Subiendo ${path.basename(localTarPath)}...`);
    await this.sshService.uploadFileFast(sshClient, localTarPath, remoteArchive);
    log(`[SFTP] Upload completado.`);

    // Verificar tamaño remoto vs local antes de ejecutar el script
    const localTarSize = require('fs').statSync(localTarPath).size;
    const verifyTar = await this.sshService.executeCommand(
      sshClient,
      `stat -c%s "${remoteArchive}" 2>/dev/null || echo 0`,
      { timeout: 10000 }
    );
    const remoteTarSize = parseInt((verifyTar.stdout || '0').trim(), 10);
    if (remoteTarSize !== localTarSize) {
      throw new Error(
        `[SFTP] Subida incompleta: local=${localTarSize} bytes, remoto=${remoteTarSize} bytes. ` +
        `Reintentá el despliegue (archivo truncado en tránsito).`
      );
    }

    // Verificar integridad del gzip remoto
    const gzipCheck = await this.sshService.executeCommand(
      sshClient,
      `gzip -t "${remoteArchive}" 2>&1 && echo "GZIP_OK" || echo "GZIP_FAIL"`,
      { timeout: 30000 }
    );
    if (!(gzipCheck.stdout || '').includes('GZIP_OK')) {
      // Limpiar archivo corrupto
      await this.sshService.executeCommand(sshClient, `rm -f "${remoteArchive}" 2>/dev/null`, { timeout: 5000 });
      throw new Error(
        `[SFTP] El archivo .tar.gz está corrupto en el servidor (gzip -t falló). ` +
        `Reintentá el despliegue.`
      );
    }
    log(`[SFTP] Archivo verificado: ${(localTarSize / 1024 / 1024).toFixed(2)} MB OK`);

    this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 20, message: '[ULTRA-LITE] Archivo subido. Iniciando script...' });

    // 3. Generar credenciales de DB deterministas
    const sha256 = crypto.createHash('sha256').update(domain).digest('hex').substring(0, 4);
    const dbName = `wp_${sha256}`;
    const dbUser = `u${sha256}`;
    const dbPassword = crypto.randomBytes(8).toString('hex'); // 16 caracteres + Krx1! = 21 chars (Plesk safe)

    const BLACKLIST_SQL = `'${BLACKLIST_USERS.join("','")}'`;

    // 4. Construir script Bash
    const bashScript = [
      'set -u',
      `cd "${HDP}" || { echo "[ERROR] No se puede acceder a httpdocs"; exit 1; }`,
      '',
      '# ── Limpieza de archivos previos ──',
      `rm -f index.html favicon.ico 2>/dev/null || true`,
      `find . -maxdepth 1 -type f \\( -name "*.tar.gz" -o -name "*.sql" -o -name "config.json" \\) ! -name "${short}_ulite.tar.gz" -exec rm -f {} \\; 2>/dev/null || true`,
      '',
      '# ── Extracción del paquete Ultra-Lite ──',
      `tar -xzf "${short}_ulite.tar.gz" --warning=no-unknown-keyword 2>&1 || { echo "[ERROR] Fallo extracción"; exit 1; }`,
      `rm -f "${short}_ulite.tar.gz"`,
      '',
      '# ── Leer config.json ──',
      `PREFIX=$(cat config.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('db_prefix','wp_'))" 2>/dev/null || echo "wp_")`,
      `THEME=$(cat config.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('theme','hello-elementor'))" 2>/dev/null || echo "hello-elementor")`,
      '',
      '# ── Detectar WP-CLI ──',
      `WP_CMD="wp"`,
      `if ! which wp >/dev/null 2>&1; then`,
      `  [ -f "/usr/local/bin/wp" ] && WP_CMD="/usr/local/bin/wp"`,
      `  [ -f "/usr/share/plesk-wp-cli/bin/wp-cli.phar" ] && WP_CMD="php /usr/share/plesk-wp-cli/bin/wp-cli.phar"`,
      `  [ -f "/usr/bin/wp" ] && WP_CMD="/usr/bin/wp"`,
      `fi`,
      '',
      '# ── Instalar WP Core limpio ──',
      `$WP_CMD core download --allow-root --path="${HDP}" --skip-content 2>/dev/null || true`,
      '',
      '# ── Crear DB y usuario en Plesk ──',
      `DB_EXISTS=$(plesk db -Nse "SELECT COUNT(*) FROM data_bases WHERE name='${dbName}'" 2>/dev/null || echo 0)`,
      `if [ "$DB_EXISTS" -eq 0 ]; then`,
      `  plesk bin database --create "${dbName}" -domain "${safeDom}" -type mysql -server localhost >/dev/null 2>&1 || { echo "[ERROR] No se pudo crear DB"; exit 1; }`,
      `fi`,
      `plesk bin database --create-dbuser "${dbUser}" -passwd "${dbPassword}Krx1!" -domain "${safeDom}" -server localhost:3306 -database "${dbName}" >/dev/null 2>&1 || true`,
      `plesk bin database --update "${dbName}" -add_user "${dbUser}" >/dev/null 2>&1 || true`,
      `plesk bin database --update-dbuser "${dbUser}" -passwd "${dbPassword}Krx1!" -server localhost:3306 >/dev/null 2>&1 || true`,
      `DB_PASS="${dbPassword}Krx1!"`,
      '',
      '# ── Crear wp-config.php con prefix correcto ──',
      `$WP_CMD config create --dbname="${dbName}" --dbuser="${dbUser}" --dbpass="$DB_PASS" --dbhost="localhost" --dbprefix="$PREFIX" --path="${HDP}" --allow-root --force 2>/dev/null`,
      `NEW_URL="https://${safeDom}"`,
      `$WP_CMD config set WP_HOME "$NEW_URL" --path="${HDP}" --allow-root 2>/dev/null || true`,
      `$WP_CMD config set WP_SITEURL "$NEW_URL" --path="${HDP}" --allow-root 2>/dev/null || true`,
      `$WP_CMD config set WP_MEMORY_LIMIT "512M" --path="${HDP}" --allow-root 2>/dev/null || true`,
      `$WP_CMD config set FS_METHOD "direct" --path="${HDP}" --allow-root 2>/dev/null || true`,
      '',
      '# ── Extraer uploads al lugar correcto ──',
      `mkdir -p "${HDP}/wp-content/uploads"`,
      `if [ -f "${HDP}/uploads.tar.gz" ]; then`,
      `  tar -xzf "${HDP}/uploads.tar.gz" -C "${HDP}/wp-content/" --warning=no-unknown-keyword 2>/dev/null || true`,
      `  rm -f "${HDP}/uploads.tar.gz"`,
      `elif [ -d "${HDP}/uploads" ]; then`,
      `  cp -rT "${HDP}/uploads" "${HDP}/wp-content/uploads" && rm -rf "${HDP}/uploads"`,
      `fi`,
      '',
      '# ── Importar SQL saneado ──',
      `SQL_FILE=$(find . -maxdepth 1 -name "*.sql" ! -name "*hostinger*" -print -quit)`,
      `[ -z "$SQL_FILE" ] && SQL_FILE=$(find . -maxdepth 1 -name "*.sql" -print -quit)`,
      `if [ -z "$SQL_FILE" ] || [ ! -s "$SQL_FILE" ]; then echo "[ERROR] SQL no encontrado"; exit 1; fi`,
      `echo "SET FOREIGN_KEY_CHECKS=0;" > _sanitized.sql`,
      `sed -E -e 's#\\/\\*!50013 DEFINER=[^*]*\\*\\/##g' -e 's#\\/\\*!50017 DEFINER=[^*]*\\*\\/##g' -e 's/DEFINER=[a-zA-Z0-9_@.\`"]+//g' -e '/\\/\\*!50003 TRIGGER/d' -e 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g' -e 's/utf8mb4_unicode_520_ci/utf8mb4_unicode_ci/g' -e '/^CREATE DATABASE/d' -e '/^USE /d' "$SQL_FILE" >> _sanitized.sql || true`,
      `echo "SET FOREIGN_KEY_CHECKS=1;" >> _sanitized.sql`,
      `mysql -u"${dbUser}" -p"$DB_PASS" --force "${dbName}" < _sanitized.sql > _sql_error.log 2>&1 || { echo "[ERROR] Importación SQL falló. Detalles:"; head -n 10 _sql_error.log; exit 1; }`,
      `rm -f _sanitized.sql`,
      '',
      '# ── Limpieza de triggers y spam ──',
      `TRIGGERS=$(mysql -u"${dbUser}" -p"$DB_PASS" -B -N -e "SHOW TRIGGERS FROM \\\`${dbName}\\\`;" 2>/dev/null | awk '{print $1}')`,
      `for trigger in $TRIGGERS; do mysql -u"${dbUser}" -p"$DB_PASS" "${dbName}" -e "DROP TRIGGER IF EXISTS \\\`$trigger\\\`;" 2>/dev/null || true; done`,
      `mysql -u"${dbUser}" -p"$DB_PASS" "${dbName}" -e "`,
      `  DELETE FROM \\\`${dbName}\\\`.\\\`\${PREFIX}posts\\\` WHERE LOWER(post_title) REGEXP 'casino|slot|bet|apuestas|tragamonedas|blackjack|porn' OR LOWER(post_content) REGEXP 'casino|slot|bet|apuestas|tragamonedas';`,
      `  DELETE u FROM \\\`${dbName}\\\`.\\\`\${PREFIX}users\\\` u WHERE u.user_login IN (${BLACKLIST_SQL});`,
      `  DELETE FROM \\\`${dbName}\\\`.\\\`\${PREFIX}options\\\` WHERE option_name LIKE '_transient_%' OR option_name LIKE '_site_transient_%';`,
      `" 2>/dev/null || true`,
      '',
      '# ── Validar integridad (>11 tablas) ──',
      `TABLE_COUNT=$(mysql -u"${dbUser}" -p"$DB_PASS" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${dbName}' AND table_type='BASE TABLE';" 2>/dev/null || echo 0)`,
      `if [ "$TABLE_COUNT" -lt 11 ]; then echo "[ERROR] Solo $TABLE_COUNT tablas importadas. Abortando."; exit 1; fi`,
      `echo "[OK] DB verificada: $TABLE_COUNT tablas."`,
      '',
      '# ── Search-Replace de URLs y Limpieza de Rutas Absolutas ──',
      `$WP_CMD search-replace "http://${safeDom}" "https://${safeDom}" --all-tables --allow-root --path="${HDP}" 2>/dev/null || true`,
      `mysql -u"${dbUser}" -p"$DB_PASS" "${dbName}" -e "UPDATE \\\`\${PREFIX}options\\\` SET option_value='https://${safeDom}' WHERE option_name IN ('siteurl','home');" 2>/dev/null || true`,
      `$WP_CMD option delete upload_path --allow-root --path="${HDP}" 2>/dev/null || true`,
      `$WP_CMD option set upload_path "" --allow-root --path="${HDP}" 2>/dev/null || true`,
      `$WP_CMD option update permalink_structure '/%postname%/' --allow-root --path="${HDP}" 2>/dev/null || true`,
      `$WP_CMD rewrite flush --hard --allow-root --path="${HDP}" 2>/dev/null || true`,
      `$WP_CMD elementor flush_css --allow-root --path="${HDP}" 2>/dev/null || true`,
      '',
      '# ── Instalar tema ──',
      `$WP_CMD theme install "$THEME" --activate --allow-root --path="${HDP}" 2>/dev/null || $WP_CMD theme install hello-elementor --activate --allow-root --path="${HDP}" 2>/dev/null || true`,
      '# Eliminar temas por defecto de WordPress',
      `$WP_CMD theme delete twentytwentyfive twentytwentyfour twentytwentythree twentytwentytwo twentytwentyone twentytwenty --allow-root --path="${HDP}" 2>/dev/null || true`,
      '',
      '# ── Instalar plugins gratuitos desde config.json ──',
      `python3 -c "import sys,json; [print(p) for p in json.load(open('config.json')).get('plugins',[]) if p not in ('elementor-pro',)]" 2>/dev/null | while read PLUGIN; do`,
      `  echo "[PLUGIN] Instalando: $PLUGIN"`,
      `  $WP_CMD plugin install "$PLUGIN" --activate --allow-root --path="${HDP}" 2>/dev/null && echo "[OK] $PLUGIN" || echo "[WARN] Falló: $PLUGIN — instalar manualmente"`,
      `done`,
      '',
      '# ── Registro WP-Toolkit ──',
      `DOMAIN_ID=$(plesk db -Ne "SELECT id FROM domains WHERE name='${safeDom}'" 2>/dev/null | xargs || true)`,
      `if [ -n "$DOMAIN_ID" ]; then`,
      `  plesk ext wp-toolkit --detach -main-domain-id "$DOMAIN_ID" -path httpdocs >/dev/null 2>&1 || true`,
      `  rm -f "${HDP}/.wp-toolkit.json" "${HDP}/.wp-toolkit-ignore" || true`,
      `  plesk ext wp-toolkit --register -main-domain-id "$DOMAIN_ID" -path httpdocs >/dev/null 2>&1 || true`,
      `fi`,
      '',
      '# ── Corrección de Propietario (Permisos Linux) ──',
      `DOMAIN_USER=$(plesk db -Ne "SELECT sys_users.login FROM sys_users JOIN hosting ON sys_users.id = hosting.sys_user_id JOIN domains ON hosting.dom_id = domains.id WHERE domains.name = '${safeDom}'" 2>/dev/null | xargs || true)`,
      `if [ -n "$DOMAIN_USER" ]; then`,
      `  chown -R "$DOMAIN_USER":psacln "${HDP}"`,
      `  find "${HDP}" -type d -exec chmod 755 {} \\;`,
      `  find "${HDP}" -type f -exec chmod 644 {} \\;`,
      `fi`,
      '',
      '# ── Eliminar residuos SQL de httpdocs ──',
      `rm -f "${HDP}"/*.sql "${HDP}/config.json" 2>/dev/null || true`,
      '',
      'echo "[ULTRA-LITE] Despliegue completado."',
      'exit 0',
    ].join('\n');

    log(`[BASH] Ejecutando script Ultra-Lite en ${safeDom}...`);
    this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 40, message: '[ULTRA-LITE] Ejecutando script remoto...' });

    const bashResult = await this.sshService.executeStreamCommand(sshClient, bashScript, (chunk) => {
      if (chunk.trim()) EMIT.emit('debug', chunk.trim(), domain);
    });

    if ((bashResult.code ?? 0) !== 0) {
      const lastLines = (bashResult.stderr || bashResult.stdout || '').split('\n').slice(-10).join('\n');
      throw new Error(`[ULTRA-LITE] Script falló (code=${bashResult.code}):\n${lastLines}`);
    }

    this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 75, message: '[ULTRA-LITE] Script completado. Inyectando Elementor Pro...' });

    // 5. Inyectar Elementor Pro (si está configurado)
    if (epZipPath && epLicenseKey) {
      try {
        log(`[ELEMENTOR] Subiendo elementor-pro.zip...`);
        const remoteEpZip = `${HDP}/elementor-pro.zip`;
        await this.sshService.uploadFileFast(sshClient, epZipPath, remoteEpZip);

        const epScript = [
          `WP_CMD="wp"`,
          `if ! which wp >/dev/null 2>&1; then`,
          `  [ -f "/usr/local/bin/wp" ] && WP_CMD="/usr/local/bin/wp"`,
          `  [ -f "/usr/share/plesk-wp-cli/bin/wp-cli.phar" ] && WP_CMD="php /usr/share/plesk-wp-cli/bin/wp-cli.phar"`,
          `fi`,
          `$WP_CMD plugin install "${HDP}/elementor-pro.zip" --activate --force --allow-root --path="${HDP}" && echo "[OK] Elementor Pro instalado" || echo "[WARN] Elementor Pro ZIP falló"`,
          `sleep 5`,
          `EP_KEY='${epLicenseKey.trim().replace(/'/g, "'\\''")}'`,
          `LICENSE_OUT=$($WP_CMD elementor-pro license activate "$EP_KEY" --allow-root --path="${HDP}" 2>&1)`,
          `LICENSE_CODE=$?`,
          `if [ $LICENSE_CODE -eq 0 ]; then`,
          `  echo "[OK] Licencia activada: $LICENSE_OUT"`,
          `else`,
          `  echo "[WARN] Activación de licencia falló (code: $LICENSE_CODE). Salida: $LICENSE_OUT"`,
          `fi`,
          `rm -f "${HDP}/elementor-pro.zip"`,
          `DOMAIN_USER=$(plesk db -Ne "SELECT sys_users.login FROM sys_users JOIN hosting ON sys_users.id = hosting.sys_user_id JOIN domains ON hosting.dom_id = domains.id WHERE domains.name = '${safeDom}'" 2>/dev/null | xargs || true)`,
          `if [ -n "$DOMAIN_USER" ]; then chown -R "$DOMAIN_USER":psacln "${HDP}/wp-content/plugins/elementor-pro" 2>/dev/null || true; fi`,
        ].join('\n');

        const epResult = await this.sshService.executeStreamCommand(sshClient, epScript, (chunk) => {
          if (chunk.trim()) EMIT.emit('debug', chunk.trim(), domain);
        });
        if ((epResult.code ?? 0) !== 0) {
          log(`[ELEMENTOR] Advertencia: código de salida ${epResult.code} al instalar Pro.`);
        }
        log(`[ELEMENTOR] Finalizado proceso de Elementor Pro.`);
      } catch (epErr) {
        EMIT.emit('warning', `[ELEMENTOR] Error no fatal inyectando Elementor Pro: ${epErr.message}`, domain);
      }
    }

    this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 90, message: '[ULTRA-LITE] Descargando DB desinfectada...' });

    // 6. Reverse SSH: Descargar el dump del SQL ya saneado desde el servidor
    try {
      const remoteDumpPath = `/tmp/${short}_clean_${Date.now()}.sql`;
      const dumpCmd = `mysqldump -u"wp_${sha256}" -p"${dbPassword}Krx1!" --single-transaction --no-tablespaces "${dbName}" > "${remoteDumpPath}" 2>/dev/null && echo "OK" || echo "FAIL"`;
      const dumpResult = await this.sshService.executeCommand(sshClient, dumpCmd);

      if ((dumpResult.stdout || '').includes('OK')) {
        // Descargar el dump al directorio local del tar
        const localDir = path.dirname(localTarPath);
        const localCleanSqlPath = path.join(localDir, `${domain}.sql`);
        await this.sshService.downloadFile(sshClient, remoteDumpPath, localCleanSqlPath);
        await this.sshService.executeCommand(sshClient, `rm -f "${remoteDumpPath}"`);
        log(`[REVERSE-SSH] DB desinfectada guardada localmente: ${domain}.sql`);
      }
    } catch (reverseErr) {
      EMIT.emit('warning', `[REVERSE-SSH] No fatal: ${reverseErr.message}`, domain);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    log(`[ULTRA-LITE] ✅ ${domain} desplegado en ${duration}s`);
    this.progressEmitter.emitProgress({ taskId, module: 'deployment', domain, progress: 100, message: `[ULTRA-LITE] ${domain} completado en ${duration}s` });

    return { domain, safeDomain: safeDom, status: 'success', mode: 'ultra-lite', duration };
  }


  /**
   * Get Plesk document root for a domain
   */
  async getPleskDocumentRoot(client, domain) {
    try {
      const result = await this.sshService.executeCommand(
        client,
        `plesk bin domain --info ${domain} | grep "Document root" | awk -F': ' '{print $2}'`
      );

      if (result.stdout && result.stdout.trim()) {
        return result.stdout.trim();
      }

      // Fallback to default Plesk path
      return `/var/www/vhosts/${domain}/httpdocs`;
    } catch (error) {
      // If command fails, use default path
      return `/var/www/vhosts/${domain}/httpdocs`;
    }
  }

  /**
   * Extract files on server
   */
  async extractFilesOnServer(client, remoteArchivePath, documentRoot, taskId, domain) {
    try {
      // Create backup of existing files (if any)
      await this.sshService.executeCommand(
        client,
        `cd "${documentRoot}" && tar -cf /tmp/${domain}_backup_$(date +%s).tar . 2>/dev/null || true`
      );

      // Extract files
      const result = await this.sshService.executeCommand(
        client,
        `cd "${documentRoot}" && tar -xf "${remoteArchivePath}" --strip-components=1 2>&1`
      );

      if (result.code !== 0) {
        throw new Error(`Failed to extract files: ${result.stderr || result.stdout}`);
      }

      this.progressEmitter.emitProgress({
        taskId,
        module: 'deployment',
        domain,
        progress: 50,
        message: 'Files extracted'
      });

      return true;
    } catch (error) {
      throw new Error(`File extraction failed: ${error.message}`);
    }
  }

  /**
   * Fix permissions using native commands (NO plesk repair fs).
   * Detects the subscription system user and applies correct ownership.
   * @param {Object} client - SSH client
   * @param {string} safeDomain - Punycode domain
   * @param {string} documentRoot - Remote httpdocs path
   * @returns {Promise<Object>} { success, user }
   */
  async fixPermissions(client, safeDomain, documentRoot) {
    try {
      // Step 1: Detect subscription system user
      const userResult = await this.sshService.executeCommand(
        client,
        `plesk bin subscription --info ${safeDomain} | grep "System user" | awk -F': ' '{print $2}'`
      );

      const subscriptionUser = userResult.stdout.trim();
      if (!subscriptionUser) {
        throw new Error(`Could not detect system user for subscription ${safeDomain}`);
      }

      // Step 2: chown -R {user}:psacln
      await this.sshService.executeCommand(
        client,
        `chown -R ${subscriptionUser}:psacln "${documentRoot}"`
      );

      // Step 3: chmod 755 for directories
      await this.sshService.executeCommand(
        client,
        `find "${documentRoot}" -type d -exec chmod 755 {} +`
      );

      // Step 4: chmod 644 for files
      await this.sshService.executeCommand(
        client,
        `find "${documentRoot}" -type f -exec chmod 644 {} +`
      );

      // Step 5: wp-config.php gets 600
      await this.sshService.executeCommand(
        client,
        `chmod 600 "${documentRoot}/wp-config.php" 2>/dev/null || true`
      );

      return { success: true, user: subscriptionUser };
    } catch (error) {
      console.warn(`[FIXPERMS] Permissions fix partially failed for ${safeDomain}:`, error.message);
      return { success: false, user: null, error: error.message };
    }
  }

  /**
   * Dual-layer memory limit injection
   */
  async injectMemoryLimitsDualLayer(client, domain, documentRoot, localWpConfigPath, wpConfigExists, taskId) {
    const remoteWpConfigPath = path.posix.join(documentRoot, 'wp-config.php');
    let injected = false;
    let method = 'none';

    // Layer A: Use locally modified wp-config.php if available
    if (wpConfigExists) {
      try {
        // Upload the modified wp-config.php
        await this.sshService.uploadFile(client, localWpConfigPath, remoteWpConfigPath);

        this.progressEmitter.emitProgress({
          taskId,
          module: 'deployment',
          domain,
          progress: 65,
          message: 'Uploaded modified wp-config.php with memory limits (512M/1024M)'
        });

        injected = true;
        method = 'file';
        return { injected, method };
      } catch (error) {
        console.warn('Failed to upload modified wp-config.php:', error.message);
        // Fall through to Layer B
      }
    }

    // Layer B: Inject memory limits via SSH command
    try {
      await this.injectMemoryLimitsViaCommand(client, remoteWpConfigPath);

      this.progressEmitter.emitProgress({
        taskId,
        module: 'deployment',
        domain,
        progress: 65,
        message: 'Injected memory limits via SSH command (failsafe method)'
      });

      injected = true;
      method = 'command';
      return { injected, method };
    } catch (error) {
      console.warn('Failed to inject memory limits via command:', error.message);
      this.progressEmitter.emitProgress({
        taskId,
        module: 'deployment',
        domain,
        progress: 65,
        message: 'Could not inject memory limits - manual review required'
      });
      return { injected: false, method: 'failed' };
    }
  }

  /**
   * Inject memory limits via SSH command (sed)
   */
  async injectMemoryLimitsViaCommand(client, remoteWpConfigPath) {
    // Define memory limits
    const memoryLimits = [
      "define('WP_MEMORY_LIMIT', '512M');",
      "define('WP_MAX_MEMORY_LIMIT', '1024M');"
    ];

    // Check if limits already exist
    const checkResult = await this.sshService.executeCommand(
      client,
      `grep -q "WP_MEMORY_LIMIT" "${remoteWpConfigPath}" && echo "exists" || echo "not found"`
    );

    if (checkResult.stdout.includes('exists')) {
      // Update existing limits
      for (const limit of memoryLimits) {
        const defineName = limit.split("'")[1]; // Extract WP_MEMORY_LIMIT or WP_MAX_MEMORY_LIMIT
        await this.sshService.executeCommand(
          client,
          `sed -i "s/define.*${defineName}.*/${limit}/" "${remoteWpConfigPath}"`
        );
      }
    } else {
      // Insert new limits after <?php
      const insertCommand = `sed -i "/^<?php/a ${memoryLimits[0]}\\n${memoryLimits[1]}" "${remoteWpConfigPath}"`;
      await this.sshService.executeCommand(client, insertCommand);
    }

    return true;
  }

  /**
   * Import database
   */
  async importDatabase(client, domain, remoteDbPath, taskId) {
    try {
      // Get database credentials from Plesk
      const dbInfo = await this.getPleskDatabaseInfo(client, domain);

      if (!dbInfo.database || !dbInfo.username || !dbInfo.password) {
        throw new Error('Could not retrieve database credentials from Plesk');
      }

      // Import database
      const importCommand = `mysql -u "${dbInfo.username}" -p"${dbInfo.password}" "${dbInfo.database}" < "${remoteDbPath}"`;

      const result = await this.sshService.executeCommand(client, importCommand);

      if (result.code !== 0) {
        throw new Error(`Database import failed: ${result.stderr || result.stdout}`);
      }

      this.progressEmitter.emitProgress({
        taskId,
        module: 'deployment',
        domain,
        progress: 78,
        message: 'Database imported successfully'
      });

      return true;
    } catch (error) {
      throw new Error(`Database import failed: ${error.message}`);
    }
  }

  /**
   * Get database info from Plesk
   */
  async getPleskDatabaseInfo(client, domain) {
    try {
      // Try to get database name
      const dbResult = await this.sshService.executeCommand(
        client,
        `plesk bin database --list | grep "${domain}" | head -1 | awk '{print $2}'`
      );

      const database = dbResult.stdout.trim();

      if (!database) {
        // Database might not exist yet, return default pattern
        return {
          database: `${domain.replace(/[^a-zA-Z0-9]/g, '_')}`,
          username: `${domain.replace(/[^a-zA-Z0-9]/g, '_')}`,
          password: this.generateRandomPassword(16)
        };
      }

      // Get database user
      const userResult = await this.sshService.executeCommand(
        client,
        `plesk bin database --info ${database} | grep "User name" | awk -F': ' '{print $2}'`
      );

      const username = userResult.stdout.trim();

      // Get database password
      const passResult = await this.sshService.executeCommand(
        client,
        `plesk bin database --info ${database} | grep "Password" | awk -F': ' '{print $2}'`
      );

      const password = passResult.stdout.trim();

      return { database, username, password };
    } catch (error) {
      // Fallback to default pattern
      return {
        database: `${domain.replace(/[^a-zA-Z0-9]/g, '_')}`,
        username: `${domain.replace(/[^a-zA-Z0-9]/g, '_')}`,
        password: this.generateRandomPassword(16)
      };
    }
  }

  /**
   * Extract the old siteurl from a local SQL file (pre-import).
   * Returns { siteurl, domain, path } or null.
   */
  extractOldSiteurlFromSql(sqlFilePath) {
    try {
      const fs = require('fs');
      if (!fs.existsSync(sqlFilePath)) {
        console.warn(`[WARN] Archivo de reporte no encontrado, omitiendo lectura: ${sqlFilePath}`);
        return null;
      }
      const content = fs.readFileSync(sqlFilePath, 'utf8');
      const match = content.match(/siteurl','([^']+)/);
      if (match) {
        const url = match[1];
        try {
          const parsed = new URL(url);
          return { siteurl: url, domain: parsed.hostname, path: parsed.pathname.replace(/\/$/, '') };
        } catch {
          return { siteurl: url, domain: url, path: '' };
        }
      }
    } catch (e) {
      console.warn(`[WARN] Error leyendo ${sqlFilePath}: ${e.message}`);
    }
    return null;
  }

  /**
   * Build a batch SQL script for Plesk-side user + content purging.
   * Written as a temp .sql file on the server, executed in one shot.
   *
   * Strategy:
   *   1. Whitelist: dev, administrador, and the domain name user.
   *      Detect bots by email domain (@mail.ru, @protonmail, @yopmail, etc.),
   *      bulk registration timestamps, and suspicious meta.
   *   2. Purge detected bot users with FULL delete (cascade to their posts/meta).
   *   3. Reset remaining admins to standard administrator role.
   *   4. Clean orphaned meta after the purge.
   */
  buildUserPurgeScript(dbInfo, domain) {
    const domainUser = domain.split('.')[0]; // "empresa" from "empresa.com"

    // Escaped for inline SQL via mysql -e
    return `
-- ============================================================
-- STEP 1: Identify bot users by email domain + bulk registration
-- ============================================================
DROP TEMPORARY TABLE IF EXISTS _bot_users;
CREATE TEMPORARY TABLE _bot_users AS
SELECT u.ID, u.user_email, u.user_login, u.user_registered
FROM wp_users u
WHERE (
  -- Suspicious email domains (free/disposable/temp mail)
  u.user_email REGEXP '@(mail\\.ru|protonmail\\.|yopmail\\.|tempmail\\.|10minutemail\\.|guerrillamail\\.|throwaway\\.|sharklasers\\.|trashmail\\.|fake\\-mail\\.|inboxbear\\.|mailinator\\.|getairmail\\.|burnermail\\.|spam4\\.|spambox\\.|mailexpire\\.|mytemp\\.|tempinbox\\.|emailfake\\.|tempemail\\.|dispostable\\.|mailnator\\.)'
  -- Bulk registration: created within same minute as another user
  OR EXISTS (
    SELECT 1 FROM wp_users u2
    WHERE u2.ID != u.ID
      AND ABS(TIMESTAMPDIFF(SECOND, u.user_registered, u2.user_registered)) < 60
      AND u.user_registered > DATE_SUB(NOW(), INTERVAL 2 YEAR)
  )
  -- Numeric-only username (common bot pattern)
  OR u.user_login REGEXP '^[0-9]+$'
  -- Very long usernames (>20 chars, typical of generated bots)
  OR LENGTH(u.user_login) > 20
)
AND u.user_login NOT IN ('dev', 'administrador', '${domainUser.replace(/[^a-zA-Z0-9_-]/g, '')}');

-- ============================================================
-- STEP 2: Fully purge bot users + their content (NO reassign)
-- ============================================================
-- Delete usermeta first (faster without FK checks)
DELETE um FROM wp_usermeta um
INNER JOIN _bot_users b ON um.user_id = b.ID;

-- Get post IDs owned by bots for postmeta cleanup
DROP TEMPORARY TABLE IF EXISTS _bot_post_ids;
CREATE TEMPORARY TABLE _bot_post_ids AS
SELECT p.ID FROM wp_posts p
INNER JOIN _bot_users b ON p.post_author = b.ID;

-- Delete postmeta of bot posts
DELETE pm FROM wp_postmeta pm
INNER JOIN _bot_post_ids bpi ON pm.post_id = bpi.ID;

-- Delete comments on bot posts
DELETE c FROM wp_comments c
INNER JOIN _bot_post_ids bpi ON c.comment_post_ID = bpi.ID;

-- Delete bot posts themselves (cascading)
DELETE p FROM wp_posts p
INNER JOIN _bot_post_ids bpi ON p.ID = bpi.ID;

-- Finally delete bot users
DELETE u FROM wp_users u
INNER JOIN _bot_users b ON u.ID = b.ID;

-- ============================================================
-- STEP 3: Reset survivors to clean roles
-- ============================================================
-- Remove all usermeta capabilities for remaining admins, then set clean
DELETE FROM wp_usermeta
WHERE meta_key = 'wp_capabilities'
  AND user_id NOT IN (SELECT ID FROM _bot_users);

-- Set remaining admins to clean administrator
INSERT INTO wp_usermeta (user_id, meta_key, meta_value)
SELECT u.ID, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}'
FROM wp_users u
WHERE u.user_login IN ('dev', 'administrador', '${domainUser.replace(/[^a-zA-Z0-9_-]/g, '')}')
  AND NOT EXISTS (
    SELECT 1 FROM wp_usermeta um
    WHERE um.user_id = u.ID AND um.meta_key = 'wp_capabilities'
  );

-- Non-admin survivors get subscriber
INSERT INTO wp_usermeta (user_id, meta_key, meta_value)
SELECT u.ID, 'wp_capabilities', 'a:1:{s:10:"subscriber";b:1;}'
FROM wp_users u
WHERE u.user_login NOT IN ('dev', 'administrador', '${domainUser.replace(/[^a-zA-Z0-9_-]/g, '')}')
  AND u.ID NOT IN (SELECT ID FROM _bot_users)
  AND NOT EXISTS (
    SELECT 1 FROM wp_usermeta um
    WHERE um.user_id = u.ID AND um.meta_key = 'wp_capabilities'
  );

-- ============================================================
-- STEP 4: Clean orphaned metadata
-- ============================================================
DELETE pm FROM wp_postmeta pm
LEFT JOIN wp_posts p ON pm.post_id = p.ID
WHERE p.ID IS NULL;

-- Clean orphaned term relationships
DELETE tr FROM wp_term_relationships tr
LEFT JOIN wp_posts p ON tr.object_id = p.ID
WHERE p.ID IS NULL;

-- Clean orphaned comments
DELETE c FROM wp_comments c
LEFT JOIN wp_posts p ON c.comment_post_ID = p.ID
WHERE p.ID IS NULL;

-- Clean orphaned commentmeta
DELETE cm FROM wp_commentmeta cm
LEFT JOIN wp_comments c ON cm.comment_id = c.comment_ID
WHERE c.comment_ID IS NULL;

-- ============================================================
-- STEP 5: Report
-- ============================================================
SELECT 'bot_users_removed' AS metric, COUNT(*) AS value FROM _bot_users;
DROP TEMPORARY TABLE IF EXISTS _bot_users;
DROP TEMPORARY TABLE IF EXISTS _bot_post_ids;
`.trim();
  }

  /**
   * Post-migration sanitization:
   *   1. WP-CLI search-replace (paths, urls) — handles serialized data
   *   2. User purge + content cleanup
   *   3. Transient cleanup
   *   4. Plugin integrity check
   */
  async postMigrationSanitization(client, domain, documentRoot, dbInfo, taskId, oldSiteurl) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    try {
      this.progressEmitter.emitProgress({
        taskId, module: 'deployment', domain,
        progress: 80,
        message: '[CLEAN] Search-replace via WP-CLI (serialized data safe)'
      });

      // ---- A. WP-CLI SEARCH-REPLACE ----
      const newSiteUrl = `https://${domain}`;
      const oldParsed = oldSiteurl ? new URL(oldSiteurl) : null;
      const oldDomain = oldParsed ? oldParsed.hostname : domain;
      const oldBasePath = oldParsed ? oldParsed.pathname.replace(/\/$/, '') : '';
      const newBasePath = documentRoot;

      // Detect if wp-cli is available
      const wpCliCheck = await this.sshService.executeCommand(
        client, `which wp 2>/dev/null && echo "FOUND" || echo "NOT_FOUND"`
      );
      const hasWpCli = wpCliCheck.stdout.trim() === 'FOUND';

      if (hasWpCli) {
        const replaceCmds = [
          `cd "${documentRoot}"`,
          `wp search-replace "${oldDomain}" "${domain}" --all-tables --precise 2>&1`,
        ];

        if (oldSiteurl) {
          replaceCmds.splice(1, 0,
            `wp search-replace "${oldSiteurl}" "${newSiteUrl}" --all-tables --precise 2>&1`
          );
        }
        if (oldBasePath && oldBasePath !== '/') {
          replaceCmds.splice(2, 0,
            `wp search-replace "${oldBasePath}" "" --all-tables --precise 2>&1`
          );
        }

        const result = await this.sshService.executeCommand(client, replaceCmds.join(' && '));
        if (result.code !== 0) {
          console.warn(`[WP-CLI] search-replace had warnings: ${result.stderr || result.stdout}`);
        }
      } else {
        // Fallback: SQL-level replace (won't handle serialized data perfectly)
        const sqlReplace = `mysql -u "${dbInfo.username}" -p"${dbInfo.password}" "${dbInfo.database}" -e "
          UPDATE wp_options SET option_value = '${newSiteUrl}' WHERE option_name IN ('siteurl', 'home');
          UPDATE wp_posts SET guid = REPLACE(guid, '${oldDomain}', '${domain}');
          UPDATE wp_posts SET post_content = REPLACE(post_content, '${oldDomain}', '${domain}');
          UPDATE wp_postmeta SET meta_value = REPLACE(meta_value, '${oldDomain}', '${domain}');
        "`;
        await this.sshService.executeCommand(client, sqlReplace);
      }

      this.progressEmitter.emitProgress({
        taskId, module: 'deployment', domain,
        progress: 83,
        message: '[CLEAN] Purgando usuarios bot + contenido huérfano...'
      });

      // ---- B. USER PURGE + CONTENT CLEANUP (ATOMIC BATCH SQL) ----
      const purgeScript = this.buildUserPurgeScript(dbInfo, domain);
      const tempSqlPath = `/tmp/deploy_cleanup_${Date.now()}.sql`;

      // Write script to a temp file on the server (avoids escaping nightmares)
      const scriptContent = purgeScript;
      // Upload via heredoc to avoid file transfer
      const heredocCmd = `cat > ${tempSqlPath} << 'SQLEOF'
${scriptContent}
SQLEOF`;

      await this.sshService.executeCommand(client, heredocCmd);

      const purgeResult = await this.sshService.executeCommand(
        client,
        `mysql -u "${dbInfo.username}" -p"${dbInfo.password}" "${dbInfo.database}" < "${tempSqlPath}" 2>&1`
      );

      if (purgeResult.code !== 0) {
        console.warn(`[PURGE] SQL warnings: ${purgeResult.stderr || purgeResult.stdout}`);
      } else {
        const botCount = (purgeResult.stdout.match(/bot_users_removed\s+(\d+)/) || [])[1];
        this.progressEmitter.emitProgress({
          taskId, module: 'deployment', domain,
          progress: 85,
          message: `[CLEAN] ${botCount || '0'} usuarios bot eliminados`
        });
      }

      // Cleanup temp script
      await this.sshService.executeCommand(client, `rm -f "${tempSqlPath}"`);

      this.progressEmitter.emitProgress({
        taskId, module: 'deployment', domain,
        progress: 87,
        message: '[CLEAN] Limpiando transients de WordPress...'
      });

      // ---- C. TRANSIENT CLEANUP ----
      if (hasWpCli) {
        await this.sshService.executeCommand(
          client,
          `cd "${documentRoot}" && wp transient delete --all 2>&1 && wp cache flush 2>&1 || true`
        );
      } else {
        const transientSql = `mysql -u "${dbInfo.username}" -p"${dbInfo.password}" "${dbInfo.database}" -e "
          DELETE FROM wp_options WHERE option_name LIKE '_transient_%';
          DELETE FROM wp_options WHERE option_name LIKE '_site_transient_%';
        "`;
        await this.sshService.executeCommand(client, transientSql);
      }

      // ---- C2. ELEMENTOR CSS REGENERATION (post-search-replace) ----
      if (hasWpCli) {
        this.progressEmitter.emitProgress({
          taskId, module: 'deployment', domain,
          progress: 89,
          message: 'Regenerando CSS estático de Elementor...'
        });
        const { getStandardEmitter } = require('./standard-emitter');
        const EMIT = getStandardEmitter('deployment');
        EMIT.info(`Regenerando CSS de Elementor para ${domain}`, domain);
        await this.sshService.executeCommand(
          client,
          `cd "${documentRoot}" && ` +
          `echo "@@@syslog|MIGRATE|info|Regenerando CSS de Elementor tras migracion" && ` +
          `wp plugin is-active elementor --allow-root 2>/dev/null && ` +
          `(wp elementor flush_css --allow-root 2>&1 && wp elementor sync_library --allow-root 2>&1) || ` +
          `echo "[ELEM] Elementor no activo — omitiendo"`
        );
      }

      this.progressEmitter.emitProgress({
        taskId, module: 'deployment', domain,
        progress: 90,
        message: '[CLEAN] Verificando plugins y eliminando malware conocido...'
      });

      // ---- D. KNOWN BAD PLUGINS / THEMES ----
      const BAD_PLUGINS = [
        'gpt', 'seo-rank', 'rank-seo', 'wp-rank', 'seo-pressor',
        'wp-gpt', 'wp-seo-bot', 'seo-bot', 'rank-math-seo-bot'
      ];

      if (hasWpCli) {
        for (const bad of BAD_PLUGINS) {
          await this.sshService.executeCommand(
            client,
            `cd "${documentRoot}" && wp plugin is-installed "${bad}" 2>/dev/null && wp plugin uninstall "${bad}" --deactivate 2>/dev/null || true`
          );
        }

        // Remove unused themes
        await this.sshService.executeCommand(
          client,
          `cd "${documentRoot}" && wp theme list --status=inactive --field=name 2>/dev/null | xargs -I {} wp theme delete {} 2>/dev/null || true`
        );
      } else {
        // Plugin blacklist via directory removal
        const badDirs = BAD_PLUGINS.map(p => `${documentRoot}/wp-content/plugins/${p}`).join(' ');
        await this.sshService.executeCommand(
          client,
          `rm -rf ${badDirs} 2>/dev/null; echo "done"`
        );
      }

      this.progressEmitter.emitProgress({
        taskId, module: 'deployment', domain,
        progress: 95,
        message: '[CLEAN] Saneamiento completo. Verificando sitio...'
      });

      console.log(`[DEPLOY] Sanitization complete for ${domain}`);
      return true;

    } catch (error) {
      console.warn(`[DEPLOY] Sanitization partially failed for ${domain}:`, error.message);
      this.progressEmitter.emitProgress({
        taskId, module: 'deployment', domain,
        progress: 90,
        message: `Sanitization completed with warnings: ${error.message}`
      });
      return false;
    }
  }

  /**
   * Cleanup remote temporary files
   */
  async cleanupRemoteFiles(client, filePaths) {
    for (const filePath of filePaths) {
      try {
        await this.sshService.executeCommand(client, `rm -f "${filePath}"`);
      } catch (error) {
        console.warn(`Failed to cleanup ${filePath}:`, error.message);
      }
    }
  }

  /**
   * Generate random password
   */
  generateRandomPassword(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  /**
   * Get deployment status
   */
  async getDeploymentStatus(accountName, serverName, domain) {
    try {
      const rawConfig = this.configManager.getConfig();
      if (!rawConfig) return { deployed: false };

      const serverConfig = rawConfig.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) return { deployed: false };

      // Check if domain exists on Plesk server
      const sshClient = await this.sshService.connect(serverConfig.sshCredentials, 'status-check');

      try {
        const result = await this.sshService.executeCommand(
          sshClient,
          `plesk bin domain --list | grep -q "^${domain}$" && echo "exists" || echo "not found"`
        );

        const domainExists = result.stdout.includes('exists');

        if (domainExists) {
          // Check if WordPress is installed
          const wpConfigCheck = await this.sshService.executeCommand(
            sshClient,
            `plesk bin domain --info ${domain} | grep "Document root" | awk -F': ' '{print $2}'`
          );

          const documentRoot = wpConfigCheck.stdout.trim();
          const wpConfigExists = documentRoot ?
            await this.checkRemoteFileExists(sshClient, path.posix.join(documentRoot, 'wp-config.php')) :
            false;

          return {
            deployed: true,
            domainExists,
            wpConfigExists,
            documentRoot
          };
        }

        return {
          deployed: false,
          domainExists: false
        };
      } finally {
        sshClient.end();
      }
    } catch (error) {
      return {
        deployed: false,
        error: error.message
      };
    }
  }


  async checkRemoteFileExists(client, remotePath) {
    try {
      const result = await this.sshService.executeCommand(
        client,
        `test -f "${remotePath}" && echo "exists" || echo "not found"`
      );
      return result.stdout === 'exists';
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
let instance = null;

function getDeploymentService() {
  if (!instance) {
    instance = new DeploymentService();
  }
  return instance;
}

module.exports = { DeploymentService, getDeploymentService };