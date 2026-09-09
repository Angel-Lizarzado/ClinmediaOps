// Tests de la capa de cifrado de credenciales de ConfigManager.
//
// Esta es la ruta que puede destruir datos: un descifrado mal resuelto se
// persiste en el siguiente saveConfig() y la credencial se pierde sin error.
// El contrato que se verifica acá es "ante la duda, no tocar el valor".

const mockSafeStorage = {
  available: true,
  isEncryptionAvailable: () => mockSafeStorage.available,
  // Cifrado simulado y reversible: alcanza para verificar el ida y vuelta.
  encryptString: (text) => Buffer.from('enc:' + text, 'utf8'),
  decryptString: (buffer) => {
    const raw = buffer.toString('utf8');
    if (!raw.startsWith('enc:')) throw new Error('payload inválido');
    return raw.slice(4);
  },
};

jest.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: (...args) => mockSafeStorage.isEncryptionAvailable(...args),
    encryptString: (...args) => mockSafeStorage.encryptString(...args),
    decryptString: (...args) => mockSafeStorage.decryptString(...args),
  },
  app: { getPath: () => '/tmp' },
}));

const { ConfigManager } = require('../config-manager');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** Config mínima con una credencial en cada uno de los lugares que se recorren. */
function buildConfig({ password, privateKey, apiToken }) {
  return {
    accounts: [
      { name: 'cuenta', originClouds: [{ name: 'nube', sshCredentials: { password, privateKey } }] },
    ],
    destinationServers: [
      { name: 'plesk-01', sshCredentials: { password, privateKey } },
    ],
    cloudflare: { apiToken },
    hostingerMail: { apiToken },
  };
}

function makeManager(config) {
  const cm = new ConfigManager();
  cm.config = config;
  return cm;
}

