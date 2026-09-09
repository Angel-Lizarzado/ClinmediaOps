// audit-service.js — Malware Scanner y Limpieza Avanzada de WordPress
// v1.19.1: Protección Regex Leak — excluye páginas estáticas y títulos core.
// Usa array de strings (nunca backticks) para evitar ReferenceError de Node.

const { getSshService } = require('./ssh-service');

const SPAM_REGEX = 'casino|slot|bet|ruleta|tragamonedas|tragaperras|jackpot|blackjack|baccarat|poker|bingo|loto|keno|spins|apuestas|1xbet|gamstop|viagra|cialis|levitra|kamagra|sildenafil|crypto|bitcoin|ethereum|binance|essay writing|buy essay|porn|xxx|escort|sex|dating';

// Títulos de páginas estáticas del core protegidas contra falsos positivos
const SAFE_PAGE_TITLES = "\\'Home\\', \\'Inicio\\', \\'Contacto\\', \\'Servicios\\', \\'Aviso legal\\', \\'Blog\\'";

/**
 * Genera script de auditoría Bash usando array de strings (sin backticks).
 * Las variables de JS (domain, httpdocs) se concatenan con +.
 * Las variables de Bash ($PREFIX, $DB_NAME, etc.) van literales.
 */
function generateAuditScript(domain) {
  const httpdocs = '/var/www/vhosts/' + domain + '/httpdocs';
  const baseDomain = domain.split('.')[0];
  return [
    'cd "' + httpdocs + '" 2>/dev/null || { echo \'===AUDIT_START===\'; echo \'{"domain":"' + domain + '","error":"httpdocs not found"}\'; echo \'===AUDIT_END===\'; exit 0; }',
    '',
    'PREFIX=$(grep "table_prefix" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f2 | cut -d\'"\' -f2 | xargs)',
    '[ -z "$PREFIX" ] && PREFIX="wp_"',
    'DB_NAME=$(grep "DB_NAME" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f4)',
    'DB_USER=$(grep "DB_USER" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f4)',
    'DB_PASS=$(grep "DB_PASSWORD" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f4)',
    '',
    'if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then',
    '  echo \'===AUDIT_START===\'',
    '  echo \'{"domain":"' + domain + '","error":"wp-config not found or incomplete"}\'',
    '  echo \'===AUDIT_END===\'',
    '  exit 0',
    'fi',
    '',
    '# Spam posts count (excluye autores protegidos, páginas estáticas y títulos core)',
    "SPAM_POSTS=$(mysql -N -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"SELECT COUNT(*) FROM ${PREFIX}posts p LEFT JOIN ${PREFIX}users u ON p.post_author = u.ID WHERE p.post_status NOT IN ('trash','auto-draft','inherit') AND (u.user_login IS NULL OR u.user_login NOT IN ('dev','administrador','" + baseDomain + "')) AND p.post_type != 'page' AND p.post_title NOT IN (" + SAFE_PAGE_TITLES + ") AND (p.post_title REGEXP '" + SPAM_REGEX + "' OR p.post_name REGEXP '" + SPAM_REGEX + "' OR p.post_content REGEXP '" + SPAM_REGEX + "') AND p.post_type NOT IN ('revision','nav_menu_item','customize_changeset')\" 2>/dev/null || echo 0)",
    '',
    '# Spam posts details (top 10, base64, excluye autores protegidos, páginas estáticas y títulos core)',
    "POSTS_DETAILS_B64=$(mysql -N -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"SELECT p.post_title FROM ${PREFIX}posts p LEFT JOIN ${PREFIX}users u ON p.post_author = u.ID WHERE p.post_status NOT IN ('trash','auto-draft','inherit') AND (u.user_login IS NULL OR u.user_login NOT IN ('dev','administrador','" + baseDomain + "')) AND p.post_type != 'page' AND p.post_title NOT IN (" + SAFE_PAGE_TITLES + ") AND (p.post_title REGEXP '" + SPAM_REGEX + "' OR p.post_name REGEXP '" + SPAM_REGEX + "' OR p.post_content REGEXP '" + SPAM_REGEX + "') AND p.post_type NOT IN ('revision','nav_menu_item','customize_changeset') LIMIT 10\" 2>/dev/null | base64 -w 0 2>/dev/null || echo '')",
    '',
    '# Spam terms count',
    "SPAM_TERMS=$(mysql -N -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"SELECT COUNT(*) FROM ${PREFIX}terms WHERE slug REGEXP '" + SPAM_REGEX + "'\" 2>/dev/null || echo 0)",
    '',
    '# Backdoors count (excluye index.php de plugins, incluye webshells y dobles extensiones)',
    "BACKDOORS_ROOT=$(find . -maxdepth 1 -type f \\( -name \"google*.html\" -o -name \"index1.xml\" -o -name \"default.php\" -o -name \"info.php\" -o -name \"wp-reset.php\" -o -name \"wp-feed.php\" -o -name \"wp-tmp.php\" -o -name \"wp-update.php\" \\) 2>/dev/null | wc -l)",
    "BACKDOORS_UPLOADS=$(find wp-content/uploads -maxdepth 3 -type f \\( -name \"*.php\" -o -name \"*.php.jpg\" -o -name \"*.php.png\" -o -name \"*.phtml\" \\) -not -name \"index.php\" -not -path \"*/aios/*\" 2>/dev/null | wc -l)",
    'BACKDOORS=$(( BACKDOORS_ROOT + BACKDOORS_UPLOADS ))',
    '',
    '# Backdoors details (top 10, base64, excluye index.php)',
    "FILES_DETAILS_B64=$( (find . -maxdepth 1 -type f \\( -name \"google*.html\" -o -name \"index1.xml\" -o -name \"default.php\" -o -name \"info.php\" -o -name \"wp-reset.php\" -o -name \"wp-feed.php\" -o -name \"wp-tmp.php\" -o -name \"wp-update.php\" \\) 2>/dev/null; find wp-content/uploads -maxdepth 3 -type f \\( -name \"*.php\" -o -name \"*.php.jpg\" -o -name \"*.php.png\" -o -name \"*.phtml\" \\) -not -name \"index.php\" -not -path \"*/aios/*\" 2>/dev/null) | head -10 | base64 -w 0 2>/dev/null || echo '')",
    '',
    '# Injected options count',
    "INJECTED_OPTS=$(mysql -N -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"SELECT COUNT(*) FROM ${PREFIX}options WHERE option_value LIKE '%<script%' OR option_value LIKE '%base64_decode%'\" 2>/dev/null || echo 0)",
    '',
    '# Corrupted URLs count',
    "CORRUPTED_URLS=$(mysql -N -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"SELECT COUNT(*) FROM ${PREFIX}options WHERE option_name IN ('siteurl','home') AND option_value LIKE '%/var/www/vhosts/%'\" 2>/dev/null || echo 0)",
    '',
    '# Corrupted URLs details (top 10, base64)',
    "URLS_DETAILS_B64=$(mysql -N -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"SELECT CONCAT(option_name, ': ', option_value) FROM ${PREFIX}options WHERE option_name IN ('siteurl','home') AND option_value LIKE '%/var/www/vhosts/%' LIMIT 10\" 2>/dev/null | base64 -w 0 2>/dev/null || echo '')",
    '',
    '# GHOST ADMINS via WP-CLI + conteo de posts por admin (Base64 JSON)',
    'ADMINS_B64=$(plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- user list --role=administrator --fields=ID,user_login,user_email,user_registered --format=json 2>/dev/null | base64 -w 0 2>/dev/null || echo \'\')',
    'ADMIN_POSTS_B64=$(mysql -N -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT u.ID, u.user_login, COUNT(p.ID) as post_count FROM ${PREFIX}users u LEFT JOIN ${PREFIX}posts p ON u.ID = p.post_author AND p.post_status NOT IN (\'trash\',\'auto-draft\') WHERE u.ID IN (SELECT um.user_id FROM ${PREFIX}usermeta um WHERE um.meta_key=\'${PREFIX}capabilities\' AND um.meta_value LIKE \'%administrator%\') GROUP BY u.ID, u.user_login ORDER BY post_count DESC" 2>/dev/null | base64 -w 0 2>/dev/null || echo \'\')',
    '',
    '# Check if hardening is already applied',
    'HARDENING_OK=$(grep -q "<Files xmlrpc.php>" /var/www/vhosts/' + domain + '/httpdocs/.htaccess 2>/dev/null && echo "true" || echo "false")',
    '',
    '# RECENT POSTS via WP-CLI (LIFO, top 100, Base64 JSON)',
    'RECENT_POSTS_B64=$(plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- post list --post_type=post,page --post_status=publish --orderby=post_date --order=DESC --posts_per_page=100 --fields=post_author,post_title,post_date --format=json 2>/dev/null | base64 -w 0 || echo "")',
    '',
    '# CRON JOBS via WP-CLI (Base64 JSON)',
    'CRONS_B64=$(plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- cron event list --format=json 2>/dev/null | base64 -w 0 2>/dev/null || echo \'\')',
    '',
    '# HTACCESS INFECTIONS (cloaking / backdoors / auto_prepend)',
    'HTACCESS_B64=$(grep -E "(RewriteCond.*HTTP_REFERER.*google|RewriteRule.*\\.(ru|cn|tk|pw|cc)\\b|auto_prepend_file|auto_append_file)" /var/www/vhosts/' + domain + '/httpdocs/.htaccess 2>/dev/null | head -n 10 | base64 -w 0 2>/dev/null || echo \'\')',
    '',
    'RISK=$(( SPAM_POSTS + SPAM_TERMS + BACKDOORS + INJECTED_OPTS + CORRUPTED_URLS ))',
    '',
    'echo \'===AUDIT_START===\'',
    'echo \'{"domain":"' + domain + '","risk":\'"$RISK"\' ,"spam_posts":\'"$SPAM_POSTS"\' ,"spam_terms":\'"$SPAM_TERMS"\' ,"backdoors":\'"$BACKDOORS"\' ,"injected_options":\'"$INJECTED_OPTS"\' ,"corrupted_urls":\'"$CORRUPTED_URLS"\' ,"posts_b64":"\'"$POSTS_DETAILS_B64"\'","backdoors_b64":"\'"$FILES_DETAILS_B64"\'","urls_b64":"\'"$URLS_DETAILS_B64"\'","admins_b64":"\'"$ADMINS_B64"\'","admins_posts_b64":"\'"$ADMIN_POSTS_B64"\'","recent_posts_b64":"\'"$RECENT_POSTS_B64"\'","crons_b64":"\'"$CRONS_B64"\'","htaccess_b64":"\'"$HTACCESS_B64"\'","isProtected":\'"$HARDENING_OK"\' }\'',
    'echo \'===AUDIT_END===\''
  ].join('\n');
}

