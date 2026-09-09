'use strict';

/**
 * Constantes del módulo de Blindaje (hardening WordPress).
 *
 * Fuente: "Guía de Hardening y Blindaje Anti-Bots para WordPress" del cliente.
 * Las 6 medidas de la guía se modelan como MEASURES: cada una se aplica y se
 * verifica de forma independiente, para poder reportar cumplimiento por medida
 * y no un simple "ok / falló" por dominio.
 */

// ── Marcadores de bloque ──────────────────────────────────────────────────────
//
// Todo lo que este módulo escribe en archivos ajenos (.htaccess, wp-config.php)
// va envuelto en marcadores. Antes de escribir, el bloque anterior se borra
// entero. Eso da tres propiedades que los `grep -q` sueltos no daban:
//   - Idempotencia real: correrlo 100 veces deja el archivo igual.
//   - Actualizable: si cambia una regla, se reemplaza en vez de acumularse.
//   - Reversible: se puede quitar el bloque sin tocar lo que hay alrededor.

const MARK_BEGIN = '# BEGIN KRAKEN-HARDENING';
const MARK_END = '# END KRAKEN-HARDENING';

// En wp-config.php los marcadores tienen que ser comentarios PHP válidos.
const PHP_MARK_BEGIN = '/* BEGIN KRAKEN-HARDENING */';
const PHP_MARK_END = '/* END KRAKEN-HARDENING */';

// ── Slug de acceso ────────────────────────────────────────────────────────────
//
// Decisión de la empresa: slug FIJO e igual para toda la flota.
// Al ser conocido y uniforme no hace falta persistir ni exportar slugs por
// dominio, así que no existe riesgo de perder el acceso por extraviar un
// registro. La contrapartida asumida es que el ocultamiento no frena el
// escaneo masivo, por lo que el CAPTCHA es la barrera efectiva del login
// (por eso es un mu-plugin propio y no un plugin de terceros configurable).
const LOGIN_SLUG = 'clin-usuario';

// ── Rutas ─────────────────────────────────────────────────────────────────────

const VHOSTS_ROOT = '/var/www/vhosts';
const MU_PLUGINS_DIR = 'wp-content/mu-plugins';

const MU_PLUGIN_REST = 'kraken-rest-api.php';
const MU_PLUGIN_CAPTCHA = 'kraken-login-captcha.php';

// ── Plugins de terceros ───────────────────────────────────────────────────────

const WPS_HIDE_LOGIN_SLUG = 'wps-hide-login';

// ── Medidas ───────────────────────────────────────────────────────────────────
//
// `id` se usa como clave estable en el estado y en los reportes: no cambiarlo.
// `guide` referencia el número de medida en el documento del cliente.
// `needsApache` marca las que dependen de .htaccess — en un dominio servido
// solo por nginx no se aplican, y deben reportarse como no aplicables en vez
// de como cumplidas.

const MEASURES = [
  {
    id: 'sanitize',
    guide: 1,
    name: 'Saneo del entorno y BD',
    short: 'Purga webshells en wp-content, zips y desinfección de Base de Datos (spam/transients)',
    needsApache: false,
    destructive: true,
  },
  {
    id: 'wpconfig',
    guide: 2,
    name: 'Bloqueo de edición e instalación',
    short: 'DISALLOW_FILE_EDIT + DISALLOW_FILE_MODS',
    needsApache: false,
    destructive: false,
  },
  {
    id: 'files',
    guide: 3,
    name: 'Blindaje de archivos sensibles',
    short: '.htaccess, wp-config.php, -Indexes y PHP en uploads',
    needsApache: true,
    destructive: false,
  },
  {
    id: 'xmlrpc',
    guide: 4,
    name: 'Bloqueo de XML-RPC y comentarios',
    short: 'xmlrpc.php, wp-comments-post.php y ajustes de registro',
    needsApache: true,
    destructive: false,
  },
  {
    id: 'login',
    guide: 5,
    name: 'Ocultamiento de login y CAPTCHA',
    short: `Slug /${LOGIN_SLUG} + reto matemático anti-bot`,
    needsApache: false,
    destructive: false,
  },
  {
    id: 'restapi',
    guide: 6,
    name: 'Restricción de la REST API',
    short: 'mu-plugin que exige sesión autenticada',
    needsApache: false,
    destructive: false,
  },
  {
    // No sale de la guía: preserva lo que ya hacía el hardening del pipeline
    // de SourceSync (step10) al unificarse acá. No es seguridad, es higiene.
    id: 'optimize',
    guide: null,
    name: 'Memoria y limpieza',
    short: 'WP_MEMORY_LIMIT, opcache y purga de transients',
    needsApache: false,
    destructive: false,
  },
  {
    id: 'reinstall',
    guide: null,
    name: 'Reinstalación limpia de catálogo',
    short: 'Reinstala plugins y temas limpios desde WordPress.org; inyecta y activa Elementor Pro desde ZIP si está configurado',
    needsApache: false,
    destructive: true,
  },
];

const MEASURE_IDS = MEASURES.map((m) => m.id);

/** Medidas por defecto de una pasada de blindaje. */
// `sanitize` y `reinstall` quedan FUERA del default a propósito: son acciones destructivas
// o de reemplazo que requieren decisión explícita del operador.
const DEFAULT_MEASURES = MEASURE_IDS.filter((id) => id !== 'sanitize' && id !== 'reinstall');

// ── Resultados de verificación ────────────────────────────────────────────────

const VERIFY_STATUS = {
  PASS: 'pass',           // la medida está aplicada y comprobada
  FAIL: 'fail',           // la medida no está aplicada
  NOT_APPLICABLE: 'n/a',  // no aplica en este dominio (ej. .htaccess en nginx)
  UNKNOWN: 'unknown',     // no se pudo comprobar
};

// ── Timeouts ──────────────────────────────────────────────────────────────────

const HARDENING_TIMEOUTS = {
  DETECT: 60000,     // 1 min  — detección de entorno
  APPLY: 900000,     // 15 min — aplicación sobre un dominio
  VERIFY: 300000,    // 5 min  — verificación sobre un dominio
};

module.exports = {
  MARK_BEGIN,
  MARK_END,
  PHP_MARK_BEGIN,
  PHP_MARK_END,
  LOGIN_SLUG,
  VHOSTS_ROOT,
  MU_PLUGINS_DIR,
  MU_PLUGIN_REST,
  MU_PLUGIN_CAPTCHA,
  WPS_HIDE_LOGIN_SLUG,
  MEASURES,
  MEASURE_IDS,
  DEFAULT_MEASURES,
  VERIFY_STATUS,
  HARDENING_TIMEOUTS,
};
