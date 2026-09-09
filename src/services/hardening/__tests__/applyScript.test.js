// Tests del script bash de blindaje.
//
// El valor de estos tests NO está en comparar strings del script generado:
// está en EJECUTAR el bash contra un WordPress de mentira y mirar los archivos
// que quedan. El bug que motivó la reescritura (marcadores PHP huérfanos que se
// acumulaban en cada pasada) era invisible leyendo el generador y evidente
// corriéndolo tres veces seguidas.
//
// El fixture arma un árbol de vhosts completo en el tmpdir y planta stubs de
// `plesk` y `php` en el PATH del proceso hijo: el script los invoca y no hay
// ninguno de los dos en un entorno de desarrollo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const {
  buildApplyScript,
  buildUnlockScript,
  orderMeasures,
  APPLY_ORDER,
} = require('../applyScript');
const { DEFAULT_MEASURES } = require('../constants');

// Cada test levanta bash una o varias veces: en Windows el spawn es caro y el
// timeout por defecto de 5 s se queda corto.
jest.setTimeout(120000);

const DOMINIO = 'ejemplo.test';

// Medidas ejercitadas por los tests de ejecución. Se listan explícitas en vez
// de usar DEFAULT_MEASURES para que el fixture no dependa de qué medidas se
// agreguen al módulo después.
const MEDIDAS_COMPLETAS = ['files', 'xmlrpc', 'restapi', 'login', 'wpconfig'];

/** Git Bash recibe rutas POSIX: C:\a\b → /c/a/b */
function aRutaMsys(rutaWindows) {
  return rutaWindows.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, letra) => `/${letra.toLowerCase()}`);
}

