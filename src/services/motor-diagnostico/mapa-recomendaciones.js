'use strict';

// ─── UMBRALES DE NEGOCIO ───────────────────────────────────────────────────
// Centralizar los umbrales aquí facilita ajustarlos sin tocar la lógica.
const UMBRAL_MEMORIA_MINIMA_MB = 256; // Por debajo de esto → subir primero
const OBJETIVO_MEMORIA_MB = 512; // Valor al que subiremos si está bajo
const UMBRAL_MEMORIA_SUFICIENTE = 512; // Por encima de esto → memoria NO es el problema

// ─── PLUGINS CONSIDERADOS "ESENCIALES" ────────────────────────────────────
// Para estos plugins, el motor NUNCA recomendará desactivar como primer paso,
// sin importar el estado de la memoria. Agrega los que uses en tus clientes.
const PLUGINS_ESENCIALES = new Set([
  'elementor',
  'elementor-pro',
  'woocommerce',
  'woocommerce-payments',
  'yoast-seo',
  'wordfence',
  'wpml',
  'acf',            // Advanced Custom Fields
  'advanced-custom-fields',
  'contact-form-7',
]);

/**
 * GENERADOR DE RECOMENDACIÓN PARA PLUGIN_FATAL_ERROR
 *
 * Implementa la jerarquía de cascada:
 *   Nivel 1 → Si memoria < UMBRAL_MEMORIA_MINIMA_MB:  subir memoria
 *   Nivel 2 → Si plugin es esencial + memoria OK:     subir memoria igualmente
 *   Nivel 3 → Si memoria ya es suficiente:            desactivar plugin
 *
 * @param {Object} contexto       - { culpable: 'nombre-plugin' }
 * @param {string} dominio        - ej. "ejemplo.com"
 * @param {string} instanceId     - ID de instalación WP en Plesk
 * @param {number|null} memoriaMB - Límite actual en MB, o null si no se pudo leer
 * @returns {Object}              - Objeto de recomendación completo
 */
function recomendacionPluginFatalError(contexto, dominio, instanceId, memoriaMB) {
  const { culpable } = contexto;
  const esPluginEsencial = PLUGINS_ESENCIALES.has(culpable);

  // ── NIVEL 1: Memoria desconocida o por debajo del umbral mínimo ───────────
  // Si no pudimos leer la memoria, asumimos que es baja (conservador y seguro)
  const memoriaEsBaja = memoriaMB === null || memoriaMB < UMBRAL_MEMORIA_MINIMA_MB;

  if (memoriaEsBaja) {
    return construirAccionMemoria({
      dominio,
      instanceId,
      culpable,
      memoriaMBActual: memoriaMB,
      razon: memoriaMB === null
        ? 'No se pudo leer el límite de memoria actual. Se aplica corrección preventiva.'
        : `Límite de memoria actual (${memoriaMB}MB) está por debajo del mínimo recomendado (${UMBRAL_MEMORIA_MINIMA_MB}MB).`,
    });
  }

  // ── NIVEL 2: Memoria entre 256MB y 512MB con plugin esencial ─────────────
  // Aunque está sobre el umbral mínimo, si el plugin es esencial y la memoria
  // no ha llegado a 512MB, todavía puede ser el problema.
  const memoriaBajoObjetivo = memoriaMB < UMBRAL_MEMORIA_SUFICIENTE;

  if (esPluginEsencial && memoriaBajoObjetivo) {
    return construirAccionMemoria({
      dominio,
      instanceId,
      culpable,
      memoriaMBActual: memoriaMB,
      razon: `"${culpable}" es un plugin esencial que requiere ≥${OBJETIVO_MEMORIA_MB}MB. ` +
        `Memoria actual: ${memoriaMB}MB. Se sube antes de considerar desactivar.`,
    });
  }

  // ── NIVEL 3: Memoria suficiente (≥512MB) o plugin no esencial ─────────────
  // La memoria ya es adecuada. El plugin es genuinamente el problema.
  return construirAccionDesactivarPlugin({
    dominio,
    instanceId,
    culpable,
    esPluginEsencial,
    memoriaMBActual: memoriaMB,
  });
}

