'use strict';

/**
 * @file cmsOrchestrator.js
 * @description Orquestador de batch para CMS Reconstructor.
 *
 * Responsabilidades:
 *  - PHP Switcher: detecta handlers disponibles y aplica la versión más alta
 *  - Asset Manager: sube el ZIP de Elementor via SCP, lo borra al terminar
 *  - Loop resiliente: procesa dominios uno a uno (try/catch por dominio)
 *  - Kill switch: AbortController — aborta el loop entre dominios
 *  - Progreso: callback onProgress(event) → UI accordion
 */

const path = require('path');
const { reconstructDomain } = require('./cmsReconstructor');
const { getSshService } = require('../ssh-service');
const { getConfigManager } = require('../config-manager');

async function run(ssh, client, cmd, opts = {}) {
  const result = await ssh.executeCommand(client, cmd, { timeout: opts.timeout || 300000 });
  if (!opts.allowFail && result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `exit code ${result.code}`).slice(0, 400));
  }
  return result;
}

/**
 * Obtiene el docroot y sysUser de un dominio via Plesk.
 * - webRoot: via `plesk bin site --info`
 * - sysUser: via `stat -c "%U"` sobre el httpdocs real — NUNCA trunca el nombre
 */
async function getDomainInfo(ssh, client, domain) {
  // 1. Obtener webRoot desde Plesk (más confiable que asumir /var/www/vhosts/...)
  const docResult = await run(ssh, client,
    `plesk bin site --info ${domain} 2>/dev/null | grep -E "Document root" | head -1`,
    { allowFail: true }
  );
  const out = docResult.stdout || '';
  const webRootMatch = out.match(/Document root\s*:\s*(.+)/i);
  const webRoot = webRootMatch
    ? webRootMatch[1].trim()
    : `/var/www/vhosts/${domain}/httpdocs`;

  // 2. Obtener sysUser via stat — ÚNICA fuente confiable del nombre sin truncar.
  //    ls -l y algunos comandos de Plesk truncan usernames > 8 chars en ciertas distros.
  const statResult = await run(ssh, client,
    `stat -c "%U" ${webRoot} 2>/dev/null || stat -c "%U" /var/www/vhosts/${domain}/httpdocs 2>/dev/null || echo "STAT_FAILED"`,
    { allowFail: true }
  );
  const statOut = (statResult.stdout || '').trim();

  let sysUser;
  if (statOut && statOut !== 'STAT_FAILED' && statOut !== 'root') {
    sysUser = statOut;
  } else {
    // Fallback: Plesk DB — más lento pero exacto
    const dbResult = await run(ssh, client,
      `plesk db -sNe "SELECT cl.login FROM domains d JOIN clients cl ON cl.id=d.cl_id WHERE d.name='${domain}' LIMIT 1" 2>/dev/null`,
      { allowFail: true }
    );
    const dbUser = (dbResult.stdout || '').trim();
    // Sin .slice() — el nombre completo siempre
    sysUser = dbUser || domain.split('.')[0];
  }

  return { webRoot, sysUser };
}

/**
 * Sube un ZIP al servidor via SCP.
 * @param {object} ssh - SshService
 * @param {object} sshCredentials
 * @param {string} localZipPath - ruta local Windows
 * @param {string} remoteDir    - directorio destino en el servidor
 * @returns {Promise<string>}   - ruta remota del ZIP
 */
async function uploadZip(ssh, sshCredentials, localZipPath, remoteDir = '/tmp/kraken-workspace') {
  const fileName    = path.basename(localZipPath);
  const remotePath  = `${remoteDir}/${fileName}`;

  let client = null;
  try {
    client = await ssh.connect(sshCredentials, `cms-scp-${Date.now()}`);
    await ssh.executeCommand(client, `mkdir -p ${remoteDir}`, { timeout: 10000 });
    await ssh.uploadFileFast(client, localZipPath, remotePath, (transferred, total, pct, msg) => {
      console.log(`[CMS:SCP] ${msg} (${pct}%)`);
    });
    return remotePath;
  } finally {
    if (client) {
      try { await ssh.disconnect(client); } catch (_) {}
    }
  }
}

/**
 * Elimina el ZIP del servidor.
 */
async function cleanupRemoteZip(ssh, client, remotePath) {
  if (!remotePath) return;
  await ssh.executeCommand(client, `rm -f ${remotePath} 2>/dev/null`, { timeout: 10000 });
}

// ─── Orquestador principal ────────────────────────────────────────────────────