/**
 * Helper: extrae el base del dominio (sin TLD) para protegerlo en la limpieza.
 */
function getDomainBase(domain) {
  return domain.split('.')[0];
}

/**
 * Genera script de limpieza Bash usando array de strings (sin backticks).
 * v1.18.0: streaming de progreso con marcadores @@@PROGRESS@@@.
 * @param {string} domain - Dominio a limpiar
 * @param {Array<{id: number, destroyContent: boolean}>} ghostAdminsConfig - Admins fantasma a purgar
 */
function generateCleanScript(domain, ghostAdminsConfig = []) {
  const httpdocs = '/var/www/vhosts/' + domain + '/httpdocs';
  const domainBase = getDomainBase(domain);

  // Construye comandos de purga de admins fantasma (se inyectan antes de Fase 9)
  const ghostAdminLines = [];
  if (ghostAdminsConfig.length > 0) {
    ghostAdminLines.push('');
    ghostAdminLines.push('# GHOST ADMIN PURGE via WP-CLI');
    ghostAdminLines.push('SAFE_USER=$(plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- user get dev --field=ID 2>/dev/null || echo 1)');
    for (const admin of ghostAdminsConfig) {
      if (admin.destroyContent) {
        ghostAdminLines.push('plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- user delete ' + admin.id + ' --yes 2>/dev/null || true');
      } else {
        ghostAdminLines.push('plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- user delete ' + admin.id + ' --reassign=$SAFE_USER --yes 2>/dev/null || true');
      }
    }
  }

  return [
    'cd "' + httpdocs + '" 2>/dev/null || exit 1',
    '',
    'PREFIX=$(grep "table_prefix" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f2 | cut -d\'"\' -f2 | xargs)',
    '[ -z "$PREFIX" ] && PREFIX="wp_"',
    'DB_NAME=$(grep "DB_NAME" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f4)',
    'DB_USER=$(grep "DB_USER" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f4)',
    'DB_PASS=$(grep "DB_PASSWORD" wp-config.php 2>/dev/null | head -1 | cut -d"\'" -f4)',
    '',
    'if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then exit 1; fi',
    '',
    // Progress markers
    'echo \'@@@PROGRESS@@@{"step":"init","msg":"Iniciando protocolo de limpieza..."}@@@END@@@\'',
    '',
    '# 1. Trash posts spam (excluye autores protegidos, páginas estáticas y títulos core)',
    'echo \'@@@PROGRESS@@@{"step":"spam","msg":"Eliminando posts y términos de SPAM..."}@@@END@@@\'',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"UPDATE ${PREFIX}posts p LEFT JOIN ${PREFIX}users u ON p.post_author = u.ID SET p.post_status='trash' WHERE p.post_status NOT IN ('trash','auto-draft') AND (u.user_login IS NULL OR u.user_login NOT IN ('dev','administrador','" + domainBase + "')) AND p.post_type != 'page' AND p.post_title NOT IN (" + SAFE_PAGE_TITLES + ") AND (p.post_title REGEXP '" + SPAM_REGEX + "' OR p.post_name REGEXP '" + SPAM_REGEX + "') AND p.post_type NOT IN ('revision','nav_menu_item','customize_changeset')\" 2>/dev/null",
    '',
    '# 2. Delete spam terms',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"DELETE FROM ${PREFIX}terms WHERE slug REGEXP '" + SPAM_REGEX + "'\" 2>/dev/null",
    '',
    '# 3. Clean orphaned taxonomies/relationships/postmeta',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"DELETE FROM ${PREFIX}term_taxonomy WHERE term_id NOT IN (SELECT term_id FROM ${PREFIX}terms)\" 2>/dev/null",
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"DELETE FROM ${PREFIX}term_relationships WHERE object_id NOT IN (SELECT ID FROM ${PREFIX}posts)\" 2>/dev/null",
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"DELETE FROM ${PREFIX}postmeta WHERE post_id NOT IN (SELECT ID FROM ${PREFIX}posts)\" 2>/dev/null",
    '',
    '# 4. Truncate comments',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"TRUNCATE ${PREFIX}comments\" 2>/dev/null || true",
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"TRUNCATE ${PREFIX}commentmeta\" 2>/dev/null || true",
    '',
    '# 5. Delete injected options',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"DELETE FROM ${PREFIX}options WHERE option_value LIKE '%<script%' OR option_value LIKE '%base64_decode%'\" 2>/dev/null",
    '',
    '# 5b. Purge transients',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"DELETE FROM ${PREFIX}options WHERE option_name LIKE '\\_transient\\_%' OR option_name LIKE '\\_site\\_transient\\_%'\" 2>/dev/null",
    '',
    '# 6. Fix corrupted siteurl/home',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"UPDATE ${PREFIX}options SET option_value='https://" + domain + "' WHERE option_name='siteurl' AND option_value LIKE '%/var/www/vhosts/%'\" 2>/dev/null",
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"UPDATE ${PREFIX}options SET option_value='https://" + domain + "' WHERE option_name='home' AND option_value LIKE '%/var/www/vhosts/%'\" 2>/dev/null",
    '',
    '# 7. Drop all triggers in a single MySQL session (O(1) round-trips, not O(n))',
    "TRIGGER_DROPS=$(mysql -N -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"SELECT CONCAT('DROP TRIGGER IF EXISTS \\\`',TRIGGER_NAME,'\\\`;') FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$DB_NAME'\" 2>/dev/null)",
    'if [ -n "$TRIGGER_DROPS" ]; then',
    '  echo "@@@syslog|CLEAN|info|DROP-TRIGGERS $(echo $TRIGGER_DROPS | grep -o DROP | wc -l) triggers"',
    '  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "$TRIGGER_DROPS" 2>/dev/null || true',
    '  echo "[OK] Triggers purgados en una sola sesión"',
    'fi',
    '',
    'echo \'@@@PROGRESS@@@{"step":"backdoors","msg":"Purgando archivos PHP maliciosos..."}@@@END@@@\'',
    '',
    '# 8a. Remove known backdoor files at root level',
    'rm -f google*.html index1.xml default.php info.php wp-reset.php wp-feed.php wp-tmp.php wp-update.php 2>/dev/null || true',
    '',
    '# 8a-2. Remove orphaned sitemaps and tar.gz/sql backups',
    'find . -maxdepth 2 -type f -name "sitemap*" ! -name "sitemap.xml" ! -name "sitemap_index.xml" -exec rm -f {} \\; 2>/dev/null || true',
    'find . -maxdepth 3 -type f \\( -name "*.tar.gz" -o -name "*.sql" \\) -exec rm -f {} \\; 2>/dev/null || true',
    '',
    '# 8b. Uploads: PHP files and double-extension files (maxdepth 3)',
    'find wp-content/uploads -maxdepth 3 -type f \\( -name "*.php" -o -name "*.php.jpg" -o -name "*.php.png" -o -name "*.phtml" \\) -not -name "index.php" -not -path "*/aios/*" -exec rm -f {} \\; 2>/dev/null || true',
    '',
    '# 8c. Plugins: PHP files with obfuscation patterns (eval, base64_decode, system, exec)',
    '# maxdepth 4 para no escanear plugins completos, solo archivos sueltos en raíz de plugin',
    "INFECTED_PLUGINS=$(find wp-content/plugins -maxdepth 4 -type f -name '*.php' -not -name 'index.php' -exec grep -lP '(eval\\s*\\(\\s*base64_decode|eval\\s*\\(\\s*gzinflate|system\\s*\\(|passthru\\s*\\(|shell_exec\\s*\\(|preg_replace\\s*\\(.*\\/e)' {} \\; 2>/dev/null)",
    'if [ -n "$INFECTED_PLUGINS" ]; then',
    '  echo "@@@syslog|CLEAN|warn|INFECTED-PLUGINS-FOUND"',
    '  echo "$INFECTED_PLUGINS" | while IFS= read -r f; do',
    '    echo "[BACKDOOR-PLUGIN] Eliminando: $f"',
    '    rm -f "$f"',
    '  done',
    'fi',
    '',
    '# 8d. Themes: same pattern, maxdepth 3',
    "INFECTED_THEMES=$(find wp-content/themes -maxdepth 3 -type f -name '*.php' -not -name 'index.php' -not -name 'functions.php' -not -name 'style.css' -exec grep -lP '(eval\\s*\\(\\s*base64_decode|eval\\s*\\(\\s*gzinflate|system\\s*\\(|passthru\\s*\\(|shell_exec\\s*\\()' {} \\; 2>/dev/null)",
    'if [ -n "$INFECTED_THEMES" ]; then',
    '  echo "@@@syslog|CLEAN|warn|INFECTED-THEMES-FOUND"',
    '  echo "$INFECTED_THEMES" | while IFS= read -r f; do',
    '    echo "[BACKDOOR-THEME] Eliminando: $f"',
    '    rm -f "$f"',
    '  done',
    'fi',
    '',
    '# PURGE .HTACCESS INFECTIONS (cloaking / backdoors / auto_prepend)',
    'sed -i -e "/RewriteCond.*HTTP_REFERER.*google/d" -e "/RewriteRule.*\\.\\(ru\\|cn\\|tk\\|pw\\|cc\\)\\b/d" -e "/auto_prepend_file/d" -e "/auto_append_file/d" /var/www/vhosts/' + domain + '/httpdocs/.htaccess 2>/dev/null || true',
    '',
    'echo \'@@@PROGRESS@@@{"step":"urls","msg":"Corrigiendo rutas /var/ en la DB..."}@@@END@@@\'',
    'plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- option delete upload_path 2>/dev/null || true',
    'plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- option set upload_path "" 2>/dev/null || true',
    '',
    ...ghostAdminLines,
    '',
    'echo \'@@@PROGRESS@@@{"step":"admins","msg":"Aniquilando administradores fantasma..."}@@@END@@@\'',
    '',
    '# 9. Strip admin caps from all EXCEPT dev, administrador, and domain base',
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"DELETE FROM ${PREFIX}usermeta WHERE meta_key='${PREFIX}capabilities' AND user_id NOT IN (SELECT ID FROM ${PREFIX}users WHERE user_login IN ('dev','administrador','" + domainBase + "'))\" 2>/dev/null",
    "mysql -u\"$DB_USER\" -p\"$DB_PASS\" \"$DB_NAME\" -e \"INSERT INTO ${PREFIX}usermeta (user_id,meta_key,meta_value) SELECT ID,'${PREFIX}capabilities','a:1:{s:13:\"administrator\";b:1;}' FROM ${PREFIX}users WHERE user_login IN ('dev','administrador','" + domainBase + "') AND ID NOT IN (SELECT user_id FROM ${PREFIX}usermeta WHERE meta_key='${PREFIX}capabilities')\" 2>/dev/null",
    '',
    'echo \'@@@PROGRESS@@@{"step":"htaccess","msg":"Limpiando cloaking en .htaccess..."}@@@END@@@\'',
    '',
    '# 10. HARDENING — WP_DEBUG_DISPLAY, xmlrpc block, .htaccess protection',
    'echo "[HARDEN] Aplicando Hardening al servidor..."',
    'echo \'@@@PROGRESS@@@{"step":"hardening","msg":"Aplicando escudo de seguridad (Hardening)..."}@@@END@@@\'',
    'if ! grep -q "WP_DEBUG_DISPLAY" /var/www/vhosts/' + domain + '/httpdocs/wp-config.php 2>/dev/null; then',
    '  echo "define(\'WP_DEBUG_DISPLAY\', false);" >> /var/www/vhosts/' + domain + '/httpdocs/wp-config.php 2>/dev/null',
    '  echo "@ini_set(\'display_errors\', 0);" >> /var/www/vhosts/' + domain + '/httpdocs/wp-config.php 2>/dev/null',
    'fi',
    'HT_PATH="/var/www/vhosts/' + domain + '/httpdocs/.htaccess"',
    'plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- rewrite flush --hard 2>/dev/null || true',
    'plesk ext wp-toolkit --wp-cli -domain "' + domain + '" -- elementor flush_css 2>/dev/null || true',
    'if [ -f "$HT_PATH" ]; then',
    '  if ! grep -q "<Files xmlrpc.php>" "$HT_PATH"; then',
    '    printf "\\n<Files xmlrpc.php>\\n  Require all denied\\n</Files>\\n" >> "$HT_PATH"',
    '    echo "[HARDEN OK]"',
    '  else',
    '    echo "[ALREADY PROTECTED]"',
    '  fi',
    'else',
    '  printf "<Files xmlrpc.php>\\n  Require all denied\\n</Files>\\n" > "$HT_PATH"',
    '  chmod 644 "$HT_PATH"',
    '  echo "[HARDEN OK]"',
    'fi',
    '',
    '# 11. Strict File Permissions (755 Dirs / 644 Files)',
    'echo \'@@@PROGRESS@@@{"step":"permissions","msg":"Restaurando permisos seguros de archivos..."}@@@END@@@\'',
    'find /var/www/vhosts/' + domain + '/httpdocs -type d -exec chmod 755 {} \\; 2>/dev/null || true',
    'find /var/www/vhosts/' + domain + '/httpdocs -type f -exec chmod 644 {} \\; 2>/dev/null || true',
    'if [ -f /var/www/vhosts/' + domain + '/httpdocs/wp-config.php ]; then',
    '  chmod 600 /var/www/vhosts/' + domain + '/httpdocs/wp-config.php 2>/dev/null || true',
    'fi',
    '',
    'echo \'@@@PROGRESS@@@{"step":"done","msg":"Sitio limpio y protegido con éxito"}@@@END@@@\'',
    '',
    'echo "[CLEAN OK] Limpieza completada para ' + domain + '"'
  ].join('\n');
}

