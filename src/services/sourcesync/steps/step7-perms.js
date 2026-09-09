'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');
const { wpCmd } = require('../utils/wptoolkit');

async function runStep7(ctx) {
  const log = createStepLogger(ctx.emit, 7, ctx.totalSteps);
  log.info(`Aplicando permisos (644/755) y regenerando permalinks...`);

  // ── Permisos del filesystem
  await ctx.run(`
    chown -R ${ctx.sysUser}:psacln "${ctx.webRoot}" 2>/dev/null || chown -R ${ctx.sysUser}:${ctx.sysUser} "${ctx.webRoot}" 2>/dev/null || true;
    find "${ctx.webRoot}" -type d -exec chmod 755 {} + 2>/dev/null || true;
    find "${ctx.webRoot}" -type f -exec chmod 644 {} + 2>/dev/null || true;
    chmod 640 "${ctx.webRoot}/wp-config.php" 2>/dev/null || chmod 600 "${ctx.webRoot}/wp-config.php" 2>/dev/null || true;
  `, { timeout: TIMEOUTS.X_LONG, allowFail: true });

  log.detail(`permisos 644/755 aplicados ✓`);

  // ── Verificar/fijar permalink_structure en la BD
  //    Si está vacía, WP-CLI escribe un .htaccess sin reglas → 404 en todas las páginas
  const structOut = (await ctx.run(
    `cd ${ctx.webRoot} && su -s /bin/bash ${ctx.sysUser} -c "wp option get permalink_structure 2>&1" 2>/dev/null`,
    { allowFail: true, timeout: 20000 }
  )).stdout?.trim() || '';

  if (!structOut || structOut === '0' || structOut.startsWith('Error')) {
    log.detail(`permalink_structure vacía → forzando /%postname%/`);
    await ctx.run(
      `cd ${ctx.webRoot} && su -s /bin/bash ${ctx.sysUser} -c "wp option update permalink_structure '/%postname%/' 2>&1" 2>/dev/null`,
      { allowFail: true, timeout: 20000 }
    );
  } else {
    log.detail(`permalink_structure: ${structOut}`);
  }

  // ── Escribir .htaccess directamente como root
  //    No dependemos de permisos del sysUser (archivos creados por root durante la migración
  //    pueden bloquear la escritura de WP-CLI, que corre como sysUser)
  await ctx.run(`cat > "${ctx.webRoot}/.htaccess" << 'HTEOF'
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
HTEOF`, { allowFail: true, timeout: 10000 });

  // Ownership correcto para que WP pueda reescribirlo después
  await ctx.run(
    `chown ${ctx.sysUser}:psacln "${ctx.webRoot}/.htaccess" 2>/dev/null || chown ${ctx.sysUser}:${ctx.sysUser} "${ctx.webRoot}/.htaccess" 2>/dev/null || true; chmod 644 "${ctx.webRoot}/.htaccess"`,
    { allowFail: true }
  );

  log.detail(`.htaccess WordPress escrito (root) ✓`);

  // ── wp cache flush + wp rewrite flush (sincroniza caché de BD)
  const cacheFlushCmd = wpCmd(ctx.instanceId, 'cache flush', ctx.sysUser, ctx.webRoot);
  await ctx.run(cacheFlushCmd, { allowFail: true });

  const rewriteFlushCmd = wpCmd(ctx.instanceId, 'rewrite flush --hard', ctx.sysUser, ctx.webRoot);
  await ctx.run(rewriteFlushCmd, { allowFail: true });

  // ── Reparar configuración Apache/Nginx de Plesk (HTTP + HTTPS/443)
  //    Sin esto, el vhost SSL puede ignorar el .htaccess
  if (ctx.domain) {
    log.detail(`plesk repair web para ${ctx.domain}...`);
    await ctx.run(`plesk repair web -domains ${ctx.domain} -y 2>&1 | tail -3`, {
      allowFail: true,
      timeout: TIMEOUTS.LONG,
    });
  }

  log.success(`Permisos + .htaccess + permalinks ✓`);
}

module.exports = { runStep7 };