/**
 * @typedef {Object} CmsProgress
 * @property {'domain-start'|'domain-step'|'domain-done'|'domain-error'|'batch-done'|'upload-start'|'upload-done'|'php-switch'} type
 * @property {string}  [domain]
 * @property {number}  [index]      - 0-based
 * @property {number}  [total]
 * @property {string}  [msg]
 * @property {string}  [level]      - 'info'|'success'|'warn'|'error'
 * @property {boolean} [success]
 * @property {string}  [error]
 * @property {number}  [duration]   - ms
 */

/**
 * Ejecuta el batch de reconstrucción CMS.
 *
 * @param {object}   params
 * @param {string[]} params.domains            - lista de dominios a procesar
 * @param {string}   params.serverName         - nombre del servidor destino
 * @param {object}   params.sshCredentials     - { host, port, username }
 * @param {string}   [params.localZipPath]     - ruta local del ZIP adicional (opcional)
 * @param {string}   params.targetPhpVersion   - versión PHP destino o 'Mantener actual'
 * @param {'full'|'core-only'|'security-only'|'solo-plugin'} params.mode
 * @param {boolean}  params.dryRun
 * @param {boolean}  params.phpSwitch          - si debe cambiar versión PHP
 * @param {Function} params.onProgress         - callback(CmsProgress)
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{processed:number, succeeded:number, failed:number, history:Array}>}
 */