/** ¿Hay un bash utilizable? Sin él estos tests no tienen nada que ejercitar. */
function hayBash() {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

const BASH_OK = hayBash();

// ── Contenido del WordPress de mentira ────────────────────────────────────────

/** wp-config.php realista: defines de DB, prefijo, "stop editing" y wp-settings. */
const WP_CONFIG_REALISTA = [
  '<?php',
  '/**',
  ' * Configuración base de WordPress.',
  ' */',
  '',
  "define( 'DB_NAME', 'wp_ejemplo' );",
  "define( 'DB_USER', 'usuario_wp' );",
  "define( 'DB_PASSWORD', 'clave-secreta' );",
  "define( 'DB_HOST', 'localhost' );",
  "define( 'DB_CHARSET', 'utf8mb4' );",
  '',
  "define( 'AUTH_KEY',  'una-clave-larga-y-aleatoria' );",
  "define( 'AUTH_SALT', 'otra-clave-larga-y-aleatoria' );",
  '',
  "$table_prefix = 'wp_';",
  '',
  "define( 'WP_DEBUG', false );",
  '',
  "/* That's all, stop editing! Happy publishing. */",
  '',
  "if ( ! defined( 'ABSPATH' ) ) {",
  "    define( 'ABSPATH', __DIR__ . '/' );",
  '}',
  '',
  "require_once ABSPATH . 'wp-settings.php';",
  '',
].join('\n');

/** .htaccess con el bloque que instala WordPress ya presente. */
const HTACCESS_WORDPRESS = [
  '# BEGIN WordPress',
  '<IfModule mod_rewrite.c>',
  'RewriteEngine On',
  'RewriteBase /',
  'RewriteRule ^index\\.php$ - [L]',
  'RewriteCond %{REQUEST_FILENAME} !-f',
  'RewriteCond %{REQUEST_FILENAME} !-d',
  'RewriteRule . /index.php [L]',
  '</IfModule>',
  '# END WordPress',
  '',
].join('\n');

// ── Fixture ───────────────────────────────────────────────────────────────────

let raices = [];

/**
 * Arma un vhosts de mentira con un WordPress dentro y los stubs de PATH.
 *
 * @param {object} [opts]
 * @param {string} [opts.wpConfig]    Contenido de wp-config.php
 * @param {string} [opts.htaccess]    Contenido del .htaccess de la raíz
 * @param {boolean} [opts.phpValido]  Si false, el stub de `php -l` falla y el
 *   script debe revertir wp-config.php desde el respaldo.
 */
function crearEntorno(opts = {}) {
  const { wpConfig = WP_CONFIG_REALISTA, htaccess = HTACCESS_WORDPRESS, phpValido = true } = opts;

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-test-'));
  raices.push(raiz);

  // Stubs de los binarios que el script invoca y que no existen en desarrollo.
  // `plesk` siempre sale 0: eso hace que `plugin is-installed` responda que sí
  // y el camino feliz de la medida de login se recorra entero.
  const bin = path.join(raiz, 'bin');
  fs.mkdirSync(bin);
  escribirStub(path.join(bin, 'plesk'), 0);
  escribirStub(path.join(bin, 'php'), phpValido ? 0 : 1);

  const webRoot = path.join(raiz, DOMINIO, 'httpdocs');
  fs.mkdirSync(path.join(webRoot, 'wp-content', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'wp-config.php'), wpConfig);
  fs.writeFileSync(path.join(webRoot, '.htaccess'), htaccess);
  fs.writeFileSync(path.join(webRoot, 'index.php'), "<?php\nrequire __DIR__ . '/wp-blog-header.php';\n");

  // PATH del hijo con los stubs adelante. Se limpia cualquier variante de
  // capitalización: en Windows conviven `Path` y `PATH` y bash toma la última.
  const env = {};
  for (const clave of Object.keys(process.env)) {
    if (!/^path$/i.test(clave)) env[clave] = process.env[clave];
  }
  env.PATH = bin + path.delimiter + process.env.PATH;

  return { raiz, webRoot, env, vhostsRoot: aRutaMsys(raiz) };
}

function escribirStub(destino, codigoSalida) {
  fs.writeFileSync(destino, `#!/bin/bash\nexit ${codigoSalida}\n`, { mode: 0o755 });
  try {
    fs.chmodSync(destino, 0o755);
  } catch (_) {
    // En Windows chmod es best-effort; bash resuelve la ejecución por shebang.
  }
}

/** Escribe el script en disco y lo corre con bash. Devuelve su stdout. */
function correr(entorno, script, nombre = 'script.sh') {
  const destino = path.join(entorno.raiz, nombre);
  fs.writeFileSync(destino, script);
  return execFileSync('bash', [aRutaMsys(destino)], {
    encoding: 'utf8',
    env: entorno.env,
    windowsHide: true,
  });
}

/** Corre el blindaje `veces` veces sobre el mismo entorno. */
function aplicar(entorno, medidas = MEDIDAS_COMPLETAS, veces = 1, extra = {}) {
  const script = buildApplyScript({
    domain: DOMINIO,
    measures: medidas,
    vhostsRoot: entorno.vhostsRoot,
    ...extra,
  });
  let salida = '';
  for (let i = 0; i < veces; i += 1) salida = correr(entorno, script);
  return salida;
}

const leer = (entorno, relativa) => fs.readFileSync(path.join(entorno.webRoot, relativa), 'utf8');
const existe = (entorno, relativa) => fs.existsSync(path.join(entorno.webRoot, relativa));
const contar = (texto, aguja) => texto.split(aguja).length - 1;

/** Hash de cada archivo del árbol, para comprobar que dry-run no tocó nada. */
function hashearArbol(directorio) {
  const mapa = {};
  const recorrer = (actual, prefijo) => {
    for (const entrada of fs.readdirSync(actual, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const completa = path.join(actual, entrada.name);
      const relativa = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
      if (entrada.isDirectory()) {
        mapa[`${relativa}/`] = 'dir';
        recorrer(completa, relativa);
      } else {
        mapa[relativa] = crypto.createHash('md5').update(fs.readFileSync(completa)).digest('hex');
      }
    }
  };
  recorrer(directorio, '');
  return mapa;
}

afterEach(() => {
  for (const raiz of raices) {
    try {
      fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 3 });
    } catch (_) {
      // Un tmpdir que no se pudo borrar no debe tumbar la suite.
    }
  }
  raices = [];
});

// ── Generación del script: orden de medidas ───────────────────────────────────

