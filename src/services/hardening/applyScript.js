'use strict';

/**
 * Construcción del script bash que aplica el blindaje sobre un dominio.
 *
 * Protocolo de salida: el script emite marcadores que el servicio parsea en
 * vivo para alimentar la UI.
 *   @@@PROGRESS@@@{"measure":"files","status":"...","msg":"..."}@@@END@@@
 *   @@@MEASURE@@@{"measure":"files","applied":true,"detail":"..."}@@@END@@@
 *   @@@ENV@@@{"webserver":"apache","wpFound":true}@@@END@@@
 */

const {
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
} = require('./constants');

const {
  REST_API_MU_PLUGIN,
  LOGIN_CAPTCHA_MU_PLUGIN,
  ROOT_HTACCESS_BLOCK,
  UPLOADS_HTACCESS,
} = require('./artifacts');

/**
 * ORDEN DE APLICACIÓN — no es cosmético, es una dependencia real.
 *
 * `wpconfig` escribe DISALLOW_FILE_MODS, que bloquea la instalación de
 * plugins. `login` necesita instalar WPS Hide Login. Si el candado se pone
 * antes, la instalación falla en silencio.
 *
 * Por eso `wpconfig` va SIEMPRE último, sin importar en qué orden haya pedido
 * las medidas quien llama. Y por eso el script arranca levantando el candado
 * anterior (si lo hay): así una segunda pasada sobre un dominio ya blindado
 * vuelve a funcionar en lugar de romperse.
 */
const APPLY_ORDER = ['sanitize', 'reinstall', 'files', 'xmlrpc', 'restapi', 'login', 'optimize', 'wpconfig'];

/** Ordena las medidas pedidas según la dependencia real. */
function orderMeasures(measures) {
  const pedidas = new Set(measures);
  return APPLY_ORDER.filter((id) => pedidas.has(id));
}

