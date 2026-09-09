// Tests del script bash de verificación.
//
// Acá no se ejecuta el script: hace pedidos HTTP reales contra el dominio y
// consulta wp-cli, así que fuera del servidor no tiene nada que verificar. Lo
// que sí se comprueba es que el texto generado sea válido (`bash -n`) y que
// contenga las decisiones que hacen honesta la verificación: --resolve contra
// 127.0.0.1 y una sonda PHP real en uploads que se borra después.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildVerifyScript } = require('../verifyScript');
const { MEASURE_IDS, LOGIN_SLUG } = require('../constants');

const DOMINIO = 'ejemplo.test';

const construir = (medidas) => buildVerifyScript({ domain: DOMINIO, measures: medidas });

/** Marcador que emite cada medida cuando está seleccionada. */
const HUELLA = {
  wpconfig: 'emit_check "wpconfig"',
  files: 'emit_check "files"',
  xmlrpc: 'emit_check "xmlrpc"',
  login: 'emit_check "login"',
  restapi: 'emit_check "restapi"',
  sanitize: 'emit_check "sanitize"',
};

function hayBash() {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

const BASH_OK = hayBash();

describe('buildVerifyScript — selección de medidas', () => {
  test('solo se generan las comprobaciones de las medidas pedidas', () => {
    const script = construir(['wpconfig']);

    expect(script).toContain(HUELLA.wpconfig);
    expect(script).toContain('DISALLOW_FILE_EDIT');
    expect(script).not.toContain(HUELLA.files);
    expect(script).not.toContain(HUELLA.xmlrpc);
    expect(script).not.toContain(HUELLA.login);
    expect(script).not.toContain(HUELLA.restapi);
    expect(script).not.toContain(HUELLA.sanitize);
  });

  test('cada medida aporta únicamente su propio bloque', () => {
    const conBloque = ['wpconfig', 'files', 'xmlrpc', 'login', 'restapi', 'sanitize'];

    for (const medida of conBloque) {
      const script = construir([medida]);
      expect(script).toContain(HUELLA[medida]);

      for (const otra of conBloque) {
        if (otra !== medida) expect(script).not.toContain(HUELLA[otra]);
      }
    }
  });

  test('sin medidas solo queda el preámbulo de entorno', () => {
    const script = construir([]);

    expect(script).toContain('emit_check "entorno" "webserver"');
    for (const huella of Object.values(HUELLA)) {
      expect(script).not.toContain(huella);
    }
  });

  test('una medida desconocida no agrega nada ni rompe la generación', () => {
    const script = construir(['inexistente']);
    expect(script).toContain('emit_check "entorno" "webserver"');
    for (const huella of Object.values(HUELLA)) {
      expect(script).not.toContain(huella);
    }
  });

  test('pedir todas las medidas conocidas genera el script completo', () => {
    const script = construir([...MEASURE_IDS]);
    for (const medida of Object.keys(HUELLA)) {
      expect(script).toContain(HUELLA[medida]);
    }
    expect(script).toContain('[VERIFICACION OK]');
  });
});

describe('buildVerifyScript — decisiones de la verificación', () => {
  test('los pedidos se resuelven contra SERVER_IP y no contra el DNS público', () => {
    // Durante una migración el DNS todavía apunta al hosting de origen: sin
    // --resolve se estaría verificando el servidor equivocado.
    const script = construir(['files', 'xmlrpc', 'login', 'restapi']);

    expect(script).toContain(`--resolve "$DOMAIN:443:$SERVER_IP"`);
    expect(script).toContain(`--resolve "$DOMAIN:80:$SERVER_IP"`);

    // Ningún curl sale sin --resolve
    const lineasCurl = script.split('\n').filter((l) => l.includes('curl '));
    expect(lineasCurl.length).toBeGreaterThan(0);
    for (const linea of lineasCurl) {
      const bloque = script.slice(script.indexOf(linea), script.indexOf(linea) + 400);
      expect(bloque).toContain('--resolve');
    }
  });

  test('la comprobación de uploads deja una sonda PHP real y la borra', () => {
    // Que el .htaccess exista no prueba que Apache lo esté leyendo: la única
    // prueba honesta es pedir un .php de verdad y mirar el código.
    const script = construir(['files']);

    expect(script).toContain('PROBE="kraken-probe-$$.php"');
    expect(script).toContain(`printf '<?php echo "kraken-probe"; ' > "$UPLOADS/$PROBE"`);
    expect(script).toContain('http_code_noredir "wp-content/uploads/$PROBE"');
    expect(script).toContain('rm -f "$UPLOADS/$PROBE"');

    // El borrado va después del pedido, no antes
    expect(script.indexOf('rm -f "$UPLOADS/$PROBE"')).toBeGreaterThan(
      script.indexOf('http_code_noredir "wp-content/uploads/$PROBE"')
    );
  });

  test('marca como n/a las comprobaciones de .htaccess cuando el dominio lo sirve nginx', () => {
    const script = construir(['files', 'xmlrpc']);

    expect(script).toContain('APACHE_OK=0');
    expect(script).toContain('emit_check "files" "uploads_php" "n/a"');
    expect(script).toContain('emit_check "xmlrpc" "xmlrpc_http" "n/a"');
  });

  test('los ajustes de base de datos se verifican también sin Apache', () => {
    const script = construir(['xmlrpc']);
    const posCierreNginx = script.indexOf('# Ajustes de base de datos');

    expect(posCierreNginx).toBeGreaterThan(-1);
    expect(script.slice(posCierreNginx)).toContain('emit_check "xmlrpc" "registro"');
    expect(script.slice(posCierreNginx)).toContain('emit_check "xmlrpc" "comentarios"');
  });

  test('la medida de login comprueba el slug nuevo y que el viejo ya no responda', () => {
    const script = construir(['login']);

    expect(script).toContain('http_code_noredir "$SLUG_TO_CHECK"');
    expect(script).toContain('http_code_noredir "wp-login.php"');
    expect(script).toContain('kraken_captcha');
  });

  test('la medida de REST API comprueba la enumeración de usuarios', () => {
    const script = construir(['restapi']);
    expect(script).toContain('http_code_noredir "wp-json/wp/v2/users"');
  });

  test('el dominio va entrecomillado en el script', () => {
    const script = buildVerifyScript({ domain: "raro'dominio.test", measures: ['wpconfig'] });
    expect(script).toContain(`DOMAIN='raro'\\''dominio.test'`);
  });
});

// ── Validación sintáctica del bash generado ───────────────────────────────────

const describeBash = BASH_OK ? describe : describe.skip;

if (!BASH_OK) {
  // eslint-disable-next-line no-console
  console.warn('[blindaje] bash no disponible: se omite la validación sintáctica del script de verificación.');
}

describeBash('buildVerifyScript — sintaxis', () => {
  let raiz;

  beforeAll(() => {
    raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-test-verify-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 3 });
    } catch (_) {
      // Un tmpdir que no se pudo borrar no debe tumbar la suite.
    }
  });

  /** Corre `bash -n` (solo parseo, no ejecuta nada) sobre el script generado. */
  function validar(script, nombre) {
    const destino = path.join(raiz, nombre);
    fs.writeFileSync(destino, script);
    const posix = destino.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, letra) => `/${letra.toLowerCase()}`);
    execFileSync('bash', ['-n', posix], { encoding: 'utf8', windowsHide: true });
  }

  test('el script con todas las medidas pasa bash -n', () => {
    expect(() => validar(construir([...MEASURE_IDS]), 'todas.sh')).not.toThrow();
  });

  test.each(['wpconfig', 'files', 'xmlrpc', 'login', 'restapi', 'sanitize'])(
    'el script de la medida %s pasa bash -n',
    (medida) => {
      expect(() => validar(construir([medida]), `${medida}.sh`)).not.toThrow();
    }
  );

  test('un dominio con comilla simple no rompe la sintaxis del script', () => {
    const script = buildVerifyScript({ domain: "raro'dominio.test", measures: [...MEASURE_IDS] });
    expect(() => validar(script, 'comillas.sh')).not.toThrow();
  });
});
