'use strict';

/**
 * @file step6-plugin.js
 * @description Gestión completa de plugins WP por dominio:
 *   1. Detección y levantamiento temporal del candado de seguridad (DISALLOW_FILE_MODS).
 *   2. Elementor Pro (desde ruta remota pre-subida + licencia desde config).
 *   3. ZIP adicional opcional (cualquier plugin).
 *   4. Lista negra: desactivación y eliminación completa de plugins conflictivos.
 *   5. Restauración del candado si estaba activo originalmente.
 */

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

/** Slugs que deben ser eliminados tras la reconstrucción. */
const BLACKLIST_PLUGINS = [
  { slug: 'all-in-one-wp-migration', name: 'All-in-One WP Migration' },
  { slug: 'gdpr-cookie-compliance', name: 'GDPR Cookie Compliance' },
  { slug: 'litespeed-cache', name: 'LiteSpeed Cache' },
  { slug: 'duplicate-page', name: 'Duplicate Page' },
  { slug: 'starter-templates', name: 'Starter Templates' },
  { slug: 'migrate-guru', name: 'Migrate Guru' },
];

const BLACKLIST_SLUGS = BLACKLIST_PLUGINS.map(p => p.slug);

/**
 * Detecta y levanta temporalmente la restricción de modificación de archivos en wp-config.php.
 * Retorna la ruta de wp-config.php si el candado estaba activo y fue levantado; false en caso contrario.
 * @param {object} ctx
 * @param {object} log
 * @returns {Promise<string|false>}
 */
async function liftFileModsLock(ctx, log) {
  const checkCmd = [
    `WP_CONFIG="${ctx.webRoot}/wp-config.php"`,
    `[ ! -f "$WP_CONFIG" ] && [ -f "${ctx.webRoot}/../wp-config.php" ] && WP_CONFIG="${ctx.webRoot}/../wp-config.php"`,
    `if [ -f "$WP_CONFIG" ] && grep -q "DISALLOW_FILE_MODS" "$WP_CONFIG"; then`,
    `  echo "LOCKED:$WP_CONFIG"`,
    `else`,
    `  echo "UNLOCKED"`,
    `fi`,
  ].join('\n');

  const res = await ctx.run(checkCmd, { allowFail: true, timeout: 10000 });
  const out = (res.stdout || '').trim();

  if (!out.startsWith('LOCKED:')) {
    return false;
  }

  const wpConfigPath = out.replace('LOCKED:', '').trim();
  log.info(`Candado detectado en wp-config.php — levantando restricción temporalmente...`);

  const unlockCmd = [
    `WP_CONFIG="${wpConfigPath}"`,
    `cp -f "$WP_CONFIG" "$WP_CONFIG.kraken.reconstructor.bak" 2>/dev/null || true`,
    `sed -i -E "s/define\s*\(\s*['\\"]DISALLOW_FILE_MODS['\\"].*/\\/\\/ KRAKEN_MODS_TEMP define( 'DISALLOW_FILE_MODS', false );/" "$WP_CONFIG"`,
    `sed -i -E "s/define\s*\(\s*['\\"]DISALLOW_FILE_EDIT['\\"].*/\\/\\/ KRAKEN_EDIT_TEMP define( 'DISALLOW_FILE_EDIT', false );/" "$WP_CONFIG"`,
    `chown ${ctx.sysUser}:psacln "$WP_CONFIG" 2>/dev/null || true`,
    `chmod 640 "$WP_CONFIG" 2>/dev/null || true`,
    `php -l "$WP_CONFIG" >/dev/null 2>&1 || cp -f "$WP_CONFIG.kraken.reconstructor.bak" "$WP_CONFIG"`,
  ].join('\n');

  await ctx.run(unlockCmd, { allowFail: true, timeout: 10000 });
  log.detail(`Restricción de modificación de archivos levantada temporalmente ✓`);
  return wpConfigPath;
}

/**
 * Restaura la restricción de modificación de archivos si estaba activa previamente.
 * @param {object} ctx
 * @param {string} wpConfigPath
 * @param {object} log
 */
