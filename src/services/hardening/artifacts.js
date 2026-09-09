'use strict';

/**
 * Artefactos que el blindaje deposita en el sitio.
 *
 * Se copian por SSH como archivos, NO se instalan desde el panel de WordPress.
 * Eso importa: los mu-plugins siguen funcionando con DISALLOW_FILE_MODS activo
 * (que bloquea la instalación de plugins normales) y no se pueden desactivar
 * desde el dashboard, así que sobreviven a un administrador comprometido.
 */

const { MARK_BEGIN, MARK_END, LOGIN_SLUG } = require('./constants');

// ── mu-plugin: restricción de la REST API (medida 6) ──────────────────────────
//
// La guía sugería como alternativa el plugin "Disable WP REST API". Se usa el
// mu-plugin en su lugar porque: no se puede desactivar desde el dashboard, no
// depende de un tercero, y se instala copiando un archivo (funciona con
// DISALLOW_FILE_MODS puesto).

const REST_API_MU_PLUGIN = `<?php
/*
Plugin Name: Kraken — Bloqueo Restringido REST API
Description: Desactiva la REST API de WordPress para usuarios no autenticados para prevenir rastreos y enumeración de usuarios.
Version: 1.0
*/

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_filter( 'rest_authentication_errors', function( $result ) {
    if ( ! empty( $result ) ) {
        return $result;
    }

    if ( is_user_logged_in() ) {
        return $result;
    }

    return new WP_Error(
        'rest_not_logged_in',
        __( 'El acceso a la REST API está restringido únicamente a usuarios autenticados.' ),
        array( 'status' => 401 )
    );
});
`;

// ── mu-plugin: CAPTCHA matemático en el login (medida 5) ──────────────────────
//
// Implementación propia en vez de un plugin de terceros por dos razones:
//   1. Un plugin como "Captcha by BestWebSoft" hay que instalarlo Y configurarlo
//      por sitio, y su configuración vive en wp_options con un formato que
//      cambia entre versiones. Sobre cientos de dominios eso es frágil.
//   2. Con el slug fijo (/clin-usuario, decisión de la empresa) el ocultamiento no
//      frena el escaneo masivo, así que este CAPTCHA es la barrera efectiva
//      del formulario. Tiene que ser predecible y no depender de nadie.
//
// El reto se firma con hash_hmac usando las sales de wp-config, así que el
// cliente no puede fabricar una respuesta válida sin conocerlas. No se usa
// sesión ni transient: el estado viaja firmado en el propio formulario, lo que
// evita problemas con caché de página y balanceo.