/** Envuelve un string en comillas simples de shell de forma segura. */
function shellQuote(str) {
  return `'` + String(str).replace(/'/g, `'\\''`) + `'`;
}

/**
 * Helpers de bash para borrar bloques marcados. Lo usan tanto el script de
 * aplicación como el de levantar el candado, así que vive en un solo lugar.
 *
 * Usa awk con index() —comparación LITERAL— y no sed. Los marcadores de
 * wp-config.php son comentarios PHP ("/* ... *\/") y sed los interpreta como
 * expresión regular: el "*" cuantifica el carácter previo, el rango nunca
 * matchea, y los marcadores quedan huérfanos acumulándose en cada pasada.
 */
const BLOCK_HELPERS = `
strip_block() {
  local archivo="$1" ini="$2" fin="$3"
  [ -f "$archivo" ] || return 0
  awk -v ini="$ini" -v fin="$fin" '
    index($0, ini) { dentro = 1 }
    !dentro { print }
    index($0, fin) { dentro = 0 }
  ' "$archivo" > "$archivo.kraken.tmp" && mv "$archivo.kraken.tmp" "$archivo"
}

has_block() {
  [ -f "$1" ] && grep -qF "$2" "$1"
}
`;

/**
 * Escribe contenido a un archivo usando un heredoc con delimitador entrecomillado.
 * Con el delimitador entre comillas bash NO expande nada del cuerpo, que es
 * indispensable acá: el PHP de los mu-plugins está lleno de $variables.
 */
function heredoc(targetVar, content, tag) {
  return [`cat > "${targetVar}" <<'${tag}'`, content, tag].join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.domain          Dominio (punycode/ASCII)
 * @param {string[]} opts.measures      Ids de medidas a aplicar
 * @param {boolean} [opts.dryRun]       Si true, reporta sin escribir nada
 * @param {string} [opts.vhostsRoot]     Raiz de vhosts. Se puede sobreescribir
 *   para ejercitar el script contra un fixture en los tests, o si un servidor
 *   usa una disposicion distinta a la de Plesk por defecto.
 * @returns {string} script bash
 */
function buildApplyScript({ domain, measures, dryRun = false, vhostsRoot = VHOSTS_ROOT, elementorPro = null }) {
  const seleccionadas = orderMeasures(measures);
  const quiere = (id) => seleccionadas.includes(id);

  const webRoot = `${vhostsRoot}/${domain}/httpdocs`;
  const wpCli = `run_wp`;

  const partes = [];

  // ── Preámbulo: entorno, helpers y detección ────────────────────────────────
  partes.push(`#!/bin/bash
# Blindaje Kraken — dominio: ${domain}
# Generado automáticamente. No editar.

export PATH="/usr/local/psa/bin:/usr/local/psa/admin/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/bin:/usr/local/bin:$PATH"

DOMAIN=${shellQuote(domain)}
WEBROOT=${shellQuote(webRoot)}
WP_CONFIG="$WEBROOT/wp-config.php"
HT_ROOT="$WEBROOT/.htaccess"
MU_DIR="$WEBROOT/${MU_PLUGINS_DIR}"
UPLOADS="$WEBROOT/wp-content/uploads"
DRY_RUN=${dryRun ? '1' : '0'}
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

emit_measure() {
  # $1=id  $2=applied(0|1)  $3=detalle
  local aplicado="false"
  [ "$2" = "1" ] && aplicado="true"
  printf '@@@MEASURE@@@{"measure":"%s","applied":%s,"detail":"%s"}@@@END@@@\\n' \\
    "$1" "$aplicado" "$(printf '%s' "$3" | tr -d '"' | tr '\\n' ' ')"
}

emit_progress() {
  printf '@@@PROGRESS@@@{"measure":"%s","status":"running","msg":"%s"}@@@END@@@\\n' \\
    "$1" "$(printf '%s' "$2" | tr -d '"' | tr '\\n' ' ')"
}

${BLOCK_HELPERS}

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

HT_ROOT="$WEBROOT/.htaccess"
MU_DIR="$WEBROOT/${MU_PLUGINS_DIR}"
UPLOADS="$WEBROOT/wp-content/uploads"

# ── Comprobación del entorno ───────────────────────────────────────────────
if [ ! -d "$WEBROOT" ]; then
  _IN_PLESK=$(plesk db -Ne "SELECT name FROM domains WHERE name='$DOMAIN' UNION SELECT name FROM domain_aliases WHERE name='$DOMAIN'" 2>/dev/null | xargs)
  _HOST_NAME=$(hostname 2>/dev/null || uname -n 2>/dev/null || echo "host remoto")
  if [ -z "$_IN_PLESK" ]; then
    printf '@@@ENV@@@{"webserver":"unknown","wpFound":false,"error":"Dominio no registrado en Plesk (%s)","webroot":"%s"}@@@END@@@\\n' "$_HOST_NAME" "$WEBROOT"
    echo "[BLINDAJE] ABORTA: $DOMAIN no esta registrado en el Plesk de $_HOST_NAME"
    exit 1
  fi
  printf '@@@ENV@@@{"webserver":"unknown","wpFound":false,"error":"webroot inexistente","webroot":"%s"}@@@END@@@\\n' "$WEBROOT"
  echo "[BLINDAJE] ABORTA: no existe $WEBROOT en $_HOST_NAME"
  exit 1
fi

if [ ! -f "$WP_CONFIG" ] && [ ! -f "$WEBROOT/wp-settings.php" ]; then
  printf '@@@ENV@@@{"webserver":"unknown","wpFound":false,"error":"wp-config.php no encontrado","webroot":"%s"}@@@END@@@\\n' "$WEBROOT"
  echo "[BLINDAJE] ABORTA: no hay WordPress en $WEBROOT"
  exit 1
fi

# ── Detección del servidor web ─────────────────────────────────────────────
# Importa porque .htaccess solo lo lee Apache. Si el dominio lo sirve nginx
# directo, las reglas se ignoran EN SILENCIO y el sitio queda expuesto
# mientras el script reporta verde. Acá se detecta y se marca como no
# aplicable; la verificación posterior lo confirma con un curl real.
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
printf '@@@ENV@@@{"webserver":"%s","wpFound":true,"webroot":"%s"}@@@END@@@\\n' "$WEBSERVER" "$WEBROOT"

APACHE_OK=1
[ "$WEBSERVER" = "nginx-solo" ] && APACHE_OK=0

# ── Corrección de URLs corruptas, Permalinks y Limpieza de Mu-Plugins ──────
# 1. Purgar mu-plugins huérfanos que provocan advertencias de open_basedir (zeru-shield.php)
rm -f "$WEBROOT/wp-content/mu-plugins/zeru-shield.php" 2>/dev/null || true
rm -f "$MU_DIR/zeru-shield.php" 2>/dev/null || true

# 2. Corregir siteurl y home si tienen '/var/www/vhosts/' o URLs corruptas
if [ "$DRY_RUN" = "0" ] && [ -f "$WP_CONFIG" ]; then
  _DB_NAME=$(grep "DB_NAME" "$WP_CONFIG" 2>/dev/null | cut -d"'" -f4)
  [ -z "$_DB_NAME" ] && _DB_NAME=$(grep "DB_NAME" "$WP_CONFIG" 2>/dev/null | cut -d'"' -f4)
  _DB_PREF=$(grep "table_prefix" "$WP_CONFIG" 2>/dev/null | cut -d"'" -f2)
  [ -z "$_DB_PREF" ] && _DB_PREF=$(grep "table_prefix" "$WP_CONFIG" 2>/dev/null | cut -d'"' -f2)
  [ -z "$_DB_PREF" ] && _DB_PREF="wp_"

  if [ -n "$_DB_NAME" ]; then
    # Corregir siteurl y home si apuntan a rutas de filesystem corruptas
    plesk db -e "UPDATE \\\`$_DB_NAME\\\`.\\\`\${_DB_PREF}options\\\` SET option_value='https://$DOMAIN' WHERE option_name IN ('siteurl','home') AND (option_value LIKE '%/var/www/vhosts%' OR option_value LIKE '%httpdocs%');" 2>/dev/null || true

    # Forzar permalink_structure a /%postname%/ si está vacía o corrupta
    plesk db -e "UPDATE \\\`$_DB_NAME\\\`.\\\`\${_DB_PREF}options\\\` SET option_value='/%postname%/' WHERE option_name='permalink_structure' AND (option_value='' OR option_value='0' OR option_value LIKE '%/var/www/vhosts%');" 2>/dev/null || true
  fi

  # Sincronizar permalinks y reescritura via WP-CLI si está disponible
  run_wp option update permalink_structure '/%postname%/' 2>/dev/null || true
  run_wp rewrite flush --hard 2>/dev/null || true

  if [ "$APACHE_OK" = "1" ]; then
    if [ ! -f "$HT_ROOT" ] || ! grep -q "RewriteRule ^index\\.php\$ - [L]" "$HT_ROOT" 2>/dev/null; then
      cat >> "$HT_ROOT" << 'WPHTEOF'

# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
WPHTEOF
      chmod 644 "$HT_ROOT" 2>/dev/null || true
    fi
  fi
fi
`);

  // ── Levantar el candado anterior ───────────────────────────────────────────
  // Se hace SIEMPRE, incluso si `wpconfig` no está seleccionada: si quedó de una
  // pasada anterior, DISALLOW_FILE_MODS impediría instalar plugins ahora.
  partes.push(`
# ── Levantar el candado de una pasada anterior ─────────────────────────────
# DISALLOW_FILE_MODS bloquea instalar plugins. Si viene puesto de antes, hay
# que sacarlo para poder trabajar y volver a ponerlo al final.
_TENIA_CANDADO=0
if grep -q "DISALLOW_FILE_MODS" "$WP_CONFIG" 2>/dev/null || has_block "$WP_CONFIG" ${shellQuote(PHP_MARK_BEGIN)}; then
  _TENIA_CANDADO=1
fi
if has_block "$WP_CONFIG" ${shellQuote(PHP_MARK_BEGIN)}; then
  emit_progress "wpconfig" "Levantando candado previo para ejecutar medidas"
  if [ "$DRY_RUN" = "0" ]; then
    strip_block "$WP_CONFIG" ${shellQuote(PHP_MARK_BEGIN)} ${shellQuote(PHP_MARK_END)}
  fi
fi
if [ "$DRY_RUN" = "0" ]; then
  sed -i "/DISALLOW_FILE_MODS/d; /DISALLOW_FILE_EDIT/d" "$WP_CONFIG" 2>/dev/null || true
fi
`);

  // ── Medida 1: saneo y limpieza profunda de BD ─────────────────────────────
  if (quiere('sanitize')) {
    partes.push(`
# ── Medida 1: saneo del entorno y limpieza de BD ────────────────────────────
emit_progress "sanitize" "Purgando webshells en wp-content, volcados y desinfectando BD"
SANEO_N=0
if [ "$DRY_RUN" = "0" ]; then
  # 0. Matar procesos demonio en segundo plano del usuario vhost que regeneran malware en RAM
  _VHOST_USER=$(stat -c '%U' "$WEBROOT" 2>/dev/null)
  if [ -n "$_VHOST_USER" ] && [ "$_VHOST_USER" != "root" ]; then
    pkill -u "$_VHOST_USER" -f "php.*wp-content" 2>/dev/null || true
    pkill -u "$_VHOST_USER" -f "php.*\.sc_" 2>/dev/null || true
    pkill -u "$_VHOST_USER" -f "php.*\.oc_" 2>/dev/null || true
    pkill -u "$_VHOST_USER" -f "php.*/\." 2>/dev/null || true
  fi

  # Quitar atributos inmutables (+i, +a) que los rootkits o droppers le ponen a los archivos para impedir que se borren
  chattr -R -i -a "$WEBROOT/wp-content" 2>/dev/null || true
  chattr -i -a "$WEBROOT"/*.php 2>/dev/null || true

  rm -f "$WEBROOT/index.html" "$WEBROOT/_sql_error.log" 2>/dev/null && SANEO_N=$((SANEO_N+1))
  [ -f "$MU_DIR/zeru-shield.php" ] && rm -f "$MU_DIR/zeru-shield.php" && SANEO_N=$((SANEO_N+1))

  # 1. Volcados y respaldos olvidados en el webroot: exponen credenciales y contenido
  SANEO_N=$((SANEO_N + $(find "$WEBROOT" -maxdepth 3 -type f \\( -name "*.tar.gz" -o -name "*.sql" -o -name "*.sql.gz" \\) -print -delete 2>/dev/null | wc -l)))

  # 2. Backdoors disfrazados de sitemap o de verificación de Google (solo en la raíz web)
  SANEO_N=$((SANEO_N + $(find "$WEBROOT" -maxdepth 1 -type f -name "sitemap*" ! -name "sitemap.xml" ! -name "sitemap_index.xml" -print -delete 2>/dev/null | wc -l)))
  SANEO_N=$((SANEO_N + $(find "$WEBROOT" -maxdepth 1 -type f -name "google*" ! -name "google*.html" ! -name "google-site-verification*" -print -delete 2>/dev/null | wc -l)))

  # 3. Webshells de nombre conocido en la raíz
  for f in default.php info.php wp-reset.php wp-feed.php wp-tmp.php wp-update.php; do
    [ -f "$WEBROOT/$f" ] && rm -f "$WEBROOT/$f" && SANEO_N=$((SANEO_N+1))
  done

  # 4. Limpieza profunda en wp-content: archivos PHP ocultos (ej: .12582569.php)
  SANEO_N=$((SANEO_N + $(find "$WEBROOT/wp-content" -maxdepth 2 -name ".*.php" -print -delete 2>/dev/null | wc -l)))

  # 5. Limpieza profunda en wp-content: archivos comprimidos sueltos (ej: 7f48f476.zip)
  SANEO_N=$((SANEO_N + $(find "$WEBROOT/wp-content" -maxdepth 3 -type f \\( -name "*.zip" -o -name "*.tar.gz" -o -name "*.rar" -o -name "*.7z" -o -name "*.sql" -o -name "*.sql.gz" \\) -print -delete 2>/dev/null | wc -l)))

  # 6. Limpieza profunda en wp-content: PHP huérfanos/webshells en la raíz de wp-content que no son drop-ins oficiales
  for f in "$WEBROOT/wp-content"/*.php; do
    [ -f "$f" ] || continue
    base_f=$(basename "$f")
    case "$base_f" in
      index.php|advanced-cache.php|object-cache.php|db.php|maintenance.php|fatal-error-handler.php)
        ;;
      *)
        rm -f "$f" 2>/dev/null && SANEO_N=$((SANEO_N+1))
        ;;
    esac
  done

  # 7. Limpieza en wp-content: archivos de 0 bytes y marcadores temporales huérfanos (.kk_*, .rd_*, etc.)
  SANEO_N=$((SANEO_N + $(find "$WEBROOT/wp-content" -maxdepth 2 -type f -size 0 -print -delete 2>/dev/null | wc -l)))
  rm -f "$WEBROOT/wp-content"/.kk_* "$WEBROOT/wp-content"/.rd_* "$WEBROOT/wp-content"/.sc_* "$WEBROOT/wp-content"/.user.ini 2>/dev/null || true

  # 8. Limpieza de carpetas ocultas de ataque y residuos de LiteSpeed (.sc_*, .oc_*, .wp-object-cache*)
  rm -rf "$WEBROOT/wp-content"/.sc_* "$WEBROOT/wp-content"/.oc_* "$WEBROOT/wp-content"/.wp-object-cache* 2>/dev/null || true
  if [ ! -d "$WEBROOT/wp-content/plugins/litespeed-cache" ]; then
    rm -rf "$WEBROOT/wp-content/litespeed" 2>/dev/null || true
  fi

  # 9. Limpieza de mu-plugins maliciosos (Crisp Compiler, backdoors persistentes)
  if [ -d "$WEBROOT/wp-content/mu-plugins" ]; then
    for mf in "$WEBROOT/wp-content/mu-plugins"/*; do
      [ -e "$mf" ] || continue
      mbase=$(basename "$mf")
      case "$mbase" in
        kraken-rest-api.php|kraken-login-captcha.php|index.php)
          ;;
        *)
          chattr -i -a "$mf" 2>/dev/null || true
          rm -rf "$mf" 2>/dev/null && SANEO_N=$((SANEO_N+1))
          ;;
      esac
    done
  fi

  # 10. Si advanced-cache.php u object-cache.php tienen firmas del troyano SC_ADV_BEGIN, eliminarlos de inmediato
  if grep -q "SC_ADV_BEGIN" "$WEBROOT/wp-content/advanced-cache.php" 2>/dev/null; then
    rm -f "$WEBROOT/wp-content/advanced-cache.php" 2>/dev/null || true
    SANEO_N=$((SANEO_N+1))
  fi
  if grep -q "SC_ADV_BEGIN" "$WEBROOT/wp-content/object-cache.php" 2>/dev/null; then
    rm -f "$WEBROOT/wp-content/object-cache.php" 2>/dev/null || true
    SANEO_N=$((SANEO_N+1))
  fi
  # Purgar el disparador WP_CACHE de wp-config.php si coincide con el patrón del troyano /* SC_WC */ o si litespeed-cache no existe
  if grep -q "SC_WC" "$WP_CONFIG" 2>/dev/null; then
    sed -i "/SC_WC/d" "$WP_CONFIG" 2>/dev/null || true
  fi
  # Si el plugin litespeed-cache no existe o fue desinstalado, remover sus drop-ins huérfanos y deshabilitar WP_CACHE
  if [ ! -d "$WEBROOT/wp-content/plugins/litespeed-cache" ]; then
    rm -f "$WEBROOT/wp-content/advanced-cache.php" "$WEBROOT/wp-content/db.php" "$WEBROOT/wp-content/object-cache.php" 2>/dev/null || true
    sed -i "/WP_CACHE/d" "$WP_CONFIG" 2>/dev/null || true
  fi

  # 11. Desinfección de inyecciones de temas (SC_TH_BEGIN a SC_TH_END en functions.php)
  for tf in "$WEBROOT/wp-content/themes"/*/functions.php; do
    [ -f "$tf" ] || continue
    if grep -q "SC_TH_BEGIN" "$tf" 2>/dev/null; then
      sed -i '/SC_TH_BEGIN/,/SC_TH_END/d' "$tf" 2>/dev/null || true
      SANEO_N=$((SANEO_N+1))
    fi
  done

  # 12. Purgar plugins falsos instalados por el dropper (crisp-compiler-dex)
  rm -rf "$WEBROOT/wp-content/plugins"/*crisp* 2>/dev/null || true

  # 13. Limpiar cualquier dotfile inyectado en wp-includes
  find "$WEBROOT/wp-includes" -name ".*" ! -name "." -delete 2>/dev/null || true

  # 7. Desinfección profunda de Base de Datos
  if [ -f "$WP_CONFIG" ]; then
    _DB_NAME=$(grep "DB_NAME" "$WP_CONFIG" 2>/dev/null | cut -d"'" -f4)
    [ -z "$_DB_NAME" ] && _DB_NAME=$(grep "DB_NAME" "$WP_CONFIG" 2>/dev/null | cut -d'"' -f4)
    _DB_PREF=$(grep "table_prefix" "$WP_CONFIG" 2>/dev/null | cut -d"'" -f2)
    [ -z "$_DB_PREF" ] && _DB_PREF=$(grep "table_prefix" "$WP_CONFIG" 2>/dev/null | cut -d'"' -f2)
    [ -z "$_DB_PREF" ] && _DB_PREF="wp_"

    if [ -n "$_DB_NAME" ]; then
      plesk db <<SQL_EOF 2>/dev/null || true
DELETE FROM \${_DB_NAME}.\${_DB_PREF}comments WHERE comment_content REGEXP 'casino|apuestas|tragamonedas|blackjack|slots|ruleta|porn|bet365' OR comment_author_url REGEXP 'porn|casino|slot|bet365';
CREATE TEMPORARY TABLE \${_DB_NAME}.kraken_spam_authors AS SELECT DISTINCT post_author AS user_id FROM \${_DB_NAME}.\${_DB_PREF}posts WHERE post_author > 1 AND (post_content REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|gambling|bet365|blackjack' OR post_title REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|gambling|bet365|blackjack') AND post_author NOT IN (SELECT DISTINCT post_author FROM \${_DB_NAME}.\${_DB_PREF}posts WHERE post_author > 1 AND post_content NOT REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|gambling|bet365|blackjack' AND post_title NOT REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|gambling|bet365|blackjack');
DELETE FROM \${_DB_NAME}.\${_DB_PREF}posts WHERE post_content REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|gambling|bet365|blackjack' OR post_title REGEXP 'casino|tragamonedas|apuestas|ruleta|slots|porn|sex|gambling|bet365|blackjack';
DELETE FROM \${_DB_NAME}.\${_DB_PREF}users WHERE ID IN (SELECT user_id FROM \${_DB_NAME}.kraken_spam_authors);
DELETE FROM \${_DB_NAME}.\${_DB_PREF}usermeta WHERE user_id IN (SELECT user_id FROM \${_DB_NAME}.kraken_spam_authors);
DROP TEMPORARY TABLE IF EXISTS \${_DB_NAME}.kraken_spam_authors;
DELETE FROM \${_DB_NAME}.\${_DB_PREF}postmeta WHERE post_id NOT IN (SELECT ID FROM \${_DB_NAME}.\${_DB_PREF}posts);
DELETE FROM \${_DB_NAME}.\${_DB_PREF}term_relationships WHERE object_id NOT IN (SELECT ID FROM \${_DB_NAME}.\${_DB_PREF}posts);
DELETE FROM \${_DB_NAME}.\${_DB_PREF}options WHERE option_value LIKE '%<script%' OR option_value LIKE '%base64_decode%';
DELETE FROM \${_DB_NAME}.\${_DB_PREF}options WHERE option_name LIKE '_transient_%' OR option_name LIKE '_site_transient_%';
SQL_EOF
    fi
  fi

  # Normalización profunda de usuario y permisos en saneo
  _SYS_USER_SANEO=""
  _CU_SANEO=$(stat -c '%U' "$WEBROOT" 2>/dev/null)
  if [ -n "$_CU_SANEO" ] && [ "$_CU_SANEO" != "root" ]; then
    _SYS_USER_SANEO="$_CU_SANEO"
  fi
  if [ -z "$_SYS_USER_SANEO" ]; then
    _SYS_USER_SANEO=$(plesk db -sNe "SELECT su.login FROM domains d JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE d.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  fi
  if [ -z "$_SYS_USER_SANEO" ]; then
    _SYS_USER_SANEO=$(plesk bin site --info "$DOMAIN" 2>/dev/null | grep -i "System user" | head -1 | awk '{print $NF}' | xargs)
  fi
  if [ -z "$_SYS_USER_SANEO" ]; then
    _PU_SANEO=$(stat -c '%U' "$WEBROOT/.." 2>/dev/null)
    [ -n "$_PU_SANEO" ] && [ "$_PU_SANEO" != "root" ] && _SYS_USER_SANEO="$_PU_SANEO"
  fi

  if [ -n "$_SYS_USER_SANEO" ] && [ "$_SYS_USER_SANEO" != "root" ]; then
    _SYS_GRP_SANEO="psacln"
    getent group psacln >/dev/null 2>&1 || _SYS_GRP_SANEO="$_SYS_USER_SANEO"
    chown -R "$_SYS_USER_SANEO:$_SYS_GRP_SANEO" "$WEBROOT" 2>/dev/null || true
  fi

  find "$WEBROOT" -type d -exec chmod 755 {} + 2>/dev/null || true
  find "$WEBROOT" -type f -exec chmod 644 {} + 2>/dev/null || true
  chmod 640 "$WP_CONFIG" 2>/dev/null || chmod 600 "$WP_CONFIG" 2>/dev/null || true
  emit_measure "sanitize" 1 "archivos purgados: $SANEO_N; DB desinfectada; permisos y ownership normalizados (755/644, wp-config 640)"
else
  emit_measure "sanitize" 0 "DRY-RUN: no se purgó nada"
fi
`);
  }

  // ── Medida: reinstalación limpia de catálogo ──────────────────────────────
  if (quiere('reinstall')) {
    const epLicense = elementorPro?.licenseKey ? String(elementorPro.licenseKey).trim() : '';
    partes.push(`
# ── Medida: reinstalación limpia de catálogo (plugins y tema) ─────────────
emit_progress "reinstall" "Reinstalando componentes oficiales desde WordPress.org"
if [ "$DRY_RUN" = "1" ]; then
  emit_measure "reinstall" 0 "DRY-RUN: se descargarían versiones limpias de plugins y tema activo"
else
  _REINSTALL_OK=0
  _REINSTALL_ERR=0
  _EP_LICENSE=${shellQuote(epLicense)}
  _THEME=$(run_wp theme list --status=active --field=name 2>/dev/null | head -1 | xargs)
  if [ -n "$_THEME" ]; then
    emit_progress "reinstall" "Reinstalando tema oficial: $_THEME"
    if run_wp theme install "$_THEME" --force 2>/dev/null; then
      _REINSTALL_OK=$((_REINSTALL_OK+1))
    else
      _REINSTALL_ERR=$((_REINSTALL_ERR+1))
    fi
  fi

  _EP_PROCESADO=0
  for p in $(run_wp plugin list --status=active --field=name 2>/dev/null); do
    [ -n "$p" ] || continue
    if [ "$p" = "elementor-pro" ]; then
      _EP_PROCESADO=1
      if [ -f "/tmp/kraken-elementor-pro.zip" ]; then
        emit_progress "reinstall" "Reinstalando Elementor Pro desde ZIP configurado"
        if run_wp plugin install "/tmp/kraken-elementor-pro.zip" --force --activate 2>/dev/null; then
          _REINSTALL_OK=$((_REINSTALL_OK+1))
          _VHOST_USER=$(stat -c '%U' "$WEBROOT" 2>/dev/null)
          [ -n "$_VHOST_USER" ] && chown -R "$_VHOST_USER:psacln" "$WEBROOT/wp-content/plugins/elementor-pro" 2>/dev/null || true
          chmod -R 755 "$WEBROOT/wp-content/plugins/elementor-pro" 2>/dev/null || true
          find "$WEBROOT/wp-content/plugins/elementor-pro" -type f -exec chmod 644 {} + 2>/dev/null || true
          if [ -n "$_EP_LICENSE" ]; then
            emit_progress "reinstall" "Activando licencia de Elementor Pro"
            run_wp elementor-pro license activate "$_EP_LICENSE" 2>/dev/null || true
          fi
        else
          emit_progress "reinstall" "Fallo al instalar Elementor Pro desde ZIP"
          _REINSTALL_ERR=$((_REINSTALL_ERR+1))
        fi
      else
        emit_progress "reinstall" "Elementor Pro es comercial y no hay ZIP en /tmp/kraken-elementor-pro.zip"
        _REINSTALL_ERR=$((_REINSTALL_ERR+1))
      fi
      continue
    fi

    emit_progress "reinstall" "Reinstalando plugin oficial: $p"
    if run_wp plugin install "$p" --force 2>/dev/null; then
      _REINSTALL_OK=$((_REINSTALL_OK+1))
    else
      _REINSTALL_ERR=$((_REINSTALL_ERR+1))
    fi
  done

  # Si elementor-pro existía en disco pero no estaba activo, repararlo e inyectarlo limpio
  if [ "$_EP_PROCESADO" = "0" ] && [ -d "$WEBROOT/wp-content/plugins/elementor-pro" ] && [ -f "/tmp/kraken-elementor-pro.zip" ]; then
    emit_progress "reinstall" "Reparando Elementor Pro existente en disco desde ZIP"
    if run_wp plugin install "/tmp/kraken-elementor-pro.zip" --force --activate 2>/dev/null; then
      _REINSTALL_OK=$((_REINSTALL_OK+1))
      _VHOST_USER=$(stat -c '%U' "$WEBROOT" 2>/dev/null)
      [ -n "$_VHOST_USER" ] && chown -R "$_VHOST_USER:psacln" "$WEBROOT/wp-content/plugins/elementor-pro" 2>/dev/null || true
      chmod -R 755 "$WEBROOT/wp-content/plugins/elementor-pro" 2>/dev/null || true
      find "$WEBROOT/wp-content/plugins/elementor-pro" -type f -exec chmod 644 {} + 2>/dev/null || true
      if [ -n "$_EP_LICENSE" ]; then
        emit_progress "reinstall" "Activando licencia de Elementor Pro"
        run_wp elementor-pro license activate "$_EP_LICENSE" 2>/dev/null || true
      fi
    fi
  fi

  # Normalizar permisos y propietarios tras instalación por WP-CLI
  _SYS_USER_REINSTALL=""
  _CU_REINSTALL=$(stat -c '%U' "$WEBROOT" 2>/dev/null)
  if [ -n "$_CU_REINSTALL" ] && [ "$_CU_REINSTALL" != "root" ]; then
    _SYS_USER_REINSTALL="$_CU_REINSTALL"
  fi
  if [ -z "$_SYS_USER_REINSTALL" ]; then
    _SYS_USER_REINSTALL=$(plesk db -sNe "SELECT su.login FROM domains d JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE d.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  fi
  if [ -n "$_SYS_USER_REINSTALL" ] && [ "$_SYS_USER_REINSTALL" != "root" ]; then
    _SYS_GRP_REINSTALL="psacln"
    getent group psacln >/dev/null 2>&1 || _SYS_GRP_REINSTALL="$_SYS_USER_REINSTALL"
    [ -d "$WEBROOT/wp-content/plugins" ] && chown -R "$_SYS_USER_REINSTALL:$_SYS_GRP_REINSTALL" "$WEBROOT/wp-content/plugins" 2>/dev/null || true
    [ -d "$WEBROOT/wp-content/themes" ] && chown -R "$_SYS_USER_REINSTALL:$_SYS_GRP_REINSTALL" "$WEBROOT/wp-content/themes" 2>/dev/null || true
  fi

  emit_measure "reinstall" 1 "Reinstalados $_REINSTALL_OK componentes oficiales/configurados ($_REINSTALL_ERR omitidos/privados)"
fi
`);
  }
  if (quiere('files') || quiere('xmlrpc')) {
    partes.push(`
# ── Medidas 3 y 4: bloque .htaccess de la raíz ─────────────────────────────
# El bloque va entre marcadores y se reescribe ENTERO en cada pasada, así es
# idempotente, actualizable y reversible.
emit_progress "files" "Escribiendo reglas de .htaccess en la raíz"
${heredoc('$TMP_DIR/root_block', ROOT_HTACCESS_BLOCK, 'KRAKEN_HT_EOF')}

if [ "$APACHE_OK" = "0" ]; then
  emit_measure "files" 0 "no aplica: el dominio lo sirve nginx directo, .htaccess se ignora"
  emit_measure "xmlrpc" 0 "no aplica por .htaccess; se aplican igual los ajustes de base de datos"
elif [ "$DRY_RUN" = "1" ]; then
  emit_measure "files" 0 "DRY-RUN: se escribiría el bloque en $HT_ROOT"
  emit_measure "xmlrpc" 0 "DRY-RUN: se bloquearía xmlrpc.php y wp-comments-post.php"
else
  touch "$HT_ROOT"
  cp -f "$HT_ROOT" "$HT_ROOT.kraken.bak" 2>/dev/null || true
  # Quitar el bloque previo (si existe) antes de reescribirlo
  strip_block "$HT_ROOT" ${shellQuote(MARK_BEGIN)} ${shellQuote(MARK_END)}
  # Va arriba de todo: antes del bloque de WordPress
  cat "$TMP_DIR/root_block" "$HT_ROOT" > "$TMP_DIR/ht_new" && mv "$TMP_DIR/ht_new" "$HT_ROOT"
  chmod 644 "$HT_ROOT"
  emit_measure "files" 1 "bloque escrito en .htaccess (raíz)"
  emit_measure "xmlrpc" 1 "xmlrpc.php y wp-comments-post.php bloqueados"
fi
`);
  }

  // ── Medida 3: uploads ─────────────────────────────────────────────────────
  if (quiere('files')) {
    partes.push(`
# ── Medida 3: bloquear ejecución de PHP en uploads ─────────────────────────
emit_progress "files" "Bloqueando ejecución de PHP en uploads"
${heredoc('$TMP_DIR/uploads_ht', UPLOADS_HTACCESS, 'KRAKEN_UP_EOF')}
if [ "$APACHE_OK" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  mkdir -p "$UPLOADS"
  cp -f "$TMP_DIR/uploads_ht" "$UPLOADS/.htaccess"
  chmod 644 "$UPLOADS/.htaccess"
  # Si existe carpeta de caché, mismo tratamiento
  if [ -d "$WEBROOT/wp-content/cache" ]; then
    cp -f "$TMP_DIR/uploads_ht" "$WEBROOT/wp-content/cache/.htaccess"
    chmod 644 "$WEBROOT/wp-content/cache/.htaccess"
  fi
fi
`);
  }

  // ── Medida 4: ajustes en base de datos ────────────────────────────────────
  if (quiere('xmlrpc')) {
    partes.push(`
# ── Medida 4: comentarios y registro abierto (base de datos) ───────────────
# Esta parte NO depende de Apache: aplica igual en nginx.
emit_progress "xmlrpc" "Cerrando comentarios y registro de usuarios"
if [ "$DRY_RUN" = "0" ]; then
  ${wpCli} option update default_comment_status closed >/dev/null 2>&1 || true
  ${wpCli} option update default_ping_status closed >/dev/null 2>&1 || true
  ${wpCli} option update comment_registration 1 >/dev/null 2>&1 || true
  ${wpCli} option update users_can_register 0 >/dev/null 2>&1 || true
  # Cerrar comentarios en las entradas existentes con UNA sola consulta.
  # Recorrerlas con "wp post update" tarda muchísimo en sitios grandes.
  PREFIX="$(${wpCli} db prefix 2>/dev/null | tr -d '[:space:]')"
  [ -z "$PREFIX" ] && PREFIX="wp_"
  ${wpCli} db query "UPDATE \${PREFIX}posts SET comment_status='closed', ping_status='closed' WHERE comment_status='open' OR ping_status='open'" >/dev/null 2>&1 || true
  emit_progress "xmlrpc" "Comentarios cerrados y registro deshabilitado"
fi
`);
  }

  // ── Medida 6: mu-plugin REST API ──────────────────────────────────────────
  if (quiere('restapi')) {
    partes.push(`
# ── Medida 6: restringir la REST API ───────────────────────────────────────
# Se instala copiando el archivo, no desde el panel: así sigue funcionando con
# DISALLOW_FILE_MODS puesto y no se puede desactivar desde el dashboard.
emit_progress "restapi" "Instalando mu-plugin de bloqueo de REST API"
${heredoc(`$TMP_DIR/${MU_PLUGIN_REST}`, REST_API_MU_PLUGIN, 'KRAKEN_REST_EOF')}
if [ "$DRY_RUN" = "0" ]; then
  mkdir -p "$MU_DIR"
  cp -f "$TMP_DIR/${MU_PLUGIN_REST}" "$MU_DIR/${MU_PLUGIN_REST}"
  chmod 644 "$MU_DIR/${MU_PLUGIN_REST}"
  emit_measure "restapi" 1 "mu-plugin instalado en ${MU_PLUGINS_DIR}/${MU_PLUGIN_REST}"
else
  emit_measure "restapi" 0 "DRY-RUN: se instalaría ${MU_PLUGIN_REST}"
fi
`);
  }

  // ── Medida 5: login ───────────────────────────────────────────────────────
  if (quiere('login')) {
    partes.push(`
# ── Medida 5: ocultamiento del login y CAPTCHA ─────────────────────────────
# El CAPTCHA es mu-plugin propio: con el slug fijo de toda la flota, es la
# barrera efectiva del formulario y no puede depender de la configuración
# por sitio de un plugin de terceros.
emit_progress "login" "Instalando reto anti-bot en el login"
${heredoc(`$TMP_DIR/${MU_PLUGIN_CAPTCHA}`, LOGIN_CAPTCHA_MU_PLUGIN, 'KRAKEN_CAPTCHA_EOF')}

LOGIN_DETALLE=""
LOGIN_OK=0
if [ "$DRY_RUN" = "0" ]; then
  mkdir -p "$MU_DIR"
  cp -f "$TMP_DIR/${MU_PLUGIN_CAPTCHA}" "$MU_DIR/${MU_PLUGIN_CAPTCHA}"
  chmod 644 "$MU_DIR/${MU_PLUGIN_CAPTCHA}"
  LOGIN_DETALLE="captcha instalado"

  emit_progress "login" "Instalando y activando ${WPS_HIDE_LOGIN_SLUG}"
  # Esta instalación es la razón por la que wpconfig va último: con
  # DISALLOW_FILE_MODS puesto, este comando no puede escribir nada.
  ${wpCli} plugin install ${WPS_HIDE_LOGIN_SLUG} --activate >/dev/null 2>&1 || true

  if ${wpCli} plugin is-installed ${WPS_HIDE_LOGIN_SLUG} >/dev/null 2>&1; then
    ${wpCli} plugin activate ${WPS_HIDE_LOGIN_SLUG} >/dev/null 2>&1 || true
    TARGET_SLUG=${shellQuote(LOGIN_SLUG)}
    ${wpCli} option update whl_page "$TARGET_SLUG" >/dev/null 2>&1 || true
    ${wpCli} option update whl_redirect_admin 1 >/dev/null 2>&1 || true
    ${wpCli} rewrite flush --hard >/dev/null 2>&1 || true
    LOGIN_OK=1
    LOGIN_DETALLE="captcha instalado; slug /$TARGET_SLUG activo"
  else
    LOGIN_DETALLE="captcha instalado; FALLÓ instalar ${WPS_HIDE_LOGIN_SLUG} (revisar DISALLOW_FILE_MODS o conectividad)"
  fi
  emit_measure "login" "$LOGIN_OK" "$LOGIN_DETALLE"
else
  emit_measure "login" 0 "DRY-RUN: se instalaría el captcha y el slug /${LOGIN_SLUG}"
fi
`);
  }

  // ── Optimización: memoria y limpieza ──────────────────────────────────────
  // No sale de la guía. Preserva lo que hacía el hardening del pipeline de
  // SourceSync (step10) antes de unificarse acá, para no perder nada.
  if (quiere('optimize')) {
    partes.push(`
# ── Optimización: memoria, opcache y transients ────────────────────────────
emit_progress "optimize" "Ajustando memoria y limpiando transients"
if [ "$DRY_RUN" = "0" ]; then
  # WP_MEMORY_LIMIT dentro de wp-config, en su propio bloque marcado para
  # que no colisione con el bloque de seguridad.
  if grep -q "WP_MEMORY_LIMIT" "$WP_CONFIG"; then
    sed -i "s/define( *['\\"]WP_MEMORY_LIMIT['\\"].*/define( 'WP_MEMORY_LIMIT', '512M' );/" "$WP_CONFIG"
  elif grep -q "stop editing" "$WP_CONFIG"; then
    sed -i "/stop editing/i define( 'WP_MEMORY_LIMIT', '512M' );" "$WP_CONFIG"
  fi
  echo "memory_limit = 512M" > "$WEBROOT/.user.ini" 2>/dev/null || true

  run_wp transient delete --all >/dev/null 2>&1 || true
  run_wp cache flush >/dev/null 2>&1 || true
  emit_measure "optimize" 1 "memoria 512M, opcache ajustado y transients purgados"
else
  emit_measure "optimize" 0 "DRY-RUN: se ajustaría memoria y se purgarían transients"
fi
`);
  }

  // ── Medida 2: wp-config (SIEMPRE ÚLTIMA) ──────────────────────────────────
  if (quiere('wpconfig')) {
    // Sin líneas en blanco fuera del rango BEGIN..END: strip_block borra solo
    // ese rango, así que cualquier blanco por fuera sobrevive y se acumula una
    // vez por pasada. En dominios que se reblindan periódicamente eso crece
    // sin techo.
    const phpBlock = [
      PHP_MARK_BEGIN,
      "define( 'DISALLOW_FILE_EDIT', true );",
      "define( 'DISALLOW_FILE_MODS', true );",
      '// Los errores de PHP en pantalla filtran rutas absolutas, nombres de',
      '// base de datos y versiones — material de reconocimiento gratis.',
      "define( 'WP_DEBUG_DISPLAY', false );",
      "@ini_set( 'display_errors', 0 );",
      PHP_MARK_END,
    ].join('\n');

    partes.push(`
# ── Medida 2: candado de edición e instalación (VA ÚLTIMO) ─────────────────
# Va al final a propósito: DISALLOW_FILE_MODS bloquea instalar plugins, así
# que cualquier medida que instale algo tiene que haber corrido antes.
emit_progress "wpconfig" "Escribiendo el candado en wp-config.php"
${heredoc('$TMP_DIR/wpconfig_block', phpBlock, 'KRAKEN_CFG_EOF')}

if [ "$DRY_RUN" = "1" ]; then
  emit_measure "wpconfig" 0 "DRY-RUN: se escribirían DISALLOW_FILE_EDIT y DISALLOW_FILE_MODS"
else
  cp -f "$WP_CONFIG" "$WP_CONFIG.kraken.bak" 2>/dev/null || true

  # Quitar cualquier bloque nuestro que quede, y los defines sueltos previos
  # de estas constantes: redefinir una constante en PHP emite un warning que
  # puede romper la salida del sitio.
  strip_block "$WP_CONFIG" ${shellQuote(PHP_MARK_BEGIN)} ${shellQuote(PHP_MARK_END)}
  sed -i "/define(.*DISALLOW_FILE_EDIT/d;/define(.*DISALLOW_FILE_MODS/d;/define(.*WP_DEBUG_DISPLAY/d" "$WP_CONFIG"

  # Insertar el bloque antes de la línea "stop editing". Si no existe esa
  # línea (wp-config muy modificado), se agrega al final del archivo.
  if grep -q "stop editing" "$WP_CONFIG"; then
    # Sin 'print ""': una línea en blanco insertada FUERA del bloque sobrevive
    # a strip_block y se acumula en cada pasada — crecimiento sin techo en
    # dominios que se reblindan periódicamente. La separación visual va DENTRO
    # del bloque, que sí se reescribe entero.
    awk -v bf="$TMP_DIR/wpconfig_block" '
      /stop editing/ && !hecho {
        while ((getline linea < bf) > 0) print linea
        hecho = 1
      }
      { print }
    ' "$WP_CONFIG" > "$TMP_DIR/cfg_new" && mv "$TMP_DIR/cfg_new" "$WP_CONFIG"
  else
    cat "$TMP_DIR/wpconfig_block" >> "$WP_CONFIG"
  fi
  _CFG_USER=""
  _CFG_U=$(stat -c '%U' "$WEBROOT" 2>/dev/null)
  if [ -n "$_CFG_U" ] && [ "$_CFG_U" != "root" ]; then
    _CFG_USER="$_CFG_U"
  fi
  if [ -z "$_CFG_USER" ]; then
    _CFG_USER=$(plesk db -sNe "SELECT su.login FROM domains d JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE d.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  fi
  if [ -n "$_CFG_USER" ] && [ "$_CFG_USER" != "root" ]; then
    chown "$_CFG_USER:psacln" "$WP_CONFIG" 2>/dev/null || chown "$_CFG_USER:$_CFG_USER" "$WP_CONFIG" 2>/dev/null || true
  fi
  chmod 640 "$WP_CONFIG" 2>/dev/null || chmod 600 "$WP_CONFIG" 2>/dev/null || true

  # Comprobar que el PHP sigue siendo sintácticamente válido. Si lo rompimos,
  # se restaura el respaldo: es preferible quedarse sin la medida que dejar el
  # sitio caído.
  if php -l "$WP_CONFIG" >/dev/null 2>&1; then
    emit_measure "wpconfig" 1 "DISALLOW_FILE_EDIT y DISALLOW_FILE_MODS activos"
  else
    cp -f "$WP_CONFIG.kraken.bak" "$WP_CONFIG" 2>/dev/null || true
    emit_measure "wpconfig" 0 "REVERTIDO: la edición dejaba wp-config.php con sintaxis inválida"
  fi
fi
`);
  } else {
    partes.push(`
# ── Restaurar candado previo si estaba activo y no se pidió la medida ──────
if [ "$_TENIA_CANDADO" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  emit_progress "wpconfig" "Restaurando candado de seguridad previo"
  cp -f "$WP_CONFIG" "$WP_CONFIG.kraken.bak" 2>/dev/null || true
  strip_block "$WP_CONFIG" ${shellQuote(PHP_MARK_BEGIN)} ${shellQuote(PHP_MARK_END)}
  sed -i "/DISALLOW_FILE_EDIT/d; /DISALLOW_FILE_MODS/d; /WP_DEBUG_DISPLAY/d" "$WP_CONFIG" 2>/dev/null || true
  ${heredoc('$TMP_DIR/wpconfig_restore_block', [
    PHP_MARK_BEGIN,
    '// Bloque inyectado por Blindaje Kraken. No editar a mano.',
    "define( 'DISALLOW_FILE_EDIT', true );",
    "define( 'DISALLOW_FILE_MODS', true );",
    "define( 'WP_DEBUG_DISPLAY', false );",
    PHP_MARK_END,
  ].join('\n'), 'WPCONFIG_RESTORE_EOF')}
  if grep -q "stop editing" "$WP_CONFIG"; then
    awk -v block="$(cat "$TMP_DIR/wpconfig_restore_block")" '
      index($0, "stop editing") { print block "\\n" }
      { print }
    ' "$WP_CONFIG" > "$TMP_DIR/wpconfig.tmp" && mv "$TMP_DIR/wpconfig.tmp" "$WP_CONFIG"
  else
    cat "$TMP_DIR/wpconfig_restore_block" >> "$WP_CONFIG"
  fi
  php -l "$WP_CONFIG" >/dev/null 2>&1 || cp -f "$WP_CONFIG.kraken.bak" "$WP_CONFIG" 2>/dev/null || true
fi
`);
  }

  partes.push(`
# ── Restaurar propietario y permisos seguros para Plesk/PHP-FPM ────────────
# ── Restaurar propietario y permisos seguros para Plesk/PHP-FPM ────────────
# Resolver usuario real del vhost Plesk (NUNCA dejar archivos propiedad de root)
VHOST_SYS_USER=""
_CU=$(stat -c '%U' "$WEBROOT" 2>/dev/null)
if [ -n "$_CU" ] && [ "$_CU" != "root" ]; then
  VHOST_SYS_USER="$_CU"
fi
if [ -z "$VHOST_SYS_USER" ]; then
  VHOST_SYS_USER=$(plesk db -sNe "SELECT su.login FROM domains d JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE d.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
fi
if [ -z "$VHOST_SYS_USER" ]; then
  VHOST_SYS_USER=$(plesk db -sNe "SELECT su.login FROM domain_aliases da JOIN domains d ON d.id=da.dom_id JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE da.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
fi
if [ -z "$VHOST_SYS_USER" ]; then
  VHOST_SYS_USER=$(plesk db -sNe "SELECT su.login FROM subdomains s JOIN domains d ON d.id=s.dom_id JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE (s.name='$DOMAIN' OR CONCAT(s.name, '.', d.name)='$DOMAIN') LIMIT 1" 2>/dev/null | xargs)
fi
if [ -z "$VHOST_SYS_USER" ]; then
  VHOST_SYS_USER=$(plesk bin site --info "$DOMAIN" 2>/dev/null | grep -i "System user" | head -1 | awk '{print $NF}' | xargs)
fi
if [ -z "$VHOST_SYS_USER" ]; then
  _PARENT_U=$(stat -c '%U' "$WEBROOT/.." 2>/dev/null)
  [ -n "$_PARENT_U" ] && [ "$_PARENT_U" != "root" ] && VHOST_SYS_USER="$_PARENT_U"
fi

if [ -n "$VHOST_SYS_USER" ] && [ "$VHOST_SYS_USER" != "root" ]; then
  VHOST_SYS_GRP="psacln"
  getent group psacln >/dev/null 2>&1 || VHOST_SYS_GRP="$VHOST_SYS_USER"
  chown -R "$VHOST_SYS_USER:$VHOST_SYS_GRP" "$WEBROOT" 2>/dev/null || true
fi

# Normalización total de permisos en el árbol webroot
find "$WEBROOT" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$WEBROOT" -type f -exec chmod 644 {} + 2>/dev/null || true

# Permisos seguros para archivos críticos
chmod 640 "$WP_CONFIG" 2>/dev/null || chmod 600 "$WP_CONFIG" 2>/dev/null || true
[ -f "$HT_ROOT" ] && chmod 644 "$HT_ROOT" 2>/dev/null || true
[ -f "$WEBROOT/.user.ini" ] && chmod 644 "$WEBROOT/.user.ini" 2>/dev/null || true

echo "[BLINDAJE OK] Terminado para $DOMAIN"
`);

  return partes.join('\n');
}

/**
 * Script que quita el candado de wp-config para poder volver a instalar
 * plugins. Lo usa el CMS Reconstructor antes de trabajar sobre un dominio ya
 * blindado; después se vuelve a correr el blindaje.
 */
function buildUnlockScript(domain, vhostsRoot = VHOSTS_ROOT) {
  const webRoot = `${vhostsRoot}/${domain}/httpdocs`;
  return `#!/bin/bash
${BLOCK_HELPERS}
DOMAIN=${shellQuote(domain)}
WEBROOT=${shellQuote(webRoot)}
WP_CONFIG="$WEBROOT/wp-config.php"

# 1. Resolver por Plesk DB: dominios principales / adicionales
if [ ! -f "$WP_CONFIG" ]; then
  _PLESK_DB_ROOT=$(plesk db -Ne "SELECT IF(h.www_root LIKE '/var/www/%', h.www_root, CONCAT(su.home, '/', TRIM(LEADING '/' FROM h.www_root))) FROM domains d JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE d.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  if [ -n "$_PLESK_DB_ROOT" ] && [ -d "$_PLESK_DB_ROOT" ]; then
    WEBROOT="$_PLESK_DB_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 2. Resolver por Plesk DB: alias de dominio
if [ ! -f "$WP_CONFIG" ]; then
  _PLESK_ALIAS_ROOT=$(plesk db -Ne "SELECT IF(h.www_root LIKE '/var/www/%', h.www_root, CONCAT(su.home, '/', TRIM(LEADING '/' FROM h.www_root))) FROM domain_aliases da JOIN domains d ON d.id=da.dom_id JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE da.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  if [ -n "$_PLESK_ALIAS_ROOT" ] && [ -d "$_PLESK_ALIAS_ROOT" ]; then
    WEBROOT="$_PLESK_ALIAS_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 3. Resolver por Plesk DB: subdominios
if [ ! -f "$WP_CONFIG" ]; then
  _PLESK_SUB_ROOT=$(plesk db -Ne "SELECT IF(s.www_root LIKE '/var/www/%', s.www_root, CONCAT(su.home, '/', TRIM(LEADING '/' FROM s.www_root))) FROM subdomains s JOIN domains d ON d.id=s.dom_id JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE (s.name='$DOMAIN' OR CONCAT(s.name, '.', d.name)='$DOMAIN') LIMIT 1" 2>/dev/null | xargs)
  if [ -n "$_PLESK_SUB_ROOT" ] && [ -d "$_PLESK_SUB_ROOT" ]; then
    WEBROOT="$_PLESK_SUB_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 4. Resolver via WP-Toolkit
if [ ! -f "$WP_CONFIG" ]; then
  _WPT_ROOT=$(plesk ext wp-toolkit --list 2>/dev/null | grep -w "$DOMAIN" | grep -o '/var/www/vhosts/[^ ]*' | head -1 | xargs)
  if [ -n "$_WPT_ROOT" ] && [ -d "$_WPT_ROOT" ]; then
    WEBROOT="$_WPT_ROOT"
    WP_CONFIG="$WEBROOT/wp-config.php"
  fi
fi

# 5. Fallback a un nivel superior
if [ ! -f "$WP_CONFIG" ] && [ -f "$WEBROOT/../wp-config.php" ]; then
  WP_CONFIG="$WEBROOT/../wp-config.php"
fi

if [ ! -f "$WP_CONFIG" ]; then
  echo "[CANDADO] wp-config.php no encontrado para ${domain}"
  exit 1
fi

if grep -q "DISALLOW_FILE_MODS" "$WP_CONFIG" || has_block "$WP_CONFIG" ${shellQuote(PHP_MARK_BEGIN)}; then
  cp -f "$WP_CONFIG" "$WP_CONFIG.kraken.bak" 2>/dev/null || true
  strip_block "$WP_CONFIG" ${shellQuote(PHP_MARK_BEGIN)} ${shellQuote(PHP_MARK_END)}
  sed -i "/DISALLOW_FILE_EDIT/d; /DISALLOW_FILE_MODS/d; /WP_DEBUG_DISPLAY/d" "$WP_CONFIG" 2>/dev/null || true
  _USER=""
  _CFG_U=$(stat -c '%U' "$WP_CONFIG" 2>/dev/null)
  if [ -n "$_CFG_U" ] && [ "$_CFG_U" != "root" ]; then
    _USER="$_CFG_U"
  fi
  if [ -z "$_USER" ]; then
    _USER=$(plesk db -sNe "SELECT su.login FROM domains d JOIN hosting h ON h.dom_id=d.id JOIN sys_users su ON su.id=h.sys_user_id WHERE d.name='$DOMAIN' LIMIT 1" 2>/dev/null | xargs)
  fi
  if [ -n "$_USER" ] && [ "$_USER" != "root" ]; then
    chown "$_USER:psacln" "$WP_CONFIG" 2>/dev/null || chown "$_USER:$_USER" "$WP_CONFIG" 2>/dev/null || true
  fi
  chmod 640 "$WP_CONFIG" 2>/dev/null || chmod 600 "$WP_CONFIG" 2>/dev/null || true
  php -l "$WP_CONFIG" >/dev/null 2>&1 || cp -f "$WP_CONFIG.kraken.bak" "$WP_CONFIG"
  echo "[CANDADO] Levantado para ${domain}"
else
  echo "[CANDADO] No había candado en ${domain}"
fi
`;
}

module.exports = { buildApplyScript, buildUnlockScript, orderMeasures, APPLY_ORDER };