beforeEach(() => {
  mockSafeStorage.available = true;
  jest.restoreAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('_looksLikeLegacyBase64', () => {
  const cm = new ConfigManager();

  test.each([
    ['password codificado en base64', b64('MiClaveSecreta123')],
    ['llave privada codificada en base64', b64('-----BEGIN RSA PRIVATE KEY-----\nabc\n')],
    ['valor largo codificado en base64', b64('a'.repeat(2000))],
  ])('reconoce %s', (_desc, value) => {
    expect(cm._looksLikeLegacyBase64(value)).toBe(true);
  });

  test.each([
    ['texto plano con símbolos', 'MyPassword123!'],
    ['texto plano alfabético', 'Contrasena'],
    ['texto plano de largo múltiplo de 4', 'Passw0rd'],
    ['llave privada en texto plano', '-----BEGIN RSA PRIVATE KEY-----'],
    ['string corto', 'abc'],
    ['string vacío', ''],
    ['valor ya cifrado con safeStorage', '__ss__abc'],
  ])('NO confunde %s con base64', (_desc, value) => {
    expect(cm._looksLikeLegacyBase64(value)).toBe(false);
  });
});

describe('ciclo cifrar → descifrar', () => {
  test('devuelve exactamente las credenciales originales', async () => {
    const secretos = {
      password: 'P@ssw0rd con espacios!',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----',
      apiToken: 'cf_token_abc123',
    };
    const cm = makeManager(buildConfig(secretos));

    await cm.encryptConfig();
    const cifrado = cm.config.destinationServers[0].sshCredentials.password;
    expect(cifrado.startsWith('__ss__')).toBe(true);
    expect(cifrado).not.toContain(secretos.password);

    await cm.decryptConfig();
    expect(cm.config.destinationServers[0].sshCredentials.password).toBe(secretos.password);
    expect(cm.config.destinationServers[0].sshCredentials.privateKey).toBe(secretos.privateKey);
    expect(cm.config.accounts[0].originClouds[0].sshCredentials.password).toBe(secretos.password);
    expect(cm.config.cloudflare.apiToken).toBe(secretos.apiToken);
    expect(cm.config.hostingerMail.apiToken).toBe(secretos.apiToken);
  });

  test('cifrar dos veces no produce doble cifrado', async () => {
    const cm = makeManager(buildConfig({ password: 'secreto', privateKey: 'k', apiToken: 't' }));

    await cm.encryptConfig();
    const unaVez = cm.config.destinationServers[0].sshCredentials.password;
    await cm.encryptConfig();
    expect(cm.config.destinationServers[0].sshCredentials.password).toBe(unaVez);

    await cm.decryptConfig();
    expect(cm.config.destinationServers[0].sshCredentials.password).toBe('secreto');
  });
});

describe('el descifrado nunca destruye datos', () => {
  test('un password en texto plano sobrevive intacto', async () => {
    // El bug viejo: se hacía base64-decode de cualquier string > 4 chars,
    // convirtiendo un password en texto plano en basura binaria.
    const plano = 'MyPassword123!';
    const cm = makeManager(buildConfig({ password: plano, privateKey: plano, apiToken: plano }));

    await cm.decryptConfig();

    expect(cm.config.destinationServers[0].sshCredentials.password).toBe(plano);
    expect(cm.config.cloudflare.apiToken).toBe(plano);
  });

  test('un valor cifrado ilegible se preserva en vez de volverse null', async () => {
    // El bug viejo: devolvía null y el siguiente saveConfig() lo persistía,
    // borrando la credencial de forma silenciosa.
    const corrupto = '__ss__no-es-base64-valido!!!';
    const cm = makeManager(buildConfig({ password: corrupto, privateKey: 'x', apiToken: 'y' }));

    await cm.decryptConfig();

    const resultado = cm.config.destinationServers[0].sshCredentials.password;
    expect(resultado).not.toBeNull();
    expect(resultado).toBe(corrupto);
  });

  test('sin safeStorage un valor cifrado se preserva en vez de perderse', async () => {
    const cm = makeManager(buildConfig({ password: 'secreto', privateKey: 'k', apiToken: 't' }));
    await cm.encryptConfig();
    const cifrado = cm.config.destinationServers[0].sshCredentials.password;

    // safeStorage deja de estar disponible (otra máquina, otro perfil de SO)
    mockSafeStorage.available = false;
    await cm.decryptConfig();

    expect(cm.config.destinationServers[0].sshCredentials.password).toBe(cifrado);
  });

  test('migra el formato legacy base64 a texto plano', async () => {
    const plano = 'ClaveLegacy123';
    const cm = makeManager(buildConfig({ password: b64(plano), privateKey: 'x', apiToken: 'y' }));

    await cm.decryptConfig();

    expect(cm.config.destinationServers[0].sshCredentials.password).toBe(plano);
  });
});

describe('_walkSecrets', () => {
  test('tolera una config con secciones faltantes', async () => {
    const cm = makeManager({ accounts: [{ name: 'sin-nubes' }], destinationServers: [{ name: 'sin-creds' }] });
    await expect(cm.encryptConfig()).resolves.not.toThrow();
    await expect(cm.decryptConfig()).resolves.not.toThrow();
  });

  test('ignora los valores vacíos en vez de cifrarlos', async () => {
    const cm = makeManager(buildConfig({ password: '', privateKey: '', apiToken: '' }));
    await cm.encryptConfig();
    expect(cm.config.destinationServers[0].sshCredentials.password).toBe('');
  });
});

describe('protección contra borrado de la configuración', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  let dir;
  let cm;

  /** Config con datos reales, como la del usuario: cuentas y servidores. */
  const configConDatos = () => ({
    accounts: [{ name: 'Clinmedia0', originClouds: [] }],
    destinationServers: [
      { name: 'Sv1', sshCredentials: { host: '1.2.3.4', port: 22, username: 'root' } },
      { name: 'Sv2', sshCredentials: { host: '5.6.7.8', port: 22, username: 'root' } },
    ],
    cloudflare: { apiToken: '' },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
    cm = new ConfigManager();
    cm.configPath = path.join(dir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('se niega a escribir una configuración vacía sobre una con datos', async () => {
    // Este es el escenario que da miedo: la carga falla, la UI queda vacía, el
    // usuario guarda cualquier cosa y se lleva puestos cuentas y servidores.
    fs.writeFileSync(cm.configPath, JSON.stringify(configConDatos()), 'utf8');
    cm.config = cm.getDefaultConfig();

    await expect(cm.saveConfig()).rejects.toThrow(/configuración vacía/i);

    const enDisco = JSON.parse(fs.readFileSync(cm.configPath, 'utf8'));
    expect(enDisco.destinationServers).toHaveLength(2);
    expect(enDisco.accounts).toHaveLength(1);
  });

  test('bloquea el guardado si el config existente no se pudo leer', async () => {
    fs.writeFileSync(cm.configPath, '{ esto no es JSON válido', 'utf8');

    await cm.loadConfig();
    expect(cm.loadFailed).toBe(true);

    cm.config = configConDatos();
    await expect(cm.saveConfig()).rejects.toThrow(/no se pudo leer/i);
  });

  test('guarda una copia del archivo ilegible en vez de perderlo', async () => {
    const original = '{ roto pero valioso';
    fs.writeFileSync(cm.configPath, original, 'utf8');

    await cm.loadConfig();

    const copias = fs.readdirSync(dir).filter((f) => f.includes('.corrupto-'));
    expect(copias).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, copias[0]), 'utf8')).toBe(original);
  });

  test('una carga exitosa posterior levanta el bloqueo', async () => {
    fs.writeFileSync(cm.configPath, 'roto', 'utf8');
    await cm.loadConfig();
    expect(cm.loadFailed).toBe(true);

    fs.writeFileSync(cm.configPath, JSON.stringify(configConDatos()), 'utf8');
    await cm.loadConfig();
    expect(cm.loadFailed).toBe(false);
  });

  test('sí permite guardar cambios legítimos y deja respaldo del anterior', async () => {
    fs.writeFileSync(cm.configPath, JSON.stringify(configConDatos()), 'utf8');
    await cm.loadConfig();

    cm.config.destinationServers.push({
      name: 'Sv3',
      sshCredentials: { host: '9.9.9.9', port: 22, username: 'root' },
    });
    await cm.saveConfig();

    const enDisco = JSON.parse(fs.readFileSync(cm.configPath, 'utf8'));
    expect(enDisco.destinationServers).toHaveLength(3);

    // El respaldo conserva la versión previa
    const previo = JSON.parse(fs.readFileSync(`${cm.configPath}.bak`, 'utf8'));
    expect(previo.destinationServers).toHaveLength(2);
  });

  test('permite el primer guardado cuando no hay archivo todavía', async () => {
    cm.config = cm.getDefaultConfig();
    await expect(cm.saveConfig()).resolves.not.toThrow();
    expect(fs.existsSync(cm.configPath)).toBe(true);
  });
});