const LOGIN_CAPTCHA_MU_PLUGIN = `<?php
/*
Plugin Name: Kraken — Reto Anti-Bot en el Login
Description: Exige resolver una operación aritmética simple para enviar el formulario de acceso. Frena scripts automatizados de diccionario.
Version: 1.0
*/

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

if ( ! class_exists( 'Kraken_Login_Captcha' ) ) {

class Kraken_Login_Captcha {

    const FIELD  = 'kraken_captcha';
    const NONCE  = 'kraken_captcha_token';
    const WINDOW = 900; // 15 min de validez del reto

    public static function init() {
        add_action( 'login_form',            array( __CLASS__, 'render' ) );
        add_action( 'register_form',         array( __CLASS__, 'render' ) );
        add_action( 'lostpassword_form',     array( __CLASS__, 'render' ) );
        add_filter( 'authenticate',          array( __CLASS__, 'check_auth' ), 30, 3 );
        add_action( 'lostpassword_post',     array( __CLASS__, 'check_simple' ) );
        add_action( 'register_post',         array( __CLASS__, 'check_simple' ) );
    }

    /** Clave de firma derivada de las sales del sitio. */
    private static function key() {
        $salt = defined( 'AUTH_SALT' ) ? AUTH_SALT : '';
        $key  = defined( 'AUTH_KEY' )  ? AUTH_KEY  : '';
        return hash( 'sha256', $salt . '|kraken-captcha|' . $key );
    }

    private static function sign( $a, $b, $expires ) {
        return hash_hmac( 'sha256', $a . ':' . $b . ':' . $expires, self::key() );
    }

    /** Pinta el reto. El estado viaja firmado en el formulario, no en sesión. */
    public static function render() {
        $a       = random_int( 1, 9 );
        $b       = random_int( 1, 9 );
        $expires = time() + self::WINDOW;
        $token   = $a . '.' . $b . '.' . $expires . '.' . self::sign( $a, $b, $expires );

        echo '<p>';
        echo '<label for="' . esc_attr( self::FIELD ) . '">';
        echo esc_html( sprintf( 'Verificación anti-bot: ¿cuánto es %d + %d?', $a, $b ) );
        echo '<br /><input type="text" name="' . esc_attr( self::FIELD ) . '" id="' . esc_attr( self::FIELD ) . '" class="input" value="" size="20" autocomplete="off" inputmode="numeric" required="required" />';
        echo '</label>';
        echo '<input type="hidden" name="' . esc_attr( self::NONCE ) . '" value="' . esc_attr( $token ) . '" />';
        echo '</p>';
    }

    /**
     * Valida el reto.
     * @return true|WP_Error
     */
    private static function validate() {
        $answer = isset( $_POST[ self::FIELD ] ) ? trim( wp_unslash( $_POST[ self::FIELD ] ) ) : '';
        $token  = isset( $_POST[ self::NONCE ] ) ? trim( wp_unslash( $_POST[ self::NONCE ] ) ) : '';

        if ( '' === $answer || '' === $token ) {
            return new WP_Error( 'kraken_captcha_missing', '<strong>Error</strong>: resolvé la verificación anti-bot.' );
        }

        $parts = explode( '.', $token );
        if ( count( $parts ) !== 4 ) {
            return new WP_Error( 'kraken_captcha_bad', '<strong>Error</strong>: verificación inválida. Recargá la página.' );
        }

        list( $a, $b, $expires, $sig ) = $parts;

        if ( ! hash_equals( self::sign( (int) $a, (int) $b, (int) $expires ), $sig ) ) {
            return new WP_Error( 'kraken_captcha_bad', '<strong>Error</strong>: verificación inválida. Recargá la página.' );
        }

        if ( time() > (int) $expires ) {
            return new WP_Error( 'kraken_captcha_expired', '<strong>Error</strong>: la verificación expiró. Recargá la página.' );
        }

        if ( (int) $answer !== ( (int) $a + (int) $b ) ) {
            return new WP_Error( 'kraken_captcha_wrong', '<strong>Error</strong>: la respuesta de verificación es incorrecta.' );
        }

        return true;
    }

    /**
     * Se engancha en 'authenticate'. Solo evalúa envíos POST reales del
     * formulario: deja pasar cookies, application passwords y XML-RPC/CLI,
     * que no envían el reto y no son el vector que esto frena.
     */
    public static function check_auth( $user, $username, $password ) {
        if ( 'POST' !== ( isset( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : '' ) ) {
            return $user;
        }
        if ( defined( 'XMLRPC_REQUEST' ) || defined( 'REST_REQUEST' ) || ( defined( 'WP_CLI' ) && WP_CLI ) ) {
            return $user;
        }
        if ( empty( $username ) && empty( $password ) ) {
            return $user;
        }

        $check = self::validate();
        if ( is_wp_error( $check ) ) {
            return $check;
        }
        return $user;
    }

    /** Para formularios que no pasan por 'authenticate'. */
    public static function check_simple( $errors = null ) {
        $check = self::validate();
        if ( is_wp_error( $check ) ) {
            wp_die( $check->get_error_message(), 'Verificación anti-bot', array( 'response' => 403, 'back_link' => true ) );
        }
    }
}

Kraken_Login_Captcha::init();

}
`;

// ── Bloques .htaccess ─────────────────────────────────────────────────────────
//
// Cada regla se escribe con la variante mod_authz_core (Apache 2.4) y la
// variante legacy (2.2), tal como pide la guía, para no depender de la versión
// de Apache que tenga cada servidor.

/** Deniega el acceso a un archivo, en ambas sintaxis de Apache. */
function denyFile(filename) {
  return [
    `<Files ${filename}>`,
    '    <IfModule mod_authz_core.c>',
    '        Require all denied',
    '    </IfModule>',
    '    <IfModule !mod_authz_core.c>',
    '        Order allow,deny',
    '        Deny from all',
    '    </IfModule>',
    '</Files>',
  ].join('\n');
}

/**
 * Bloque para el .htaccess de la raíz.
 * Cubre las medidas 3 (archivos sensibles + listado de directorios) y
 * 4 (xmlrpc y procesador de comentarios).
 */
const ROOT_HTACCESS_BLOCK = [
  MARK_BEGIN,
  '# Generado por Kraken CLI. No editar a mano: este bloque se reescribe entero',
  '# en cada pasada de blindaje. Cualquier cambio manual acá se pierde.',
  '',
  '# Medida 3 — Proteger .htaccess',
  denyFile('.htaccess'),
  '',
  '# Medida 3 — Proteger wp-config.php',
  denyFile('wp-config.php'),
  '',
  '# Medida 3 — Desactivar exploración de directorios',
  'Options -Indexes',
  '',
  '# Medida 4 — Bloquear el acceso a xmlrpc.php',
  denyFile('xmlrpc.php'),
  '',
  '# Medida 4 — Bloquear peticiones directas al procesador de comentarios',
  denyFile('wp-comments-post.php'),
  MARK_END,
].join('\n');

/**
 * .htaccess completo del directorio uploads (medida 3).
 * Este archivo es nuestro por entero, así que no lleva marcadores.
 */
const UPLOADS_HTACCESS = [
  '# Generado por Kraken CLI — bloqueo de ejecución de PHP en uploads.',
  '# La carpeta uploads es solo para medios. Si un formulario vulnerado permite',
  '# subir un .php, acá no se puede ejecutar.',
  denyFile('*.php'),
  '',
].join('\n');

module.exports = {
  REST_API_MU_PLUGIN,
  LOGIN_CAPTCHA_MU_PLUGIN,
  ROOT_HTACCESS_BLOCK,
  UPLOADS_HTACCESS,
  LOGIN_SLUG,
  denyFile,
};
