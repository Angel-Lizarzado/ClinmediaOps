const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeStorage } = require('electron');

class ConfigManager {
  constructor() {
    const env = process.env.NODE_ENV || 'development';

    // ── Workspace Path: resolución dinámica ──
    // No se asigna en el constructor — se resuelve bajo demanda
    // para permitir cambios de workspaceRoot en electron-store
    this._workspaceRoot = null;
    this._resolved = false;

    // Ruta del config.json: un nivel arriba del ejecutable (padre de win-unpacked/)
    // para que survivinga independientemente del workspace
    const exeDir = process.execPath ? path.dirname(process.execPath) : process.cwd();
    this.configPath = path.join(path.resolve(exeDir, '..'), 'config.json');

    this.config = null;
    this.env = env;
    // Se pone en true si el config.json existe pero no se pudo leer.
    // Mientras este en true, saveConfig se niega a escribir.
    this.loadFailed = false;
  }

  // ── Resolución dinámica del workspace path ──
  // Prioridad: 1) env var > 2) electron-store > 3) fallback inteligente > 4) legacy
  _resolveWorkspacePath() {
    // 1) Variable de entorno — override absoluto
    const envPath = process.env.CLINMEDIA_OPS_PATH;
    if (envPath && typeof envPath === 'string' && envPath.trim()) {
      const resolved = path.resolve(envPath.trim());
      if (fs.existsSync(resolved)) {
        console.log(`[WORKSPACE] Resuelto por CLINMEDIA_OPS_PATH: ${resolved}`);
        return resolved;
      }
      console.warn(`[WORKSPACE] CLINMEDIA_OPS_PATH existe pero no se encuentra en disco, se usará: ${resolved}`);
      return resolved;
    }

    // 2) electron-store — configurable desde UI, persiste entre sesiones
    if (this.config?.workspaceRoot && typeof this.config.workspaceRoot === 'string' && this.config.workspaceRoot.trim()) {
      const resolved = path.resolve(this.config.workspaceRoot.trim());
      console.log(`[WORKSPACE] Resuelto por config.workspaceRoot: ${resolved}`);
      return resolved;
    }

    // 3) Fallback inteligente: detecta directorios conocidos
    const knownPaths = ['D:\\Centro de Control', 'C:\\Centro de Control'];
    for (const p of knownPaths) {
      if (fs.existsSync(p)) {
        console.log(`[WORKSPACE] Fallback inteligente: detectado en ${p}`);
        return p;
      }
    }

    // 4) Fallback al directorio PADRE del ejecutable (un nivel arriba del .exe)
    // En win-unpacked: .../clinmedia-ops/MyApp.exe → subir dos niveles → .../
    // Allí deben estar respaldos/ y config.json
    const exeDir = process.execPath ? path.dirname(process.execPath) : process.cwd();
    const parentDir = path.resolve(exeDir, '..');
    console.log(`[WORKSPACE] Fallback al directorio padre del ejecutable: ${parentDir}`);
    console.log(`[WORKSPACE] Los backups se guardarán en: ${path.join(parentDir, 'respaldos')}`);
    return parentDir;
  }

  /**
   * Obtiene la ruta raíz del workspace.
   * Resuelve bajo demanda y cachea el resultado en la sesión.
   * Llama a resolve() para refrescar si cambia workspaceRoot en config.
   */
  getWorkspacePath() {
    if (!this._resolved) {
      this._workspaceRoot = this._resolveWorkspacePath();
      this._resolved = true;
    }
    return this._workspaceRoot;
  }

  /**
   * Fuerza re-resolución del workspace path.
   * Útil cuando el usuario cambia workspaceRoot desde la UI.
   */
  refreshWorkspacePath() {
    this._resolved = false;
    return this.getWorkspacePath();
  }

  /**
   * Valida que un path esté DENTRO del workspace root (Anti-Path-Traversal).
   * Lanza Error si el path resuelto escapa del directorio raíz.
   * @param {string} targetPath — ruta a validar
   * @returns {string} — ruta resuelta y segura
   */
  assertPathInsideWorkspace(targetPath) {
    const root = path.resolve(this.getWorkspacePath());
    const resolved = path.resolve(root, targetPath);

    // Si el resolved NO empieza con root, es path traversal
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const normalizedResolved = resolved.replace(/\\/g, '/');
    if (!normalizedResolved.startsWith(normalizedRoot)) {
      throw new Error(
        `[SEGURIDAD] Path traversal bloqueado: "${targetPath}" resuelve fuera del workspace "${root}"`
      );
    }
    return resolved;
  }

  /**
   * Verifica si el workspace actual es inválido (apunta a resources/ o app.asar).
   * @returns {boolean}
   */
  isWorkspacePathInvalid() {
    const ws = this.getWorkspacePath();
    if (!ws) return true;
    const lower = ws.toLowerCase();
    return lower.includes('resources') || lower.includes('app.asar');
  }