/**
 * Decodifica un campo base64 a un array de strings.
 */
function decodeB64Array(b64Str) {
  if (!b64Str || b64Str === '') return [];
  try {
    const decoded = Buffer.from(b64Str, 'base64').toString('utf-8');
    return decoded.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ejecuta auditoría sobre un cliente SSH existente.
 * Retorna objeto parseado del JSON entre ===AUDIT_START=== ===AUDIT_END===,
 * con los campos _b64 decodificados a arrays reales.
 */
async function runAudit(sshClient, domain) {
  const script = generateAuditScript(domain);
  const sshService = getSshService();
  const result = await sshService.executeCommand(sshClient, script);
  const output = result.stdout || '';

  const startMatch = output.match(/===AUDIT_START===/);
  const endMatch = output.match(/===AUDIT_END===/);
  if (!startMatch || !endMatch) {
    return { domain: domain, error: 'No audit output received', raw: output.slice(0, 500) };
  }

  const jsonStr = output.slice(startMatch.index + startMatch[0].length, endMatch.index).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { domain: domain, error: 'Failed to parse audit JSON: ' + jsonStr.slice(0, 200) };
  }

  // Decode Base64 fields into real arrays / raw strings
  parsed.posts_details = decodeB64Array(parsed.posts_b64);
  parsed.backdoors_details = decodeB64Array(parsed.backdoors_b64);
  parsed.urls_details = decodeB64Array(parsed.urls_b64);
  delete parsed.posts_b64;
  delete parsed.backdoors_b64;
  delete parsed.urls_b64;

  // Ghost Admins: JSON array from Base64
  if (parsed.admins_b64 && parsed.admins_b64 !== '') {
    try {
      parsed.raw_admins = JSON.parse(Buffer.from(parsed.admins_b64, 'base64').toString('utf-8'));
    } catch {
      parsed.raw_admins = [];
    }
  } else {
    parsed.raw_admins = [];
  }
  delete parsed.admins_b64;

  // Admin post counts: parsed from Base64 (TSV: ID, login, count)
  if (parsed.admins_posts_b64 && parsed.admins_posts_b64 !== '') {
    try {
      const raw = Buffer.from(parsed.admins_posts_b64, 'base64').toString('utf-8');
      parsed.adminPostCounts = raw.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { id: Number(parts[0]), login: parts[1], count: Number(parts[2] || 0) };
      });
    } catch {
      parsed.adminPostCounts = [];
    }
  } else {
    parsed.adminPostCounts = [];
  }
  delete parsed.admins_posts_b64;

  // Suspicious Crons: JSON array from Base64
  if (parsed.crons_b64 && parsed.crons_b64 !== '') {
    try {
      parsed.raw_crons = JSON.parse(Buffer.from(parsed.crons_b64, 'base64').toString('utf-8'));
    } catch {
      parsed.raw_crons = [];
    }
  } else {
    parsed.raw_crons = [];
  }
  delete parsed.crons_b64;

  // .htaccess lines: plain text from Base64
  parsed.htaccess_raw = (parsed.htaccess_b64 && parsed.htaccess_b64 !== '')
    ? Buffer.from(parsed.htaccess_b64, 'base64').toString('utf-8')
    : '';
  delete parsed.htaccess_b64;

  // Recent posts (LIFO, top 100): JSON array from Base64
  if (parsed.recent_posts_b64 && parsed.recent_posts_b64 !== '') {
    try {
      parsed.recentPosts = JSON.parse(Buffer.from(parsed.recent_posts_b64, 'base64').toString('utf-8'));
    } catch {
      parsed.recentPosts = [];
    }
  } else {
    parsed.recentPosts = [];
  }
  delete parsed.recent_posts_b64;

  return parsed;
}