// ─── CONSTRUCTORES DE ACCIONES ─────────────────────────────────────────────

function construirAccionMemoria({ dominio, instanceId, culpable, memoriaMBActual, razon }) {
  // Obtenemos el ID del handler de forma segura
  const comandoObtenerHandler = `plesk bin domain --info ${dominio} | grep php_handler_id | awk '{print $2}'`;

  // Construimos el comando de reload usando la variable
  const comandoReload = `${comandoObtenerHandler} | xargs -I{} systemctl reload {}`;

  return {
    accionRecomendada: 'ajuste_memoria_php',
    descripcion: razon,

    // CORRECCIÓN: Sintaxis segura para Plesk (sin corchetes raros)
    comandoMitigacion: `plesk bin php_settings -u ${dominio} -settings memory_limit=${OBJETIVO_MEMORIA_MB}M`,

    // AHORA SÍ estamos usando la variable comandoReload declarada arriba
    comandoReloadFPM: comandoReload,

    // Fallback de seguridad
    comandoReloadFPMAlt: `systemctl reload plesk-php*-fpm.service`,

    comandoEscaladoSiPersiste: `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- plugin deactivate ${culpable} --skip-plugins`,
    contextoPlugin: culpable,
    esAccionEscalada: false,
    riesgo: 'BAJO',
    requiereConfirmacion: false,
    notaAdicional: `Memoria actual detectada: ${memoriaMBActual ?? 'no disponible'}MB → Se ajustará a: ${OBJETIVO_MEMORIA_MB}MB.`,
  };
}

function construirAccionDesactivarPlugin({ dominio, instanceId, culpable, esPluginEsencial, memoriaMBActual }) {
  return {
    accionRecomendada: 'plugin_desactivar',
    descripcion: `Memoria actual (${memoriaMBActual}MB) es suficiente. ` +
      `El plugin "${culpable}" es la causa directa del error. ` +
      (esPluginEsencial
        ? `⚠️ ATENCIÓN: "${culpable}" es un plugin esencial. Notificar al cliente antes de proceder.`
        : 'Se puede desactivar de forma segura.'),
    // --skip-plugins: evita cargar otros plugins al ejecutar el comando,
    // crítico si el plugin culpable rompe el bootstrap de WordPress
    comandoMitigacion:
      `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- plugin deactivate ${culpable} --skip-plugins`,
    // Opción nuclear: solo si desactivar no es suficiente o el plugin no carga WP-CLI
    comandoAlternativoEliminar:
      `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- plugin delete ${culpable} --skip-plugins`,
    esAccionEscalada: true,
    riesgo: esPluginEsencial ? 'ALTO' : 'BAJO',
    requiereConfirmacion: esPluginEsencial,
    notaAdicional: esPluginEsencial
      ? `Este plugin puede ser requerido para el funcionamiento del sitio. Coordinar con el cliente.`
      : null,
  };
}

// ─── MAPA PRINCIPAL ────────────────────────────────────────────────────────

/**
 * Punto de entrada del mapa de recomendaciones.
 * Recibe el tipo de error y el contexto completo del sitio.
 */