describe('buildApplyScript — orden de aplicación', () => {
  test('ordena las medidas según APPLY_ORDER sin importar cómo se pidieron', () => {
    expect(orderMeasures(['wpconfig', 'login', 'files'])).toEqual(['files', 'login', 'wpconfig']);
    expect(orderMeasures(['login', 'wpconfig'])).toEqual(['login', 'wpconfig']);
  });

  test('APPLY_ORDER deja wpconfig al final: es la dependencia real', () => {
    expect(APPLY_ORDER[APPLY_ORDER.length - 1]).toBe('wpconfig');
  });

  test('el bloque de wpconfig se emite DESPUÉS del de login aunque se pidan al revés', () => {
    // DISALLOW_FILE_MODS bloquea instalar plugins; si el candado se escribe
    // antes, la instalación de WPS Hide Login falla en silencio.
    const script = buildApplyScript({ domain: DOMINIO, measures: ['wpconfig', 'login'] });

    const posLogin = script.indexOf('emit_progress "login" "Instalando reto anti-bot');
    const posWpconfig = script.indexOf('emit_progress "wpconfig" "Escribiendo el candado');

    expect(posLogin).toBeGreaterThan(-1);
    expect(posWpconfig).toBeGreaterThan(-1);
    expect(posWpconfig).toBeGreaterThan(posLogin);
  });

  test('con las medidas por defecto el candado sigue siendo lo último que se escribe', () => {
    const script = buildApplyScript({ domain: DOMINIO, measures: [...DEFAULT_MEASURES].reverse() });
    const posWpconfig = script.indexOf('emit_progress "wpconfig" "Escribiendo el candado');
    const posLogin = script.indexOf('emit_progress "login" "Instalando reto anti-bot');
    expect(posWpconfig).toBeGreaterThan(posLogin);
  });

  test('solo se generan las secciones de las medidas pedidas', () => {
    const script = buildApplyScript({ domain: DOMINIO, measures: ['restapi'] });
    expect(script).toContain('emit_progress "restapi"');
    expect(script).not.toContain('emit_progress "login" "Instalando reto anti-bot');
    expect(script).not.toContain('emit_progress "wpconfig" "Escribiendo el candado');
    expect(script).not.toContain('emit_progress "sanitize"');
  });

  test('reinstall genera soporte para Elementor Pro cuando se configuran zip y licencia', () => {
    const script = buildApplyScript({
      domain: DOMINIO,
      measures: ['reinstall'],
      elementorPro: { zipPath: '/path/to/ep.zip', licenseKey: 'test-license-123' },
    });
    expect(script).toContain('emit_progress "reinstall"');
    expect(script).toContain("_EP_LICENSE='test-license-123'");
    expect(script).toContain('Reinstalando Elementor Pro desde ZIP configurado');
    expect(script).toContain('run_wp elementor-pro license activate "$_EP_LICENSE"');
  });
});

// ── Ejecución real del bash generado ──────────────────────────────────────────

const describeBash = BASH_OK ? describe : describe.skip;

if (!BASH_OK) {
  // eslint-disable-next-line no-console
  console.warn('[blindaje] bash no disponible: se omiten los tests de ejecución del script.');
}