/**
 * Helper: filtra marcadores @@@PROGRESS@@@ de un string y lo trunca.
 */
function sanitizeOutput(str) {
  return str.replace(/@@@PROGRESS@@@.*?@@@END@@@/gs, '').replace(/\n{3,}/g, '\n').trim();
}

/**
 * Ejecuta limpieza sobre un cliente SSH existente con streaming de progreso.
 * @param {object} sshClient - Cliente SSH conectado
 * @param {string} domain - Dominio a limpiar
 * @param {Array<{id: number, destroyContent: boolean}>} [ghostAdminsConfig] - Admins fantasma a purgar
 * @param {Function} [onProgress] - Callback (payload) por cada marcador @@@PROGRESS@@@
 * @returns {Promise<{domain: string, success: boolean, error?: string}>}
 */
async function runClean(sshClient, domain, ghostAdminsConfig = [], onProgress) {
  const script = generateCleanScript(domain, ghostAdminsConfig);
  const sshService = getSshService();

  let bashOutput = '';
  const streamCallback = (chunk) => {
    bashOutput += chunk;
    if (typeof onProgress !== 'function') return;
    const regex = /@@@PROGRESS@@@(.*?)@@@END@@@/g;
    let match;
    while ((match = regex.exec(chunk)) !== null) {
      try {
        const payload = JSON.parse(match[1]);
        onProgress(payload);
      } catch (_) {
        // ignorar parseo inválido
      }
    }
  };

  const result = await sshService.executeStreamCommand(sshClient, script, streamCallback);

  // Verificación real de éxito:
  // 1. El exit code del script Bash debe ser 0.
  // 2. El output debe contener el marker [CLEAN OK] que sólo se emite al final del script.
  // Antes: siempre retornaba success:true aunque el script hubiera fallado a la mitad.
  const exitCode = result?.code ?? result?.exitCode ?? (result?.stderr ? 1 : 0);

  if (exitCode !== 0) {
    const errorSnippet = (bashOutput || '').split('\n').filter(l => l.includes('[ERROR]') || l.includes('exit 1')).slice(0, 3).join(' | ');
    return {
      domain,
      success: false,
      error: `Script de limpieza falló (exit=${exitCode})${errorSnippet ? ': ' + errorSnippet : ''}`,
    };
  }

  if (!bashOutput.includes('[CLEAN OK]')) {
    // El marker se perdió (conexión SSH inestable o script interrumpido antes del final)
    return {
      domain,
      success: false,
      error: 'Limpieza no confirmada por el servidor — marcador [CLEAN OK] no recibido. Verificar manualmente.',
    };
  }

  return { domain, success: true };
}