async function restoreFileModsLock(ctx, wpConfigPath, log) {
  log.info(`Restaurando candado de seguridad en wp-config.php...`);

  const restoreCmd = [
    `WP_CONFIG="${wpConfigPath}"`,
    `if [ -f "$WP_CONFIG" ]; then`,
    `  sed -i "s/.*KRAKEN_MODS_TEMP.*/define( 'DISALLOW_FILE_MODS', true );/" "$WP_CONFIG"`,
    `  sed -i "s/.*KRAKEN_EDIT_TEMP.*/define( 'DISALLOW_FILE_EDIT', true );/" "$WP_CONFIG"`,
    `  chown ${ctx.sysUser}:psacln "$WP_CONFIG" 2>/dev/null || true`,
    `  chmod 640 "$WP_CONFIG" 2>/dev/null || true`,
    `  php -l "$WP_CONFIG" >/dev/null 2>&1 || cp -f "$WP_CONFIG.kraken.reconstructor.bak" "$WP_CONFIG"`,
    `  rm -f "$WP_CONFIG.kraken.reconstructor.bak" 2>/dev/null || true`,
    `  echo "RESTORED"`,
    `fi`,
  ].join('\n');

  const res = await ctx.run(restoreCmd, { allowFail: true, timeout: 10000 });
  if ((res.stdout || '').includes('RESTORED')) {
    log.success(`Candado de seguridad restaurado en wp-config.php ✓`);
  } else {
    log.warn(`No se pudo restaurar el candado en wp-config.php`);
  }
}

/**
 * Instala (unzip + chown + wp activate) un ZIP remoto en el servidor.
 * @param {object} ctx
 * @param {string} remoteZipPath  - ruta absoluta del zip en el servidor
 * @param {string} [pluginLabel]  - nombre legible para los logs
 * @param {object} [log]
 * @returns {Promise<string>} - nombre del directorio del plugin detectado
 */
async function installZip(ctx, remoteZipPath, pluginLabel = 'Plugin', log) {
  const cmd = [
    // Detectar carpeta del plugin dentro del zip
    `PLUGIN_DIR=$(unzip -Z1 "${remoteZipPath}" 2>/dev/null | head -n 1 | awk -F/ '{print $1}')`,
    `echo "DETECTED:$PLUGIN_DIR"`,
    // Extraer en plugins/
    `unzip -o -q "${remoteZipPath}" -d "${ctx.webRoot}/wp-content/plugins/" 2>&1`,
    // Ownership y permisos correctos para evitar errores 500
    `chown -R ${ctx.sysUser}:psacln "${ctx.webRoot}/wp-content/plugins/$PLUGIN_DIR" 2>/dev/null || true`,
    `chmod -R 755 "${ctx.webRoot}/wp-content/plugins/$PLUGIN_DIR" 2>/dev/null || true`,
    `find "${ctx.webRoot}/wp-content/plugins/$PLUGIN_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true`,
    // Activar
    `su -l ${ctx.sysUser} -s /bin/bash -c "cd ${ctx.webRoot} && /usr/local/bin/wp plugin activate $PLUGIN_DIR --allow-root 2>&1" || echo "WP_ACTIVATE_FAILED"`,
  ].join(' && ');

  const result = await ctx.run(cmd, { timeout: TIMEOUTS.LONG, allowFail: true });
  const out = result.stdout || '';

  const match = out.match(/DETECTED:(.+)/);
  const pluginDir = match ? match[1].trim() : 'desconocido';

  if (out.includes('WP_ACTIVATE_FAILED')) {
    log.warn(`${pluginLabel} '${pluginDir}' extraído — requiere activación manual`);
  } else {
    log.success(`${pluginLabel} '${pluginDir}' instalado y activado ✓`);
  }

  return pluginDir;
}

/**
 * Activa la licencia de Elementor Pro via WP-CLI.
 * @param {object} ctx
 * @param {string} licenseKey
 * @param {object} log
 */