describeBash('buildApplyScript — ejecución contra un WordPress de mentira', () => {
  test('el script corre limpio y reporta cada medida como aplicada', () => {
    const entorno = crearEntorno();
    const salida = aplicar(entorno);

    expect(salida).toContain('[BLINDAJE OK]');
    expect(salida).toContain('"measure":"files","applied":true');
    expect(salida).toContain('"measure":"xmlrpc","applied":true');
    expect(salida).toContain('"measure":"restapi","applied":true');
    expect(salida).toContain('"measure":"login","applied":true');
    expect(salida).toContain('"measure":"wpconfig","applied":true');
  });

  test('tres pasadas dejan UN solo bloque de marcadores en wp-config.php', () => {
    // Regresión del bug real: los marcadores PHP `/* BEGIN ... */` se borraban
    // con un rango de sed, que los interpreta como expresión regular. El `*`
    // cuantificaba el carácter previo, el rango nunca matcheaba y cada pasada
    // dejaba un bloque huérfano más.
    const entorno = crearEntorno();
    aplicar(entorno, MEDIDAS_COMPLETAS, 3);

    const config = leer(entorno, 'wp-config.php');
    expect(contar(config, '/* BEGIN KRAKEN-HARDENING */')).toBe(1);
    expect(contar(config, '/* END KRAKEN-HARDENING */')).toBe(1);
    expect(contar(config, 'DISALLOW_FILE_EDIT')).toBe(1);
    expect(contar(config, 'DISALLOW_FILE_MODS')).toBe(1);
  });

  test('tres pasadas dejan UN solo bloque de marcadores en el .htaccess', () => {
    const entorno = crearEntorno();
    aplicar(entorno, MEDIDAS_COMPLETAS, 3);

    const htaccess = leer(entorno, '.htaccess');
    expect(contar(htaccess, '# BEGIN KRAKEN-HARDENING')).toBe(1);
    expect(contar(htaccess, '# END KRAKEN-HARDENING')).toBe(1);
    expect(contar(htaccess, '# BEGIN WordPress')).toBe(1);
  });

  test('el .htaccess queda byte por byte idéntico a partir de la primera pasada', () => {
    const entorno = crearEntorno();
    aplicar(entorno);
    const trasPrimera = leer(entorno, '.htaccess');
    aplicar(entorno, MEDIDAS_COMPLETAS, 2);

    expect(leer(entorno, '.htaccess')).toBe(trasPrimera);
  });

  // REGRESIÓN: hubo dos versiones de este bug.
  //   1) `sed` con rango no matcheaba los marcadores PHP ("/* ... */") porque
  //      el "*" es metacaracter: los marcadores quedaban huérfanos y el bloque
  //      entero se duplicaba en cada pasada.
  //   2) El bloque se insertaba con una línea en blanco FUERA del rango
  //      BEGIN..END, que strip_block no borra: el archivo ganaba un salto de
  //      línea por pasada y crecía sin techo en dominios reblindados.
  // Este test cubre las dos: exige igualdad byte por byte.
  test('wp-config.php queda byte por byte idéntico a partir de la primera pasada', () => {
    const entorno = crearEntorno();
    aplicar(entorno);
    const trasPrimera = leer(entorno, 'wp-config.php');
    aplicar(entorno, MEDIDAS_COMPLETAS, 4);

    expect(leer(entorno, 'wp-config.php')).toBe(trasPrimera);
  });

  test('no se acumulan líneas en blanco entre pasadas', () => {
    // Guarda explícita del segundo bug: si vuelve a insertarse un blanco fuera
    // del bloque marcado, el conteo de líneas crece y esto salta.
    const entorno = crearEntorno();
    aplicar(entorno);
    const lineasPrimera = leer(entorno, 'wp-config.php').split('\n').length;
    aplicar(entorno, MEDIDAS_COMPLETAS, 3);

    expect(leer(entorno, 'wp-config.php').split('\n').length).toBe(lineasPrimera);
  });

  test('el resto de wp-config.php sobrevive intacto', () => {
    const entorno = crearEntorno();
    aplicar(entorno, MEDIDAS_COMPLETAS, 3);

    const config = leer(entorno, 'wp-config.php');
    expect(config).toContain("require_once ABSPATH . 'wp-settings.php';");
    expect(config).toContain("define( 'DB_NAME', 'wp_ejemplo' );");
    expect(config).toContain("define( 'DB_USER', 'usuario_wp' );");
    expect(config).toContain("define( 'DB_PASSWORD', 'clave-secreta' );");
    expect(config).toContain("$table_prefix = 'wp_';");
    expect(config).toContain("define( 'AUTH_SALT', 'otra-clave-larga-y-aleatoria' );");
    expect(config.startsWith('<?php')).toBe(true);
  });

  test('las constantes quedan ANTES de la línea "stop editing"', () => {
    // Después de esa línea WordPress ya cargó wp-settings.php: un define ahí
    // llega tarde y no tiene efecto.
    const entorno = crearEntorno();
    aplicar(entorno);

    const lineas = leer(entorno, 'wp-config.php').split('\n');
    const lineaBegin = lineas.findIndex((l) => l.includes('BEGIN KRAKEN-HARDENING'));
    const lineaEnd = lineas.findIndex((l) => l.includes('END KRAKEN-HARDENING'));
    const lineaStop = lineas.findIndex((l) => l.includes('stop editing'));
    const lineaRequire = lineas.findIndex((l) => l.includes("require_once ABSPATH . 'wp-settings.php';"));

    expect(lineaBegin).toBeGreaterThan(-1);
    expect(lineaStop).toBeGreaterThan(-1);
    expect(lineaBegin).toBeLessThan(lineaStop);
    expect(lineaEnd).toBeLessThan(lineaStop);
    expect(lineaStop).toBeLessThan(lineaRequire);
  });

  test('el bloque Kraken va primero en el .htaccess, arriba del de WordPress', () => {
    const entorno = crearEntorno();
    aplicar(entorno);

    const htaccess = leer(entorno, '.htaccess');
    expect(htaccess.startsWith('# BEGIN KRAKEN-HARDENING')).toBe(true);
    expect(htaccess.indexOf('# END KRAKEN-HARDENING')).toBeLessThan(htaccess.indexOf('# BEGIN WordPress'));

    // El bloque de WordPress sobrevive entero
    expect(htaccess).toContain('RewriteEngine On');
    expect(htaccess).toContain('RewriteRule . /index.php [L]');
    expect(htaccess).toContain('# END WordPress');

    // Y las reglas propias están puestas
    expect(htaccess).toContain('<Files wp-config.php>');
    expect(htaccess).toContain('<Files xmlrpc.php>');
    expect(htaccess).toContain('<Files wp-comments-post.php>');
    expect(htaccess).toContain('Options -Indexes');
  });

  test('sin la línea "stop editing" el bloque se agrega igual al final', () => {
    const entorno = crearEntorno({
      wpConfig: [
        '<?php',
        "define( 'DB_NAME', 'wp_ejemplo' );",
        "$table_prefix = 'wp_';",
        "require_once ABSPATH . 'wp-settings.php';",
        '',
      ].join('\n'),
    });
    aplicar(entorno, ['wpconfig']);

    const config = leer(entorno, 'wp-config.php');
    expect(config).toContain('/* BEGIN KRAKEN-HARDENING */');
    expect(contar(config, 'DISALLOW_FILE_MODS')).toBe(1);
    expect(config).toContain("require_once ABSPATH . 'wp-settings.php';");
    expect(config.trimEnd().endsWith('/* END KRAKEN-HARDENING */')).toBe(true);
  });

  test('un define suelto previo se reemplaza: queda una sola definición, en true', () => {
    const entorno = crearEntorno({
      wpConfig: [
        '<?php',
        "define( 'DB_NAME', 'wp_ejemplo' );",
        "define('DISALLOW_FILE_EDIT', false);",
        "$table_prefix = 'wp_';",
        "/* That's all, stop editing! Happy publishing. */",
        "require_once ABSPATH . 'wp-settings.php';",
        '',
      ].join('\n'),
    });
    aplicar(entorno, ['wpconfig']);

    const config = leer(entorno, 'wp-config.php');
    expect(contar(config, 'DISALLOW_FILE_EDIT')).toBe(1);
    expect(config).toContain("define( 'DISALLOW_FILE_EDIT', true );");
    expect(config).not.toContain("define('DISALLOW_FILE_EDIT', false);");
  });

  test('se crea el .htaccess de uploads con el bloqueo de PHP', () => {
    const entorno = crearEntorno();
    aplicar(entorno, ['files']);

    expect(existe(entorno, 'wp-content/uploads/.htaccess')).toBe(true);
    const bloqueo = leer(entorno, 'wp-content/uploads/.htaccess');
    expect(bloqueo).toContain('<Files *.php>');
    expect(bloqueo).toContain('Require all denied');
    expect(bloqueo).toContain('Deny from all');
  });

  test('se instalan los dos mu-plugins y el PHP llega sin expandir', () => {
    // La comprobación que importa: los heredocs usan delimitador entrecomillado,
    // así que bash NO debe tocar las $variables del PHP. Si alguien las quita,
    // $result y $_POST se expanden a vacío y los mu-plugins quedan rotos.
    const entorno = crearEntorno();
    aplicar(entorno, ['restapi', 'login']);

    const rest = leer(entorno, 'wp-content/mu-plugins/kraken-rest-api.php');
    expect(rest.startsWith('<?php')).toBe(true);
    expect(rest).toContain('$result');
    expect(rest).toContain('rest_authentication_errors');
    expect(rest).toContain('is_user_logged_in()');

    const captcha = leer(entorno, 'wp-content/mu-plugins/kraken-login-captcha.php');
    expect(captcha.startsWith('<?php')).toBe(true);
    expect(captcha).toContain('$_POST');
    expect(captcha).toContain('$expires');
    expect(captcha).toContain('hash_hmac');
    expect(captcha).toContain('class Kraken_Login_Captcha');

    // Nada de lo generado quedó vacío por una expansión accidental
    expect(captcha).not.toContain('isset(  self::FIELD ]');
    expect(rest.length).toBeGreaterThan(400);
    expect(captcha.length).toBeGreaterThan(1500);
  });

  test('dry-run no modifica ningún archivo del árbol', () => {
    const entorno = crearEntorno();
    const antes = hashearArbol(entorno.webRoot);

    const salida = aplicar(entorno, MEDIDAS_COMPLETAS, 1, { dryRun: true });

    expect(hashearArbol(entorno.webRoot)).toEqual(antes);
    expect(salida).toContain('DRY-RUN');
    expect(salida).toContain('"measure":"wpconfig","applied":false');
    expect(salida).not.toContain('"applied":true');
  });

  test('si el wp-config resultante no compila, se revierte desde el respaldo', () => {
    // El stub de `php -l` sale distinto de cero: es preferible quedarse sin la
    // medida que dejar el sitio caído.
    const entorno = crearEntorno({ phpValido: false });
    const salida = aplicar(entorno, ['wpconfig']);

    expect(salida).toContain('"measure":"wpconfig","applied":false');
    expect(salida).toContain('REVERTIDO');

    const config = leer(entorno, 'wp-config.php');
    expect(config).not.toContain('BEGIN KRAKEN-HARDENING');
    expect(config).toContain("require_once ABSPATH . 'wp-settings.php';");
  });
});