  /**
   * Retorna la ruta a la carpeta de respaldos.
   * Convención: workspaceRoot ES la carpeta de respaldos — no se agrega subfolder.
   */
  getRespaldosPath() {
    return this.getWorkspacePath();
  }

  /**
   * Retorna la ruta al directorio temporal para operaciones.
   */
  getTempDownloadPath() {
    const ws = this.getWorkspacePath();
    const tempPath = path.join(ws, 'temp');
    const fs = require('fs');
    if (!fs.existsSync(tempPath)) {
      fs.mkdirSync(tempPath, { recursive: true });
    }
    return tempPath;
  }

  /**
   * Retorna la ruta raíz del workspace (alias de getWorkspacePath).
   */
  getBasePath() {
    return this.getWorkspacePath();
  }

  /**
   * Configura el workspaceRoot en electron-store y refresca la ruta.
   * @param {string} newPath — nueva ruta de workspace
   */
  setWorkspacePath(newPath) {
    if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
      throw new Error('Workspace path inválido');
    }
    const resolved = path.resolve(newPath.trim());

    // Persistir en config
    this.config.workspaceRoot = resolved;
    // No guardamos acá — el caller llama saveConfig() aparte

    // Invalidar caché para que el próximo getWorkspacePath() lo resuelva fresco
    this._resolved = false;
    this._workspaceRoot = null;