/**
 * Genera script de hardening Bash (solo Fase 10).
 * @param {string} domain - Dominio a proteger
 */
// NOTA: generateHardenScript vivia aca. El hardening ahora es responsabilidad
// exclusiva de src/services/hardening/ — habia dos scripts divergentes (este y
// sourcesync/step10) que aplicaban medidas distintas. runHarden delega alli.

/**
 * Ejecuta hardening sobre un cliente SSH existente con streaming de progreso.
 * @param {object} sshClient - Cliente SSH conectado
 * @param {string} domain - Dominio a proteger
 * @param {Function} [onProgress] - Callback (payload) por cada marcador @@@PROGRESS@@@
 * @returns {Promise<{domain: string, success: boolean, error?: string}>}
 */
async function runHarden(sshClient, domain, onProgress) {
  // Delega en el servicio de blindaje, que es la ÚNICA fuente de verdad del
  // hardening. Antes este archivo tenía su propio script y sourcesync/step10
  // tenía otro distinto: uno bloqueaba xmlrpc pero no protegía wp-config, el
  // otro al revés. Ahora los dos consumen lo mismo.
  const { applyHardening, verifyHardening } = require('./hardening/hardeningService');
  const sshService = getSshService();

  // Adaptador de contrato: el módulo nuevo emite { measure, status, msg } y
  // los consumidores existentes (scanner.ipc.js y la UI) esperan { step, msg }.
  const adaptarProgreso = (payload) => {
    if (typeof onProgress !== 'function') return;
    onProgress({ step: payload.measure || 'hardening', msg: payload.msg || '' });
  };

  const aplicacion = await applyHardening(sshClient, domain, {
    // El hardening histórico de este módulo también purgaba webshells y
    // ajustaba memoria, así que se incluyen para no perder comportamiento.
    measures: ['sanitize', 'files', 'xmlrpc', 'restapi', 'login', 'optimize', 'wpconfig'],
    onProgress: adaptarProgreso,
  });

  if (!aplicacion.success && aplicacion.error) {
    return { domain, success: false, error: aplicacion.error };
  }

  // Verificar y devolver el cumplimiento: aplicar sin comprobar deja al
  // operador sin forma de saber si el blindaje realmente quedó puesto.
  let verificacion = null;
  try {
    verificacion = await verifyHardening(sshClient, domain, { onProgress: adaptarProgreso });
  } catch (_) { /* la verificación es informativa, no bloquea */ }

  // ── Elementor cache flush (no URLs — post-harden reassurance) ──
  try {
    await sshService.fixWordPressElementor(domain, null, null, sshClient);
  } catch (_) { /* silent */ }

  if (typeof onProgress === 'function') {
    onProgress({
      step: 'done',
      msg: verificacion ? `Sitio protegido — cumplimiento ${verificacion.score}%` : 'Sitio protegido con éxito',
    });
  }

  return {
    domain,
    success: true,
    score: verificacion?.score ?? null,
    verify: verificacion,
  };
}

module.exports = { generateAuditScript, generateCleanScript, runAudit, runClean, runHarden };