// ── Levantar el candado ───────────────────────────────────────────────────────

describeBash('buildUnlockScript', () => {
  test('quita las constantes de un wp-config ya blindado y deja el resto intacto', () => {
    const entorno = crearEntorno();
    aplicar(entorno, ['wpconfig']);
    expect(leer(entorno, 'wp-config.php')).toContain('DISALLOW_FILE_MODS');

    const salida = correr(entorno, buildUnlockScript(DOMINIO, entorno.vhostsRoot), 'unlock.sh');

    expect(salida).toContain('[CANDADO] Levantado');
    const config = leer(entorno, 'wp-config.php');
    expect(config).not.toContain('DISALLOW_FILE_MODS');
    expect(config).not.toContain('DISALLOW_FILE_EDIT');
    expect(config).not.toContain('KRAKEN-HARDENING');
    expect(config).toContain("define( 'DB_NAME', 'wp_ejemplo' );");
    expect(config).toContain("$table_prefix = 'wp_';");
    expect(config).toContain("require_once ABSPATH . 'wp-settings.php';");
    expect(config).toContain("/* That's all, stop editing! Happy publishing. */");
  });

  test('sobre un wp-config sin candado no toca nada y lo dice', () => {
    const entorno = crearEntorno();
    const antes = leer(entorno, 'wp-config.php');

    const salida = correr(entorno, buildUnlockScript(DOMINIO, entorno.vhostsRoot), 'unlock.sh');

    expect(salida).toContain('[CANDADO] No había candado');
    expect(leer(entorno, 'wp-config.php')).toBe(antes);
  });

  test('sin wp-config.php aborta con código distinto de cero', () => {
    const entorno = crearEntorno();
    fs.rmSync(path.join(entorno.webRoot, 'wp-config.php'));

    let codigo = 0;
    let salida = '';
    try {
      salida = correr(entorno, buildUnlockScript(DOMINIO, entorno.vhostsRoot), 'unlock.sh');
    } catch (error) {
      codigo = error.status;
      salida = String(error.stdout || '');
    }

    expect(codigo).toBe(1);
    expect(salida).toContain('wp-config.php no encontrado');
  });
});