async function runCmsBatch({
  domains,
  serverName,
  sshCredentials,
  localZipPath,      // ZIP adicional (manual, desde el UI)
  targetPhpVersion = 'Mantener actual',
  mode = 'full',
  dryRun = false,
  phpSwitch = true,
  excludedBlacklistSlugs = [],
  onProgress = () => {},
  signal,
}) {
  const ssh = getSshService();
  const history = [];
  let succeeded = 0;
  let failed = 0;
  let remoteElementorZip = null;  // Elementor Pro (desde config)
  let remoteExtraZip     = null;  // ZIP adicional (desde UI)
  let elementorLicenseKey = null;

  const total = domains.length;

  // ── Leer config de Elementor Pro (automático desde configuración global) ────
  const needsPlugins = (mode === 'full' || mode === 'solo-plugin') && !dryRun;
  if (needsPlugins) {
    try {
      const cfgMgr = getConfigManager();
      const cfg    = cfgMgr.getConfig();
      const epZip  = cfg?.elementorPro?.zipPath  || null;
      const epKey  = cfg?.elementorPro?.licenseKey || null;

      if (epZip) {
        console.log(`[CMS Batch] Subiendo Elementor Pro desde config: ${epZip}`);
        onProgress({ type: 'upload-start', msg: `Subiendo Elementor Pro al servidor "${serverName}"...` });
        remoteElementorZip  = await uploadZip(ssh, sshCredentials, epZip);
        elementorLicenseKey = epKey || null;
        onProgress({ type: 'upload-done', msg: `Elementor Pro → ${remoteElementorZip}`, level: 'success' });
      }
    } catch (epErr) {
      console.warn(`[CMS Batch] No se pudo subir Elementor Pro:`, epErr.message);
      onProgress({ type: 'domain-step', msg: `Advertencia: Elementor Pro no disponible — ${epErr.message}`, level: 'warn' });
    }

    // ── ZIP adicional (manual desde UI) ──────────────────────────────────────
    if (localZipPath) {
      console.log(`[CMS Batch] Subiendo ZIP adicional: ${localZipPath}`);
      onProgress({ type: 'upload-start', msg: `Subiendo plugin adicional al servidor "${serverName}"...` });
      try {
        remoteExtraZip = await uploadZip(ssh, sshCredentials, localZipPath);
        onProgress({ type: 'upload-done', msg: `Plugin adicional → ${remoteExtraZip}`, level: 'success' });
      } catch (err) {
        console.error(`[CMS Batch] Error subiendo ZIP adicional:`, err);
        onProgress({ type: 'domain-step', msg: `Error subiendo ZIP adicional: ${err.message}`, level: 'warn' });
        // No abortar el batch
      }
    }
  }

  // ── Loop principal por dominio ─────────────────────────────────────────────
  let index = 0;
  for (const rawDomain of domains) {
    if (signal?.aborted) break;

    const domain = rawDomain.trim();
    if (!domain) {
      index++;
      continue;
    }

    const start = Date.now();
    const i = index;
    index++;

    console.log(`\n[CMS Batch] ======= INICIANDO DOMINIO: ${domain} (${i+1}/${total}) =======`);
    console.log(`[CMS Batch] Modo: ${mode} | DryRun: ${dryRun}`);
    
    onProgress({ type: 'domain-start', domain, index: i, total, msg: `[${i + 1}/${total}] Iniciando ${domain}...` });

    let client = null;
    try {
      client = await ssh.connect(sshCredentials, `cms-domain-${domain}-${Date.now()}`);
      console.log(`[CMS Batch|${domain}] Conexión SSH establecida.`);

      // Info del dominio (docroot + sysUser)
      const { webRoot, sysUser } = await getDomainInfo(ssh, client, domain);
      console.log(`[CMS Batch|${domain}] Info dominio -> docroot: ${webRoot}, sysUser: ${sysUser}`);

      // Reconstrucción
      console.log(`[CMS Batch|${domain}] Llamando reconstructDomain...`);
      const result = await reconstructDomain({
        ssh, client,
        domain, webRoot, sysUser,
        wpVersion: '6.7.2',
        targetPhpVersion,
        elementorZipRemotePath: remoteElementorZip,
        elementorLicenseKey,
        extraZipRemotePath: remoteExtraZip,
        excludedBlacklistSlugs,
        mode, dryRun,
        signal,
        onStep: (stepNum, stepTotal, msg, level) => {
          onProgress({ type: 'domain-step', domain, index: i, total, msg: `  ${msg}`, level });
        },
      });

      const duration = Date.now() - start;

      if (result.success) {
        succeeded++;
        console.log(`[CMS Batch|${domain}] ✅ Reconstrucción completada exitosamente en ${duration}ms.`);
        history.push({ domain, status: 'success', duration, dryRun: result.dryRun });
        onProgress({
          type: 'domain-done', domain, index: i, total,
          msg: `[${i + 1}/${total}] ✓ ${domain} — ${dryRun ? 'Dry Run OK' : 'Reconstruido'} (${Math.round(duration / 1000)}s)`,
          success: true, duration,
        });
      } else {
        failed++;
        console.warn(`[CMS Batch|${domain}] ⚠️ Reconstrucción finalizó con errores controlados: ${result.error}`);
        history.push({ domain, status: 'error', error: result.error, duration });
        onProgress({
          type: 'domain-error', domain, index: i, total,
          msg: `[${i + 1}/${total}] ✗ ${domain} — ${result.error}`,
          level: 'error', success: false, duration,
        });
      }

    } catch (err) {
      const duration = Date.now() - start;
      failed++;
      console.error(`[CMS Batch|${domain}] ❌ ERROR FATAL en la reconstrucción:`, err);
      history.push({ domain, status: 'error', error: err.message, duration });
      // Fix 3: siempre emitir con causa raíz completa para que la UI la muestre
      onProgress({
        type: 'domain-error', domain, index: i, total,
        msg: `[${i + 1}/${total}] ✗ ${domain} — [FATAL] ${err.message}`,
        level: 'error', success: false, duration,
      });
    } finally {
      if (client) { try { await ssh.disconnect(client); console.log(`[CMS Batch|${domain}] Conexión SSH cerrada.`); } catch (_) {} }
    }
  }

  // ── Limpieza de ZIPs remotos ───────────────────────────────────────────────
  const zipsToClear = [remoteElementorZip, remoteExtraZip].filter(Boolean);
  if (zipsToClear.length > 0 && !dryRun) {
    let client = null;
    try {
      client = await ssh.connect(sshCredentials, `cms-cleanup-${Date.now()}`);
      for (const zipPath of zipsToClear) {
        await cleanupRemoteZip(ssh, client, zipPath);
      }
      onProgress({ type: 'upload-done', msg: `ZIPs temporales eliminados del servidor ✓`, level: 'info' });
    } catch (_) { /* no crítico */ } finally {
      if (client) { try { await ssh.disconnect(client); } catch (_) {} }
    }
  }

  const processed = succeeded + failed;
  console.log(`\n[CMS Batch] ==========================================`);
  console.log(`[CMS Batch] BATCH FINALIZADO: ${succeeded} OK | ${failed} Fallidos | ${processed} Total procesados.`);
  console.log(`[CMS Batch] ==========================================\n`);
  onProgress({
    type: 'batch-done',
    msg: `Batch finalizado: ${succeeded} exitosos, ${failed} fallidos de ${processed} dominios procesados.`,
    level: failed === 0 ? 'success' : 'warn',
  });

  return { processed, succeeded, failed, history };
}

module.exports = { runCmsBatch };