function construirRecomendacion(tipoError, contexto, instanceId, estadoSitio = {}) {
  const { dominio, memoriaMB } = estadoSitio;

  const MAPA = {

    htaccess_corrupto: () => ({
      accionRecomendada: 'restaurar_htaccess',
      descripcion: 'Archivo .htaccess corrupto por error de sintaxis.',
      comandoMitigacion:
`mv /var/www/vhosts/${dominio}/httpdocs/.htaccess /var/www/vhosts/${dominio}/httpdocs/.htaccess.bak 2>/dev/null || true
cat << 'EOF' > /var/www/vhosts/${dominio}/httpdocs/.htaccess
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
EOF
plesk repair fs -y -vhosts ${dominio}`,
      riesgo: 'MEDIO',
      requiereConfirmacion: false,
    }),

    PLUGIN_FATAL_ERROR: () =>
      recomendacionPluginFatalError(contexto, dominio, instanceId, memoriaMB ?? null),

    ERROR_BASE_DE_DATOS: () => ({
      accionRecomendada: 'reparar_base_de_datos',
      descripcion: 'WordPress no puede conectarse a MySQL. Se intentará reparar las tablas.',
      comandoMitigacion:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- db repair`,
      comandoDiagnosticoPrevio:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- db check`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Si db repair falla, verificar estado MySQL: systemctl status mariadb',
    }),

    MEMORIA_EXHAUSTA: () => ({
      accionRecomendada: 'ajuste_memoria_php',
      descripcion: `Límite de memoria PHP detectado en el log: ${contexto.limiteActualMB}MB.`,
      comandoMitigacion:
        `plesk bin php_settings -u ${dominio} -settings memory_limit=${contexto.limiteRecomendadoMB}M`,
      comandoReloadFPM:
        `plesk bin domain --info ${dominio} | grep php_handler_id | awk '{print $2}' | xargs -I{} systemctl reload {}`,
      riesgo: 'BAJO',
      requiereConfirmacion: false,
      notaAdicional: `${contexto.limiteActualMB}MB → ${contexto.limiteRecomendadoMB}MB`,
    }),

    CORE_CORRUPTO: () => ({
      accionRecomendada: 'reparar_core_wordpress',
      descripcion: `Archivo del core corrupto: "${contexto.archivoAfectado}". wp-content NO se modificará.`,
      comandoMitigacion:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- core download --skip-content --force`,
      comandoVerificacionPrevia:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- core verify-checksums`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Equivale al "Repair Full" pero SOLO toca el core. wp-content intacto.',
    }),

    PERMISOS_INCORRECTOS: () => ({
      accionRecomendada: 'reparar_permisos_filesystem',
      descripcion: `El servidor deniega acceso por permisos u ownership incorrecto en ${contexto.rutaAfectada || 'httpdocs'}.`,
      comandoDiagnosticoPrevio:
        `namei -l /var/www/vhosts/${dominio}/httpdocs && ls -la /var/www/vhosts/${dominio}/httpdocs | head`,
      comandoMitigacion:
        `plesk repair fs -y -vhosts ${dominio}`,
      comandoVerificacionPosterior:
        `find /var/www/vhosts/${dominio}/httpdocs -maxdepth 2 -type d -printf '%m %u:%g %p\\n' | head -n 30 && find /var/www/vhosts/${dominio}/httpdocs -maxdepth 2 -type f -printf '%m %u:%g %p\\n' | head -n 30`,
      riesgo: 'BAJO',
      requiereConfirmacion: false,
      notaAdicional: 'Esperado en WordPress: directorios 755, archivos 644 y ownership correcto del suscriptor.',
    }),

    MODSECURITY_BLOQUEO: () => ({
      accionRecomendada: 'ajustar_modsecurity',
      descripcion: contexto.reglaId
        ? `La petición fue bloqueada por ModSecurity. Regla detectada: ${contexto.reglaId}.`
        : 'La petición fue bloqueada por ModSecurity / WAF.',
      comandoDiagnosticoPrevio:
        `grep -R "${dominio}" /var/log/modsec_audit.log /var/log/apache2/error_log /var/www/vhosts/system/${dominio}/logs/* 2>/dev/null | tail -n 50`,
      comandoMitigacion:
        `echo "MODSECURITY: Las excepciones deben añadirse vía Panel Plesk (Dominio > Web Application Firewall) introduciendo la ID: ${contexto.reglaId || 'REGLA_ID'}"`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: contexto.reglaId === '218500'
        ? 'La regla 218500 se ha reportado con falsos positivos en WooCommerce.'
        : 'Desactivar solo la regla concreta; no deshabilitar ModSecurity completo.',
    }),

    SIN_ARCHIVO_INDICE: () => ({
      accionRecomendada: 'restaurar_index_wordpress',
      descripcion: 'El directorio responde 403 porque no existe index.php o no hay DirectoryIndex válido.',
      comandoDiagnosticoPrevio:
        `ls -la /var/www/vhosts/${dominio}/httpdocs/index.php /var/www/vhosts/${dominio}/httpdocs/ 2>/dev/null`,
      comandoMitigacion:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- core download --skip-content --force`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Si solo falta index.php, reparar core con --skip-content suele bastar.',
    }),

    IP_BLOQUEADA_FIREWALL: () => ({
      accionRecomendada: 'desbloquear_ip_firewall',
      descripcion: contexto.ipBloqueada
        ? `La IP ${contexto.ipBloqueada} parece estar bloqueada por firewall o Fail2Ban.`
        : 'La IP del cliente o proxy parece estar bloqueada por firewall o Fail2Ban.',
      comandoDiagnosticoPrevio:
        `fail2ban-client status 2>/dev/null || true && iptables -S 2>/dev/null | tail -n 50 && plesk bin firewall --status 2>/dev/null || true`,
      comandoMitigacion:
        contexto.ipBloqueada
          ? `fail2ban-client set plesk-apache unbanip ${contexto.ipBloqueada} 2>/dev/null || fail2ban-client set recidive unbanip ${contexto.ipBloqueada} 2>/dev/null || true`
          : `echo 'Identificar IP exacta y desbloquearla en Fail2Ban o Plesk Firewall'`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Si hay Cloudflare, revisar también whitelist de sus rangos.',
    }),

    CLOUDFLARE_TIMEOUT_522: () => ({
      accionRecomendada: 'diagnosticar_timeout_origen_cloudflare',
      descripcion: 'Cloudflare no logra completar la conexión TCP con el origen.',
      comandoDiagnosticoPrevio:
        `systemctl status nginx apache2 httpd mariadb --no-pager 2>/dev/null ; uptime ; free -m ; ss -lntp | egrep ':80|:443' ; curl -I --max-time 10 http://127.0.0.1 2>/dev/null || true ; curl -k -I --max-time 10 https://127.0.0.1 2>/dev/null || true`,
      comandoMitigacion:
        `plesk repair web ${dominio} -y && systemctl reload nginx 2>/dev/null || systemctl reload apache2 2>/dev/null || systemctl reload httpd 2>/dev/null`,
      comandoEscaladoSiPersiste:
        `for f in $(curl -s https://www.cloudflare.com/ips-v4); do echo "Permitir $f en firewall"; done`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Comprobar IP del DNS en Cloudflare, carga del servidor, puertos 80/443 y whitelist.',
    }),

    SERVIDOR_INALCANZABLE_522: () => ({
      accionRecomendada: 'restaurar_servicios_web',
      descripcion: 'El servidor origen no responde o rechaza conexiones en 80/443.',
      comandoDiagnosticoPrevio:
        `ss -lntp | egrep ':80|:443' || true ; systemctl status nginx apache2 httpd --no-pager 2>/dev/null ; journalctl -u nginx -u apache2 -u httpd -n 80 --no-pager 2>/dev/null`,
      comandoMitigacion:
        `systemctl restart nginx 2>/dev/null || true ; systemctl restart apache2 2>/dev/null || systemctl restart httpd 2>/dev/null || true ; plesk repair web ${dominio} -y`,
      riesgo: 'ALTO',
      requiereConfirmacion: true,
      notaAdicional: 'Suele indicar stack web caído, bind roto o proxy inverso mal configurado.',
    }),

    PLESK_INSTANCE_NO_RESUELTA: () => ({
      accionRecomendada: 'registrar_instancia_wptoolkit_autoheal',
      descripcion:
        'WP Toolkit no tiene una instancia asociada, el archivo ignore bloquea el registro o las credenciales de BD están desincronizadas. Se aplicará Auto-Heal completo.',
      comandoDiagnosticoPrevio:
        `plesk ext wp-toolkit --list 2>/dev/null | grep -i ${dominio} || true`,
      comandoMitigacion:
        `DOMAIN="${dominio}"; DOMAIN_ID=$(plesk db -Ne "SELECT id FROM domains WHERE name='$DOMAIN'" 2>/dev/null | xargs); WP_PATH="/var/www/vhosts/$DOMAIN/httpdocs"; if [ -n "$DOMAIN_ID" ] && [ -f "$WP_PATH/wp-config.php" ]; then rm -f "$WP_PATH/.wp-toolkit-ignore"; DB_NAME=$(grep -Eo "'DB_NAME'\\s*,\\s*'[^']+'" "$WP_PATH/wp-config.php" | awk -F"'" '{print $4}'); DB_USER=$(grep -Eo "'DB_USER'\\s*,\\s*'[^']+'" "$WP_PATH/wp-config.php" | awk -F"'" '{print $4}'); DB_PASS=$(grep -Eo "'DB_PASSWORD'\\s*,\\s*'[^']+'" "$WP_PATH/wp-config.php" | awk -F"'" '{print $4}'); if [ -n "$DB_NAME" ] && [ -n "$DB_USER" ]; then plesk db -e "CREATE OR REPLACE USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; CREATE OR REPLACE USER '$DB_USER'@'%' IDENTIFIED BY '$DB_PASS'; GRANT ALL PRIVILEGES ON \\\`$DB_NAME\\\`.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON \\\`$DB_NAME\\\`.* TO '$DB_USER'@'%'; FLUSH PRIVILEGES;"; fi; plesk ext wp-toolkit --detach -main-domain-id "$DOMAIN_ID" -path httpdocs 2>/dev/null || true; plesk ext wp-toolkit --register -main-domain-id "$DOMAIN_ID" -path httpdocs; else echo "Error: Dominio o wp-config no existe"; exit 1; fi`,
      comandoAlternativoSeguro:
        `plesk ext wp-toolkit --list 2>/dev/null | grep -i ${dominio} || true`,
      riesgo: 'MEDIO',
      requiereConfirmacion: false,
      notaAdicional:
        'El script de mitigación (Auto-Heal) eliminará el archivo .wp-toolkit-ignore, forzará la sincronización de credenciales de MariaDB con el wp-config.php y registrará la instancia.',
      esAccionEscalada: true,
    }),

    DISCO_LLENO: () => ({
      accionRecomendada: 'liberar_espacio_disco',
      descripcion: 'El sitio falla porque el sistema no tiene espacio libre o se excedió la cuota.',
      comandoDiagnosticoPrevio:
        `df -h && quota -vs 2>/dev/null || true && du -sh /var/www/vhosts/${dominio}/httpdocs/* 2>/dev/null | sort -h | tail -n 20`,
      comandoMitigacion:
        `find /var/www/vhosts/${dominio}/httpdocs -type f \\( -name '*.log' -o -name '*.zip' -o -name '*.tar' -o -name '*.sql' \\) -size +20M -print`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Primero localizar dumps, backups y logs grandes antes de borrar.',
    }),

    PHP_FPM_CAIDO: () => ({
      accionRecomendada: 'reiniciar_php_fpm',
      descripcion: 'El pool PHP-FPM del dominio o su socket parece caído o inaccesible.',
      comandoDiagnosticoPrevio:
        `plesk bin domain --info ${dominio} | grep php_handler_id ; systemctl status plesk-php*-fpm --no-pager 2>/dev/null | tail -n 80`,
      comandoMitigacion:
        `plesk bin domain --info ${dominio} | grep php_handler_id | awk '{print $2}' | xargs -I{} systemctl restart {} || systemctl restart plesk-php*-fpm.service`,
      comandoVerificacionPosterior:
        `journalctl -u plesk-php*-fpm -n 100 --no-pager 2>/dev/null`,
      riesgo: 'MEDIO',
      requiereConfirmacion: false,
      notaAdicional: contexto.socketFPM
        ? `Socket afectado detectado: ${contexto.socketFPM}`
        : 'Revisar también saturación del pool.',
    })
  };

  const generador = MAPA[tipoError];
  return generador ? generador() : null;
}

module.exports = { construirRecomendacion };
