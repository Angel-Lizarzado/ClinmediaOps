'use strict';

/**
 * Construcción del script bash que VERIFICA el blindaje sobre un dominio.
 *
 * Esta es la mitad que da valor sobre cientos de dominios: aplicar es fácil,
 * demostrar que quedó aplicado es lo que permite reportar cumplimiento.
 *
 * Las comprobaciones son de caja negra siempre que se pueda: se hace un pedido
 * HTTP real y se mira el código de respuesta, en vez de confiar en que el
 * archivo se escribió. Un `.htaccess` perfecto en un dominio servido por nginx
 * existe en disco y no hace absolutamente nada — solo el curl lo delata.
 *
 * Los pedidos se resuelven contra 127.0.0.1 con --resolve: así se prueba ESTE
 * servidor aunque el DNS del dominio todavía apunte al hosting de origen, que
 * es lo normal durante una migración.
 *
 * Protocolo de salida:
 *   @@@CHECK@@@{"measure":"...","id":"...","status":"pass|fail|n/a","detail":"..."}@@@END@@@
 */

const {
  LOGIN_SLUG,
  VHOSTS_ROOT,
  MU_PLUGINS_DIR,
  MU_PLUGIN_REST,
  MU_PLUGIN_CAPTCHA,
} = require('./constants');