    console.log(`[WORKSPACE] Nueva ruta configurada: ${resolved}`);
    return resolved;
  }

  async initialize() {
    try {
      // El cifrado de credenciales lo hace safeStorage de Electron, que maneja
      // su propia clave ligada al usuario/máquina. No hace falta una master key
      // propia (antes se generaba una y se guardaba en el keychain sin usarla).

      // Load config file first (needed for workspaceRoot from electron-store)
      await this.loadConfig();

      // Resolver y autocrear carpeta respaldos de forma segura (sin abortar si el disco está offline)
      try {
        const respaldosPath = this.getRespaldosPath();
        if (respaldosPath && !fs.existsSync(respaldosPath)) {
          fs.mkdirSync(respaldosPath, { recursive: true });
          console.log(`[RESPALDOS] Carpeta creada: ${respaldosPath}`);
        }
      } catch (dirErr) {
        console.warn(`[RESPALDOS] No se pudo preparar carpeta de respaldos (${dirErr.message}). Se continúa con la configuración.`);
      }

      return this.config;
    } catch (error) {
      console.error('Failed to initialize ConfigManager:', error);
      if (!this.config) {
        this.config = this.getDefaultConfig();
      }
      return this.config;
    }
  }

  async loadConfig() {
    // Se limpia en cada carga: una carga exitosa levanta el bloqueo.
    this.loadFailed = false;

    try {
      if (!fs.existsSync(this.configPath)) {
        // Return defaults in-memory only — never create file on disk automatically
        this.config = this.getDefaultConfig();
        console.log('No config file found, using in-memory defaults');
      } else {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(configData);
        await this.decryptConfig();
      }
      this.ensureDefaultSshKey();
      return this.config;
    } catch (error) {
      console.error('Failed to load config:', error);

      // El archivo EXISTE pero no se pudo leer o parsear. Caer a defaults en
      // silencio es lo peligroso: la UI muestra la lista vacía, el usuario
      // agrega un servidor, y el saveConfig siguiente escribe esa config vacía
      // encima de la buena. Se marca el fallo y saveConfig queda bloqueado
      // hasta que alguien resuelva el archivo a mano.
      if (fs.existsSync(this.configPath)) {
        this.loadFailed = true;
        try {
          const rescate = `${this.configPath}.corrupto-${Date.now()}`;
          fs.copyFileSync(this.configPath, rescate);
          console.error(`[CONFIG] Copia del archivo ilegible guardada en: ${rescate}`);
        } catch (copyErr) {
          console.error(`[CONFIG] No se pudo copiar el archivo ilegible: ${copyErr.message}`);
        }
        console.error('[CONFIG] Guardado BLOQUEADO para no sobreescribir la configuración existente.');
      }

      this.config = this.getDefaultConfig();
      return this.config;
    }
  }

  /**
   * Cuenta las entidades que le importan al usuario. Sirve para detectar el
   * caso "estoy por escribir una config vacía encima de una con datos".
   */
  _countEntities(config) {
    if (!config) return 0;
    const cuentas = Array.isArray(config.accounts) ? config.accounts.length : 0;
    const servidores = Array.isArray(config.destinationServers) ? config.destinationServers.length : 0;
    return cuentas + servidores;
  }

  /**
   * Red de seguridad antes de escribir: nunca sustituir una configuración con
   * datos por una vacía. Sin esto, cualquier carga fallida seguida de un
   * guardado borraba cuentas y servidores en silencio.
   * @throws {Error} si la escritura destruiría datos
   */
  _assertSafeToSave() {
    if (this.loadFailed) {
      throw new Error(
        '[CONFIG] Guardado bloqueado: el config.json existente no se pudo leer. ' +
        'Se guardó una copia junto al original. Resolvé ese archivo antes de guardar, ' +
        'o la configuración actual se perdería.'
      );
    }

    if (this._countEntities(this.config) > 0) return;
    if (!fs.existsSync(this.configPath)) return;

    // La config en memoria está vacía. Si en disco hay datos, esto es un borrado.
    let enDisco = 0;
    try {
      enDisco = this._countEntities(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
    } catch (_) {
      // Ilegible: lo trata loadFailed. Acá no se bloquea por esto.
      return;
    }

    if (enDisco > 0) {
      throw new Error(
        `[CONFIG] Guardado bloqueado: se intentó escribir una configuración vacía sobre ` +
        `${enDisco} cuentas/servidores existentes en ${this.configPath}. ` +
        'Es casi seguro un error de carga, no una acción intencional.'
      );
    }
  }

  async saveConfig() {
    // Antes de cifrar nada: comprobar que la escritura no destruya datos.
    this._assertSafeToSave();

    try {
      // Encrypt sensitive fields before saving
      await this.encryptConfig();

      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Escritura atómica: se escribe a un temporal y se renombra. Un corte a
      // mitad de camino dejaba antes un config.json truncado, sin credenciales.
      const tmpPath = `${this.configPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), 'utf8');

      // Guardar la version anterior antes de sustituirla. Cuesta nada y es la
      // diferencia entre un susto y una perdida real.
      if (fs.existsSync(this.configPath)) {
        try {
          fs.copyFileSync(this.configPath, `${this.configPath}.bak`);
        } catch (bakErr) {
          console.warn(`[CONFIG] No se pudo respaldar el config previo: ${bakErr.message}`);
        }
      }

      fs.renameSync(tmpPath, this.configPath);

      console.log('Config saved successfully');
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    } finally {
      // Siempre volver a texto plano en memoria, incluso si la escritura falló.
      // Si no, la config en memoria quedaba cifrada y todo aguas abajo rompía.
      await this.decryptConfig();
    }
  }

  // ── Cifrado de credenciales ───────────────────────────────────────────────
  //
  // Formato actual: prefijo `__ss__` + safeStorage de Electron (ligado al
  // usuario/máquina). Formato legacy: base64 pelado, que NO es cifrado.
  //
  // Regla de oro: ante cualquier duda, se devuelve el valor original intacto.
  // Nunca se devuelve null — antes se hacía, y el siguiente saveConfig()
  // persistía ese null, borrando la credencial sin un solo error visible.

  static get SS_PREFIX() { return '__ss__'; }

  /**
   * Recorre todas las credenciales de la config aplicando `fn` a cada valor
   * sensible. Un solo lugar en vez de tres bloques duplicados por operación.
   * @param {(value: string, label: string) => string} fn
   */
  _walkSecrets(fn) {
    const applyTo = (holder, label) => {
      if (!holder?.sshCredentials) return;
      for (const field of ['privateKey', 'password']) {
        const value = holder.sshCredentials[field];
        if (typeof value === 'string' && value.length > 0) {
          holder.sshCredentials[field] = fn(value, `${label}.${field}`);
        }
      }
    };

    for (const account of this.config.accounts || []) {
      for (const cloud of account.originClouds || []) {
        applyTo(cloud, `cloud "${cloud.name || '?'}"`);
      }
    }

    for (const server of this.config.destinationServers || []) {
      applyTo(server, `servidor "${server.name || '?'}"`);
    }

    for (const [section, field] of [['cloudflare', 'apiToken'], ['hostingerMail', 'apiToken']]) {
      const value = this.config[section]?.[field];
      if (typeof value === 'string' && value.length > 0) {
        this.config[section][field] = fn(value, `${section}.${field}`);
      }
    }
  }

  /**
   * Decide si un string es base64 legacy de verdad, no un texto plano que
   * "casualmente" usa caracteres del alfabeto base64.
   *
   * Antes se decodificaba cualquier string de más de 4 chars, lo que convertía
   * una contraseña en texto plano en basura binaria. Acá se exige que el valor
   * sobreviva un round-trip exacto Y que lo decodificado sea texto imprimible.
   */
  _looksLikeLegacyBase64(value) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    if (value.length % 4 !== 0) return false;

    let decoded;
    try {
      decoded = Buffer.from(value, 'base64').toString('utf8');
    } catch {
      return false;
    }

    // Round-trip exacto: si no vuelve idéntico, no era base64.
    if (Buffer.from(decoded, 'utf8').toString('base64') !== value) return false;
    if (decoded.length === 0) return false;

    // Lo decodificado tiene que ser texto usable, no bytes de control.
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i);
      const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13;
      if (isControl) return false;
    }

    return true;
  }

  /**
   * Cifra un único valor. Idempotente: un valor ya cifrado se devuelve tal cual,
   * así un doble saveConfig() no produce doble cifrado.
   */
  _encryptValue(value, label) {
    if (value.startsWith(ConfigManager.SS_PREFIX)) return value;

    if (!safeStorage.isEncryptionAvailable()) {
      // Sin safeStorage no hay cifrado real posible. Se deja en texto plano
      // a propósito: base64 no protege nada y solo enmascara el problema.
      console.warn(`[CONFIG] safeStorage no disponible — "${label}" queda SIN cifrar en disco.`);
      return value;
    }

    try {
      const encrypted = safeStorage.encryptString(value);
      return ConfigManager.SS_PREFIX + encrypted.toString('base64');
    } catch (err) {
      console.error(`[CONFIG] Falló el cifrado de "${label}": ${err.message}. Se preserva el valor original.`);
      return value;
    }
  }

  /**
   * Descifra un único valor. Nunca destruye datos: si algo falla, devuelve
   * el valor tal como vino y lo reporta.
   */
  _decryptValue(value, label) {
    if (value.startsWith(ConfigManager.SS_PREFIX)) {
      if (!safeStorage.isEncryptionAvailable()) {
        console.error(`[CONFIG] "${label}" está cifrado con safeStorage pero safeStorage no está disponible. Se preserva cifrado (fallará aguas abajo).`);
        return value;
      }
      try {
        const buffer = Buffer.from(value.slice(ConfigManager.SS_PREFIX.length), 'base64');
        return safeStorage.decryptString(buffer);
      } catch (err) {
        console.error(`[CONFIG] No se pudo descifrar "${label}": ${err.message}. Se preserva el valor cifrado para no perderlo.`);
        return value;
      }
    }

    // Migración desde el formato legacy (base64 pelado).
    if (this._looksLikeLegacyBase64(value)) {
      try {
        return Buffer.from(value, 'base64').toString('utf8');
      } catch {
        return value;
      }
    }

    // Texto plano: se devuelve intacto.
    return value;
  }

  async encryptConfig() {
    this._walkSecrets((value, label) => this._encryptValue(value, label));
  }

  async decryptConfig() {
    this._walkSecrets((value, label) => this._decryptValue(value, label));
  }

  ensureDefaultSshKey() {
    if (!this.config.sshKeys) {
      this.config.sshKeys = {};
    }
    if (!this.config.sshKeys.publicKeyPath) {
      this.config.sshKeys.publicKeyPath = path.join(os.homedir(), '.ssh', 'id_rsa.pub');
      console.log('Default SSH public key set:', this.config.sshKeys.publicKeyPath);
    }
  }

  getDefaultConfig() {
    return {
      sshKeys: {
        privateKeyPath: "",
        publicKeyPath: ""
      },
      accounts: [],
      destinationServers: [],
      cloudflare: {
        apiToken: "",
        zoneId: ""
      },
      elementorPro: {
        zipPath: "",
        licenseKey: ""
      },
      googleDrive: {
        credentialsPath: "",
        rootFolderId: ""
      },
      workspaceRoot: ""
    };
  }

  getConfig() {
    return this.config;
  }

  getConfigPath() {
    return this.configPath;
  }

  updateConfig(newConfig) {
    const oldWorkspaceRoot = this.config?.workspaceRoot;
    this.config = { ...this.config, ...newConfig };

    // Si cambió workspaceRoot, invalidar caché para re-resolución
    if (newConfig.workspaceRoot && newConfig.workspaceRoot !== oldWorkspaceRoot) {
      this._resolved = false;
      this._workspaceRoot = null;
      console.log(`[WORKSPACE] workspaceRoot cambió: "${oldWorkspaceRoot}" → "${newConfig.workspaceRoot}"`);
    }

    return this.saveConfig();
  }

  getAccountByName(name) {
    return this.config.accounts.find(account => account.name === name);
  }

  getOriginCloud(accountName, cloudName) {
    const account = this.getAccountByName(accountName);
    if (!account) return null;
    return account.originClouds?.find(cloud => cloud.name === cloudName);
  }

  getDestinationServer(serverName) {
    if (!this.config.destinationServers) return null;
    return this.config.destinationServers.find(server => server.name === serverName);
  }
}

// Singleton instance
let instance = null;

function getConfigManager() {
  if (!instance) {
    instance = new ConfigManager();
  }
  return instance;
}

module.exports = { ConfigManager, getConfigManager };