async function activateElementorLicense(ctx, licenseKey, log) {
  const safeKey = String(licenseKey).replace(/'/g, '');
  const cmd = `su -l ${ctx.sysUser} -s /bin/bash -c `
    + `"cd ${ctx.webRoot} && /usr/local/bin/wp elementor-pro license activate '${safeKey}' --allow-root 2>&1"`;

  const result = await ctx.run(cmd, { timeout: TIMEOUTS.DEFAULT, allowFail: true });
  const out = (result.stdout || result.stderr || '').trim().slice(0, 120);

  if (result.code === 0 || out.toLowerCase().includes('success')) {
    log.success(`Licencia Elementor Pro activada ✓`);
  } else {
    log.warn(`Licencia Elementor Pro — respuesta: ${out || '(sin output)'}`);
  }
}

/**
 * Desactiva y elimina por completo plugins de la lista negra, respetando exclusiones.
 * @param {object} ctx
 * @param {object} log
 * @param {string[]} [excludedSlugs=[]] - slugs a omitir/conservar de la purga
 */
async function applyBlacklist(ctx, log, excludedSlugs = []) {
  const activeSlugs = BLACKLIST_SLUGS.filter(s => !excludedSlugs.includes(s));

  if (excludedSlugs.length > 0) {
    for (const slug of excludedSlugs) {
      log.detail(`[blacklist] ${slug} → conservado (deshabilitado de la lista negra por usuario) ✓`);
    }
  }

  log.info(`Lista negra: purgando ${activeSlugs.length} plugins conflictivos (conservados: ${excludedSlugs.length})...`);

  for (const slug of activeSlugs) {
    // Verificar si está instalado en WP
    const checkCmd = `su -l ${ctx.sysUser} -s /bin/bash -c `
      + `"cd ${ctx.webRoot} && /usr/local/bin/wp plugin is-installed ${slug} --allow-root 2>&1"`;

    const checkRes = await ctx.run(checkCmd, { allowFail: true, timeout: 15000 });

    if (checkRes.code !== 0) {
      // No está registrado en la base de datos de WP — comprobar si quedó el directorio huérfano en disco
      const checkDirCmd = `[ -d "${ctx.webRoot}/wp-content/plugins/${slug}" ] && rm -rf "${ctx.webRoot}/wp-content/plugins/${slug}" && echo "DIR_REMOVED" || echo "DIR_NONE"`;
      const dirRes = await ctx.run(checkDirCmd, { allowFail: true, timeout: 10000 });
      if ((dirRes.stdout || '').includes('DIR_REMOVED')) {
        log.detail(`[blacklist] ${slug} (directorio huérfano) → eliminado del disco ✓`);
      }
      continue;
    }

    // Está instalado — desactivar y eliminar por completo
    const deleteCmd = [
      `su -l ${ctx.sysUser} -s /bin/bash -c "cd ${ctx.webRoot} && /usr/local/bin/wp plugin deactivate ${slug} --allow-root 2>&1" || true`,
      `su -l ${ctx.sysUser} -s /bin/bash -c "cd ${ctx.webRoot} && /usr/local/bin/wp plugin delete ${slug} --allow-root 2>&1" || true`,
      `rm -rf "${ctx.webRoot}/wp-content/plugins/${slug}" 2>/dev/null || true`,
    ].join(' && ');

    const delRes = await ctx.run(deleteCmd, { allowFail: true, timeout: 25000 });
    const out = (delRes.stdout || '').trim().slice(0, 80);

    if (delRes.code === 0 || out.includes('Deleted') || out.includes('Success')) {
      log.detail(`[blacklist] ${slug} → eliminado por completo ✓`);
    } else {
      log.warn(`[blacklist] ${slug} → ${out || 'no se pudo eliminar'}`);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} opts
 * @param {string}   [opts.elementorZipRemotePath] - ruta remota del zip de Elementor Pro
 * @param {string}   [opts.elementorLicenseKey]    - clave de licencia EP
 * @param {string}   [opts.extraZipRemotePath]     - ruta remota de un ZIP adicional
 * @param {string[]} [opts.excludedBlacklistSlugs] - slugs de plugins a omitir de la lista negra
 */
async function runStep6(ctx, {
  elementorZipRemotePath = null,
  elementorLicenseKey    = null,
  extraZipRemotePath     = null,
  excludedBlacklistSlugs = [],
} = {}) {
  const log = createStepLogger(ctx.emit, 6, ctx.totalSteps);

  const hasElementor = !!elementorZipRemotePath;
  const hasExtra     = !!extraZipRemotePath;

  let lockedConfigPath = false;

  try {
    // ── 0. Levantar temporalmente el candado si el sitio estaba blindado ─────
    lockedConfigPath = await liftFileModsLock(ctx, log);

    if (!hasElementor && !hasExtra) {
      log.warn(`SKIP: No hay ZIPs de plugins para instalar`);
      // Purgamos la lista negra de todos modos
      await applyBlacklist(ctx, log, excludedBlacklistSlugs);
      return;
    }

    // ── 1. Elementor Pro ────────────────────────────────────────────────────────
    if (hasElementor) {
      log.info(`Instalando Elementor Pro desde ZIP remoto...`);
      await installZip(ctx, elementorZipRemotePath, 'Elementor Pro', log);

      if (elementorLicenseKey) {
        await activateElementorLicense(ctx, elementorLicenseKey, log);
      }
    }

    // ── 2. Plugin adicional ─────────────────────────────────────────────────────
    if (hasExtra) {
      log.info(`Instalando plugin adicional desde ZIP remoto...`);
      await installZip(ctx, extraZipRemotePath, 'Plugin adicional', log);
    }

    // ── 3. Lista negra (eliminar plugins conflictivos) ──────────────────────────
    await applyBlacklist(ctx, log, excludedBlacklistSlugs);

    log.success(`Plugins completados ✓`);
  } finally {
    // ── 4. Restaurar el candado si estaba activo originalmente ────────────────
    if (lockedConfigPath) {
      await restoreFileModsLock(ctx, lockedConfigPath, log);
    }
  }
}

module.exports = {
  runStep6,
  BLACKLIST_PLUGINS,
  BLACKLIST_SLUGS,
  liftFileModsLock,
  restoreFileModsLock,
  applyBlacklist,
  installZip,
  activateElementorLicense,
};