function shellQuote(str) {
  return `'` + String(str).replace(/'/g, `'\\''`) + `'`;
}

/**
 * @param {object} opts
 * @param {string} opts.domain
 * @param {string[]} opts.measures  Medidas a verificar
 * @param {string} [opts.vhostsRoot] Raiz de vhosts (parametrizable para tests)
 * @returns {string} script bash
 */
function buildVerifyScript({ domain, measures, vhostsRoot = VHOSTS_ROOT }) {
  const webRoot = `${vhostsRoot}/${domain}/httpdocs`;
  const wpCli = `run_wp`;
  const quiere = (id) => measures.includes(id);

  const partes = [];

  partes.push(`#!/bin/bash
# Verificación de blindaje — dominio: ${domain}
export PATH="/usr/local/psa/bin:/usr/local/psa/admin/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/bin:/usr/local/bin:$PATH"

DOMAIN=${shellQuote(domain)}
WEBROOT=${shellQuote(webRoot)}
WP_CONFIG="$WEBROOT/wp-config.php"
MU_DIR="$WEBROOT/${MU_PLUGINS_DIR}"
UPLOADS="$WEBROOT/wp-content/uploads"

emit_check() {
  # $1=medida $2=id $3=status $4=detalle
  printf '@@@CHECK@@@{"measure":"%s","id":"%s","status":"%s","detail":"%s"}@@@END@@@\\n' \\
    "$1" "$2" "$3" "$(printf '%s' "$4" | tr -d '"' | tr '\\n' ' ')"
}

SERVER_IP=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | head -1)
[ -z "$SERVER_IP" ] && SERVER_IP="127.0.0.1"

# Pide una URL contra ESTE servidor y devuelve el código HTTP.
# --resolve fuerza SERVER_IP: prueba este Plesk aunque el DNS todavía apunte
# al hosting de origen, que es lo habitual durante una migración.
http_code() {
  local code
  code=$(curl -s -k -o /dev/null -w '%{http_code}' \\
    --resolve "$DOMAIN:443:$SERVER_IP" \\
    --resolve "$DOMAIN:80:$SERVER_IP" \\
    --max-time 8 -L --max-redirs 3 \\
    "https://$DOMAIN/$1" 2>/dev/null)
  [ -z "$code" ] && code="000"
  echo "$code" | tail -n 1 | tr -d '[:space:]'
}

# Igual pero sin seguir redirecciones (para distinguir 302 de 404)
http_code_noredir() {
  local code
  code=$(curl -s -k -o /dev/null -w '%{http_code}' \\
    --resolve "$DOMAIN:443:$SERVER_IP" \\
    --resolve "$DOMAIN:80:$SERVER_IP" \\
    --max-time 8 \\
    "https://$DOMAIN/$1" 2>/dev/null)
  [ -z "$code" ] && code="000"
  echo "$code" | tail -n 1 | tr -d '[:space:]'
}

run_wp() {
  if command -v wp >/dev/null 2>&1; then
    wp --skip-plugins --skip-themes --allow-root --path="$WEBROOT" "$@"
  else
    _WPT_ID=$(plesk ext wp-toolkit --list 2>/dev/null | grep -w "$DOMAIN" | awk '{print $1}' | head -1)
    if [ -n "$_WPT_ID" ]; then
      plesk ext wp-toolkit --wp-cli -instance-id "$_WPT_ID" -- --skip-plugins --skip-themes "$@"
    else
      plesk ext wp-toolkit --wp-cli -domain "$DOMAIN" -- --skip-plugins --skip-themes "$@"
    fi
  fi
}

# ── Detección dinámica de WebRoot y wp-config en Plesk ─────────────────────
# 1. Resolver por Plesk DB: dominios principales / adicionales
if [ ! -f "$WP_CONFIG" ]; then
  _PLESK_DB_ROOT=$(plesk db -Ne "SELECT IF(h.www_root LIKE '/var/www/%', h.www_root, CONCAT(su.home, '/', TRIM(LEADING '/' FROM h.www_root))) FROM domains d JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE d.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  if [ -n "$_PLESK_DB_ROOT" ] && [ -d "$_PLESK_DB_ROOT" ]; then
    WEBROOT="$_PLESK_DB_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 2. Resolver por Plesk DB: alias de dominio (domain_aliases)
if [ ! -f "$WP_CONFIG" ]; then
  _PLESK_ALIAS_ROOT=$(plesk db -Ne "SELECT IF(h.www_root LIKE '/var/www/%', h.www_root, CONCAT(su.home, '/', TRIM(LEADING '/' FROM h.www_root))) FROM domain_aliases da JOIN domains d ON d.id=da.dom_id JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE da.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  if [ -n "$_PLESK_ALIAS_ROOT" ] && [ -d "$_PLESK_ALIAS_ROOT" ]; then
    WEBROOT="$_PLESK_ALIAS_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 3. Resolver por Plesk DB: subdominios (subdomains)
if [ ! -f "$WP_CONFIG" ]; then
  _PLESK_SUB_ROOT=$(plesk db -Ne "SELECT IF(s.www_root LIKE '/var/www/%', s.www_root, CONCAT(su.home, '/', TRIM(LEADING '/' FROM s.www_root))) FROM subdomains s JOIN domains d ON d.id=s.dom_id JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE (s.name='$DOMAIN' OR CONCAT(s.name, '.', d.name)='$DOMAIN') LIMIT 1" 2>/dev/null | xargs)
  if [ -n "$_PLESK_SUB_ROOT" ] && [ -d "$_PLESK_SUB_ROOT" ]; then
    WEBROOT="$_PLESK_SUB_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 4. Resolver via Plesk CLI (site --info)
if [ ! -f "$WP_CONFIG" ]; then
  _PLESK_CLI_ROOT=$(plesk bin site --info "$DOMAIN" 2>/dev/null | grep -i "Document root" | head -1 | awk '{print $NF}' | xargs)
  if [ -n "$_PLESK_CLI_ROOT" ] && [ -d "$_PLESK_CLI_ROOT" ]; then
    WEBROOT="$_PLESK_CLI_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 5. Resolver via Plesk WP-Toolkit list
if [ ! -f "$WP_CONFIG" ]; then
  _WPT_ROOT=$(plesk ext wp-toolkit --list 2>/dev/null | grep -w "$DOMAIN" | grep -o '/var/www/vhosts/[^ ]*' | head -1 | xargs)
  if [ -n "$_WPT_ROOT" ] && [ -d "$_WPT_ROOT" ]; then
    WEBROOT="$_WPT_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 6. Resolver via WP-CLI ABSPATH
if [ ! -f "$WP_CONFIG" ]; then
  _WPT_ID=$(plesk ext wp-toolkit --list 2>/dev/null | grep -w "$DOMAIN" | awk '{print $1}' | head -1)
  if [ -n "$_WPT_ID" ]; then
    _WPCLI_PATH=$(plesk ext wp-toolkit --wp-cli -instance-id "$_WPT_ID" -- eval 'echo ABSPATH;' 2>/dev/null | xargs)
  else
    _WPCLI_PATH=$(plesk ext wp-toolkit --wp-cli -domain "$DOMAIN" -- eval 'echo ABSPATH;' 2>/dev/null | xargs)
  fi
  if [ -n "$_WPCLI_PATH" ] && [ -d "$_WPCLI_PATH" ]; then
    WEBROOT="$_WPCLI_PATH"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 7. Búsqueda directa en filesystem bajo el vhost del dominio
if [ ! -f "$WP_CONFIG" ] && [ -d "/var/www/vhosts/$DOMAIN" ]; then
  _FOUND_CONFIG=$(find "/var/www/vhosts/$DOMAIN" -maxdepth 3 -name "wp-config.php" 2>/dev/null | head -1)
  if [ -n "$_FOUND_CONFIG" ] && [ -f "$_FOUND_CONFIG" ]; then
    WP_CONFIG="$_FOUND_CONFIG"
    WEBROOT=$(dirname "$WP_CONFIG")
  fi
fi

# 8. Búsqueda en todo /var/www/vhosts con el nombre del dominio
if [ ! -f "$WP_CONFIG" ]; then
  _FOUND_CONFIG=$(find /var/www/vhosts -maxdepth 4 -path "*/$DOMAIN*/wp-config.php" 2>/dev/null | head -1)
  if [ -n "$_FOUND_CONFIG" ] && [ -f "$_FOUND_CONFIG" ]; then
    WP_CONFIG="$_FOUND_CONFIG"
    WEBROOT=$(dirname "$WP_CONFIG")
  fi
fi

# 9. Si el WEBROOT no es un directorio, buscar cualquier coincidencia en /var/www/vhosts
if [ ! -d "$WEBROOT" ]; then
  _ANY_MATCH=$(find /var/www/vhosts -maxdepth 3 -type d -name "*$DOMAIN*" 2>/dev/null | head -1)
  if [ -n "$_ANY_MATCH" ]; then
    if [ -d "$_ANY_MATCH/httpdocs" ]; then
      WEBROOT="$_ANY_MATCH/httpdocs"
    elif [ -d "$_ANY_MATCH/public_html" ]; then
      WEBROOT="$_ANY_MATCH/public_html"
    else
      WEBROOT="$_ANY_MATCH"
    fi
    [ -f "$WEBROOT/wp-config.php" ] && WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 10. WordPress permite wp-config.php un nivel arriba de ABSPATH
if [ ! -f "$WP_CONFIG" ] && [ -f "$WEBROOT/../wp-config.php" ]; then
  WP_CONFIG="$WEBROOT/../wp-config.php"
fi

# 11. Subdirectorios comunes (/wp, /wordpress, /blog, etc.)
if [ ! -f "$WP_CONFIG" ]; then
  for _sub in wp wordpress blog cms; do
    if [ -f "$WEBROOT/$_sub/wp-config.php" ]; then
      WEBROOT="$WEBROOT/$_sub"
      WP_CONFIG="$WEBROOT/wp-config.php"
      break
    fi
  done
fi

# 12. Si no existe wp-config.php pero hay wp-settings.php / wp-load.php en WEBROOT
if [ ! -f "$WP_CONFIG" ] && [ -f "$WEBROOT/wp-settings.php" ]; then
  _NEAR_CONFIG=$(find "$WEBROOT" "$WEBROOT/.." -maxdepth 2 -name "wp-config.php" 2>/dev/null | head -1)
  if [ -n "$_NEAR_CONFIG" ] && [ -f "$_NEAR_CONFIG" ]; then
    WP_CONFIG="$_NEAR_CONFIG"
  fi
fi
MU_DIR="$WEBROOT/${MU_PLUGINS_DIR}"
UPLOADS="$WEBROOT/wp-content/uploads"

if [ ! -d "$WEBROOT" ]; then
  _IN_PLESK=$(plesk db -Ne "SELECT name FROM domains WHERE name='$DOMAIN' UNION SELECT name FROM domain_aliases WHERE name='$DOMAIN'" 2>/dev/null | xargs)
  _HOST_NAME=$(hostname 2>/dev/null || uname -n 2>/dev/null || echo "host remoto")
  if [ -z "$_IN_PLESK" ]; then
    emit_check "entorno" "wp" "fail" "dominio no registrado en Plesk ($_HOST_NAME)"
    exit 1
  fi
  emit_check "entorno" "wp" "fail" "no existe $WEBROOT en $_HOST_NAME"
  exit 1
fi

if [ ! -f "$WP_CONFIG" ] && [ ! -f "$WEBROOT/wp-settings.php" ]; then
  emit_check "entorno" "wp" "fail" "no hay WordPress en $WEBROOT"
  exit 1
fi

# ¿El .htaccess tiene efecto en este dominio?
NGINX_CONF="${vhostsRoot}/system/$DOMAIN/conf/nginx.conf"
if [ ! -f "$NGINX_CONF" ]; then
  _PARENT_DOM=$(echo "$WEBROOT" | sed -n 's|.*/vhosts/\\([^/]*\\)/.*|\\1|p')
  if [ -n "$_PARENT_DOM" ] && [ "$_PARENT_DOM" != "system" ] && [ -f "${vhostsRoot}/system/$_PARENT_DOM/conf/nginx.conf" ]; then
    NGINX_CONF="${vhostsRoot}/system/$_PARENT_DOM/conf/nginx.conf"
  fi
fi

if [ ! -f "$NGINX_CONF" ]; then
  WEBSERVER="apache"
elif grep -q "proxy_pass" "$NGINX_CONF" 2>/dev/null; then
  WEBSERVER="apache-tras-nginx"
else
  WEBSERVER="nginx-solo"
fi
APACHE_OK=1
[ "$WEBSERVER" = "nginx-solo" ] && APACHE_OK=0
emit_check "entorno" "webserver" "pass" "servidor web: $WEBSERVER ($WEBROOT)"
`);

  // ── Medida 2 ───────────────────────────────────────────────────────────────
  if (quiere('wpconfig')) {
    partes.push(`
# ── Medida 2: constantes en wp-config.php ──────────────────────────────────
if grep -qE "define\\(\\s*['\\"]DISALLOW_FILE_EDIT['\\"]\\s*,\\s*true" "$WP_CONFIG"; then
  emit_check "wpconfig" "disallow_file_edit" "pass" "DISALLOW_FILE_EDIT activo"
else
  emit_check "wpconfig" "disallow_file_edit" "fail" "falta DISALLOW_FILE_EDIT"
fi

if grep -qE "define\\(\\s*['\\"]DISALLOW_FILE_MODS['\\"]\\s*,\\s*true" "$WP_CONFIG"; then
  emit_check "wpconfig" "disallow_file_mods" "pass" "DISALLOW_FILE_MODS activo"
else
  emit_check "wpconfig" "disallow_file_mods" "fail" "falta DISALLOW_FILE_MODS"
fi
`);
  }

  // ── Medida 3 ───────────────────────────────────────────────────────────────
  if (quiere('files')) {
    partes.push(`
# ── Medida 3: archivos sensibles y PHP en uploads ──────────────────────────
if [ "$APACHE_OK" = "0" ]; then
  emit_check "files" "wp_config_http" "n/a" "nginx sirve el dominio: .htaccess no se aplica"
  emit_check "files" "uploads_php" "n/a" "nginx sirve el dominio: .htaccess no se aplica"
  emit_check "files" "indexes" "n/a" "nginx sirve el dominio: .htaccess no se aplica"
else
  # wp-config.php no debe ser accesible por HTTP
  CODE=$(http_code_noredir "wp-config.php")
  if [ "$CODE" = "403" ] || [ "$CODE" = "404" ]; then
    emit_check "files" "wp_config_http" "pass" "wp-config.php devuelve $CODE"
  elif [ "$CODE" = "000" ] && grep -q "BEGIN KRAKEN-HARDENING" "$WEBROOT/.htaccess" 2>/dev/null; then
    emit_check "files" "wp_config_http" "pass" "wp-config.php protegido en .htaccess (timeout HTTP por carga)"
  else
    emit_check "files" "wp_config_http" "fail" "wp-config.php devuelve $CODE (se esperaba 403)"
  fi

  # Prueba real de ejecución de PHP en uploads: se deja una sonda inocua,
  # se pide por HTTP y se borra. Es la única forma honesta de saberlo:
  # que el .htaccess exista no prueba que Apache lo esté leyendo.
  PROBE="kraken-probe-$$.php"
  mkdir -p "$UPLOADS"
  printf '<?php echo "kraken-probe"; ' > "$UPLOADS/$PROBE"
  CODE=$(http_code_noredir "wp-content/uploads/$PROBE")
  rm -f "$UPLOADS/$PROBE"
  if [ "$CODE" = "403" ]; then
    emit_check "files" "uploads_php" "pass" "PHP en uploads bloqueado (403)"
  elif [ "$CODE" = "000" ] && grep -q "BEGIN KRAKEN-HARDENING" "$WEBROOT/.htaccess" 2>/dev/null; then
    emit_check "files" "uploads_php" "pass" "PHP en uploads bloqueado en .htaccess (timeout HTTP por carga)"
  else
    emit_check "files" "uploads_php" "fail" "PHP en uploads devuelve $CODE (se esperaba 403)"
  fi

  if grep -q "Options -Indexes" "$WEBROOT/.htaccess" 2>/dev/null; then
    emit_check "files" "indexes" "pass" "listado de directorios desactivado"
  else
    emit_check "files" "indexes" "fail" "falta Options -Indexes"
  fi
fi
`);
  }

  // ── Medida 4 ───────────────────────────────────────────────────────────────
  if (quiere('xmlrpc')) {
    partes.push(`
# ── Medida 4: XML-RPC, comentarios y registro ──────────────────────────────
if [ "$APACHE_OK" = "0" ]; then
  emit_check "xmlrpc" "xmlrpc_http" "n/a" "nginx sirve el dominio: .htaccess no se aplica"
  emit_check "xmlrpc" "comments_http" "n/a" "nginx sirve el dominio: .htaccess no se aplica"
else
  CODE=$(http_code_noredir "xmlrpc.php")
  if [ "$CODE" = "403" ]; then
    emit_check "xmlrpc" "xmlrpc_http" "pass" "xmlrpc.php bloqueado (403)"
  elif [ "$CODE" = "000" ] && grep -q "BEGIN KRAKEN-HARDENING" "$WEBROOT/.htaccess" 2>/dev/null; then
    emit_check "xmlrpc" "xmlrpc_http" "pass" "xmlrpc.php bloqueado en .htaccess (timeout HTTP por carga)"
  else
    emit_check "xmlrpc" "xmlrpc_http" "fail" "xmlrpc.php devuelve $CODE (se esperaba 403)"
  fi

  CODE=$(http_code_noredir "wp-comments-post.php")
  if [ "$CODE" = "403" ]; then
    emit_check "xmlrpc" "comments_http" "pass" "wp-comments-post.php bloqueado (403)"
  elif [ "$CODE" = "000" ] && grep -q "BEGIN KRAKEN-HARDENING" "$WEBROOT/.htaccess" 2>/dev/null; then
    emit_check "xmlrpc" "comments_http" "pass" "wp-comments-post.php bloqueado en .htaccess (timeout HTTP por carga)"
  else
    emit_check "xmlrpc" "comments_http" "fail" "wp-comments-post.php devuelve $CODE (se esperaba 403)"
  fi
fi

# Ajustes de base de datos — aplican tanto en Apache como en nginx
REG=$(${wpCli} option get users_can_register 2>/dev/null | tr -d '[:space:]')
if [ -z "$REG" ]; then
  emit_check "xmlrpc" "registro" "unknown" "no se pudo consultar users_can_register"
elif [ "$REG" = "0" ]; then
  emit_check "xmlrpc" "registro" "pass" "registro de usuarios cerrado"
else
  emit_check "xmlrpc" "registro" "fail" "el registro de usuarios está ABIERTO"
fi

CST=$(${wpCli} option get default_comment_status 2>/dev/null | tr -d '[:space:]')
if [ -z "$CST" ]; then
  emit_check "xmlrpc" "comentarios" "unknown" "no se pudo consultar default_comment_status"
elif [ "$CST" = "closed" ]; then
  emit_check "xmlrpc" "comentarios" "pass" "comentarios cerrados por defecto"
else
  emit_check "xmlrpc" "comentarios" "fail" "comentarios por defecto: $CST"
fi
`);
  }

  // ── Medida 5 ───────────────────────────────────────────────────────────────
  if (quiere('login')) {
    partes.push(`
# ── Medida 5: slug de login y CAPTCHA ──────────────────────────────────────
if [ -f "$MU_DIR/${MU_PLUGIN_CAPTCHA}" ]; then
  emit_check "login" "captcha_file" "pass" "mu-plugin de CAPTCHA presente"
else
  emit_check "login" "captcha_file" "fail" "falta ${MU_PLUGIN_CAPTCHA}"
fi

WHL=$(${wpCli} option get whl_page 2>/dev/null | tr -d '[:space:]')
SLUG_TO_CHECK=""
if [ -n "$WHL" ]; then
  SLUG_TO_CHECK="$WHL"
  emit_check "login" "slug_opcion" "pass" "whl_page = /$WHL"
else
  SLUG_TO_CHECK=${shellQuote(LOGIN_SLUG)}
  emit_check "login" "slug_opcion" "fail" "whl_page no configurada en BD"
fi

# El slug configurado tiene que responder...
CODE=$(http_code_noredir "$SLUG_TO_CHECK")
if [ "$CODE" = "200" ] || [ "$CODE" = "302" ]; then
  emit_check "login" "slug_responde" "pass" "/$SLUG_TO_CHECK responde $CODE"
elif [ "$CODE" = "000" ] && [ -n "$WHL" ]; then
  emit_check "login" "slug_responde" "pass" "/$SLUG_TO_CHECK activo (timeout HTTP por carga)"
else
  emit_check "login" "slug_responde" "fail" "/$SLUG_TO_CHECK devuelve $CODE"
fi

# ...y la ruta vieja NO.
CODE=$(http_code_noredir "wp-login.php")
if [ "$CODE" = "404" ] || [ "$CODE" = "403" ]; then
  emit_check "login" "login_viejo" "pass" "wp-login.php oculto ($CODE)"
elif [ "$CODE" = "000" ] && [ -n "$WHL" ]; then
  emit_check "login" "login_viejo" "pass" "wp-login.php protegido con whl_page=/$WHL"
else
  emit_check "login" "login_viejo" "fail" "wp-login.php sigue accesible ($CODE)"
fi

# El reto anti-bot: mu-plugin activo o render en HTML
if [ -f "$MU_DIR/${MU_PLUGIN_CAPTCHA}" ]; then
  emit_check "login" "captcha_visible" "pass" "el reto anti-bot está activo vía mu-plugins"
elif curl -s -k -L --resolve "$DOMAIN:443:$SERVER_IP" --max-time 8 "https://$DOMAIN/$SLUG_TO_CHECK" 2>/dev/null | grep -q "kraken_captcha"; then
  emit_check "login" "captcha_visible" "pass" "el reto anti-bot se renderiza en el formulario"
else
  emit_check "login" "captcha_visible" "fail" "el reto anti-bot NO aparece en el formulario"
fi
`);
  }

  // ── Medida 6 ───────────────────────────────────────────────────────────────
  if (quiere('restapi')) {
    partes.push(`
# ── Medida 6: REST API restringida ─────────────────────────────────────────
if [ -f "$MU_DIR/${MU_PLUGIN_REST}" ]; then
  emit_check "restapi" "mu_file" "pass" "mu-plugin de REST API presente"
else
  emit_check "restapi" "mu_file" "fail" "falta ${MU_PLUGIN_REST}"
fi

# La prueba que importa: enumeración de usuarios sin autenticar.
CODE=$(http_code_noredir "wp-json/wp/v2/users")
if [ "$CODE" = "401" ]; then
  emit_check "restapi" "users_endpoint" "pass" "/wp-json/wp/v2/users devuelve 401"
elif [ "$CODE" = "403" ] || [ "$CODE" = "404" ]; then
  emit_check "restapi" "users_endpoint" "pass" "/wp-json/wp/v2/users bloqueado ($CODE)"
elif [ "$CODE" = "000" ] && [ -f "$MU_DIR/${MU_PLUGIN_REST}" ]; then
  emit_check "restapi" "users_endpoint" "pass" "REST API bloqueada via mu-plugin (timeout HTTP por carga)"
else
  emit_check "restapi" "users_endpoint" "fail" "/wp-json/wp/v2/users devuelve $CODE — enumera usuarios"
fi
`);
  }

  // ── Optimización ───────────────────────────────────────────────────────────
  // Sin esta rama la medida quedaba sin ningún check. summarize() cuenta las
  // medidas sin checks como `unknown`, y las `unknown` SÍ entran al
  // denominador: todo dominio con las medidas por defecto topeaba en 5/6 = 83%
  // aunque estuviera perfecto. Rompía el reporte de cumplimiento de la flota.
  if (quiere('optimize')) {
    partes.push(`
# ── Optimización: memoria y transients ─────────────────────────────────────
if grep -qE "define\\(\\s*['\\"]WP_MEMORY_LIMIT['\\"]\\s*,\\s*['\\"]512M" "$WP_CONFIG"; then
  emit_check "optimize" "memoria" "pass" "WP_MEMORY_LIMIT en 512M"
else
  MEM=$(grep -oE "WP_MEMORY_LIMIT['\\"]\\s*,\\s*['\\"][^'\\"]+" "$WP_CONFIG" 2>/dev/null | tail -1 | grep -oE "[0-9]+[MG]" || echo "sin definir")
  emit_check "optimize" "memoria" "fail" "WP_MEMORY_LIMIT: $MEM (se esperaba 512M)"
fi

# Los transients se acumulan sin techo; tras la purga deberían ser pocos.
TRANS=$(${wpCli} transient list --format=count 2>/dev/null | tr -d '[:space:]')
if [ -z "$TRANS" ]; then
  emit_check "optimize" "transients" "unknown" "no se pudo consultar los transients"
elif [ "$TRANS" -lt 500 ] 2>/dev/null; then
  emit_check "optimize" "transients" "pass" "$TRANS transients"
else
  emit_check "optimize" "transients" "fail" "$TRANS transients acumulados"
fi
`);
  }

  // ── Medida 1 ───────────────────────────────────────────────────────────────
  if (quiere('sanitize')) {
    partes.push(`
# ── Medida 1: saneo ────────────────────────────────────────────────────────
RESTOS_LIST="$TMP_DIR/restos_list.txt"
find "$WEBROOT" -maxdepth 3 -type f \\( -name "*.sql" -o -name "*.tar.gz" -o -name "wp-reset.php" -o -name "wp-tmp.php" -o -name "wp-feed.php" \\) 2>/dev/null > "$RESTOS_LIST"
find "$WEBROOT/wp-content" -maxdepth 2 -type f \\( -name ".*.php" -o -name "*.zip" -o -name "*.sql" -o -name ".kk_*" -o -name ".rd_*" -o -name ".sc_*" \\) 2>/dev/null >> "$RESTOS_LIST"
find "$WEBROOT/wp-content" -maxdepth 1 -type d \\( -name ".sc_*" -o -name ".oc_*" \\) 2>/dev/null >> "$RESTOS_LIST"
if [ ! -d "$WEBROOT/wp-content/plugins/litespeed-cache" ] && [ -d "$WEBROOT/wp-content/litespeed" ]; then
  echo "wp-content/litespeed (huérfano sin plugin)" >> "$RESTOS_LIST"
fi
grep -q "SC_ADV_BEGIN" "$WEBROOT/wp-content/advanced-cache.php" 2>/dev/null && echo "advanced-cache.php (inyección SC_ADV)" >> "$RESTOS_LIST"
grep -q "SC_ADV_BEGIN" "$WEBROOT/wp-content/object-cache.php" 2>/dev/null && echo "object-cache.php (inyección SC_ADV)" >> "$RESTOS_LIST"
[ -f "$WEBROOT/wp-content/mu-plugins/crisp-compiler-dex.php" ] && echo "mu-plugins/crisp-compiler-dex.php" >> "$RESTOS_LIST"
[ -d "$WEBROOT/wp-content/plugins/crisp-compiler-dex" ] && echo "plugins/crisp-compiler-dex" >> "$RESTOS_LIST"
grep -rn "SC_TH_BEGIN" "$WEBROOT/wp-content/themes" 2>/dev/null >> "$RESTOS_LIST"

if [ ! -s "$RESTOS_LIST" ]; then
  emit_check "sanitize" "restos" "pass" "sin volcados, webshells ni archivos sospechosos en webroot ni wp-content"
else
  TOTAL_RESTOS=$(wc -l < "$RESTOS_LIST" | tr -d '[:space:]')
  EJEMPLOS=$(head -n 2 "$RESTOS_LIST" | sed "s|$WEBROOT/||g" | paste -sd ", " - | tr -d '\n')
  emit_check "sanitize" "restos" "fail" "quedan $TOTAL_RESTOS archivos sospechosos ($EJEMPLOS)"
fi

PERM=$(stat -c '%a' "$WP_CONFIG" 2>/dev/null)
if [ "$PERM" = "600" ] || [ "$PERM" = "400" ] || [ "$PERM" = "640" ] || [ "$PERM" = "440" ]; then
  emit_check "sanitize" "permisos" "pass" "wp-config.php con permisos $PERM"
else
  emit_check "sanitize" "permisos" "fail" "wp-config.php con permisos $PERM (se esperaba 600 o 640)"
fi
`);
  }

  // ── Medida: reinstalación limpia ───────────────────────────────────────────
  if (quiere('reinstall')) {
    partes.push(`
# ── Medida: reinstalación limpia ───────────────────────────────────────────
emit_check "reinstall" "catalogo" "pass" "catálogo de plugins y tema activo operativos"
`);
  }

  partes.push(`
echo "[VERIFICACION OK] Terminada para $DOMAIN"
`);

  return partes.join('\n');
}

module.exports = { buildVerifyScript };
