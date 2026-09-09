'use strict';

/**
 * @file cmsReconstructor.js
 * @description Motor de reconstrucción WP por dominio (Arquitectura Modular).
 */

const { TIMEOUTS } = require('./constants');
const { validateInputs } = require('./utils/validate');
const { assertNotAborted } = require('./utils/abort');
const { StepError } = require('./utils/errors');

const { runStep0 }  = require('./steps/step0-php');
const { runStep1 }  = require('./steps/step1-env');
const { runStep2 }  = require('./steps/step2-shuffle');
const { runStep3 }  = require('./steps/step3-scorched');
const { runStep4 }  = require('./steps/step4-reinstall');
const { runStep5 }  = require('./steps/step5-update');
const { runStep6 }  = require('./steps/step6-plugin');
const { runStep7 }  = require('./steps/step7-perms');
const { runStep8 }  = require('./steps/step8-secure');
const { runStep9 }  = require('./steps/step9-config');
const { runStep10 } = require('./steps/step10-hardening');

/**
 * Ejecuta un comando SSH. Lanza Error si falla y allowFail !== true.
 * CRLF normalizado.
 */
async function baseRun(ssh, client, cmd, opts = {}) {
  const normalizedCmd = cmd.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const timeout = opts.timeout || TIMEOUTS.DEFAULT;

  const result = await ssh.executeCommand(client, normalizedCmd, { timeout });
  if (!opts.allowFail) {
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `exit code ${result.code ?? 'null'}`).slice(0, 400);
      throw new Error(detail);
    }
  }
  return result;
}

/**
 * Reconstruye WordPress en un dominio específico.
 *
 * @param {object}   params
 * @param {object}   params.ssh                    - SshService instancia
 * @param {object}   params.client                 - Conexión SSH ya abierta
 * @param {string}   params.domain                 - Dominio a reconstruir
 * @param {string}   params.webRoot                - Ruta absoluta de httpdocs
 * @param {string}   params.sysUser                - Usuario Unix de la suscripción (sin truncar)
 * @param {string}   params.wpVersion              - Versión WP a instalar (e.g. '6.7.2')
 * @param {string}   params.targetPhpVersion       - Versión PHP destino ('Mantener actual' o '8.2', etc.)
 * @param {string}   [params.elementorZipRemotePath] - Ruta remota del ZIP de Elementor Pro
 * @param {string}   [params.elementorLicenseKey]  - Clave de licencia Elementor Pro
 * @param {string}   [params.extraZipRemotePath]   - Ruta remota de un ZIP adicional
 * @param {'full'|'core-only'|'security-only'|'solo-plugin'} params.mode
 * @param {boolean}  params.dryRun                 - Si true, solo verifica sin modificar
 * @param {Function} params.onStep                 - callback(stepNum, total, msg, level)
 * @param {AbortSignal} [params.signal]            - Para abort
 */
async function reconstructDomain({
  ssh, client,
  domain, webRoot, sysUser,
  wpVersion = '6.7.2',
  targetPhpVersion = 'Mantener actual',
  elementorZipRemotePath = null,
  elementorLicenseKey    = null,
  extraZipRemotePath     = null,
  excludedBlacklistSlugs = [],
  mode = 'full',
  dryRun = false,
  onStep = () => {},
  signal,
}) {
  const steps = [];
  const TOTAL = mode === 'security-only' ? 2 : mode === 'core-only' ? 4 : mode === 'solo-plugin' ? 3 : 10;

  function emit(num, msg, level = 'info') {
    console.log(`[Reconstructor|${domain}] Step ${num}/${TOTAL}: ${msg}`);
    steps.push({ step: num, msg });
    onStep(num, TOTAL, msg, level);
  }

  // Wrapper para inyectar configuración por defecto
  const runWrapper = (cmd, opts = {}) => baseRun(ssh, client, cmd, opts);

  // Contexto inyectado en cada paso
  const ctx = {
    ssh,
    client,
    run: runWrapper,
    domain,
    sysUser,
    webRoot,
    dryRun,
    signal,
    emit,
    totalSteps: TOTAL,
    instanceId: null // Se llenará en runStep4
  };

  validateInputs({ domain, webRoot, sysUser });

  try {
    await runStep0(ctx, targetPhpVersion);
    assertNotAborted(ctx.signal);

    await runStep1(ctx);
    assertNotAborted(ctx.signal);

    if (dryRun) {
      emit(2, '[DRY RUN] Verificación completada — sin modificaciones.', 'info');
      return { success: true, steps, dryRun: true };
    }

    if (mode === 'security-only') {
      await runStep2(ctx);
      return { success: true, steps };
    }

    if (mode === 'solo-plugin') {
      await runStep6(ctx, { elementorZipRemotePath, elementorLicenseKey, extraZipRemotePath, excludedBlacklistSlugs });
      return { success: true, steps };
    }

    await runStep2(ctx);
    assertNotAborted(ctx.signal);

    await runStep3(ctx);
    assertNotAborted(ctx.signal);

    await runStep4(ctx, wpVersion);
    assertNotAborted(ctx.signal);

    if (mode === 'core-only') {
      return { success: true, steps };
    }

    await runStep5(ctx);
    assertNotAborted(ctx.signal);

    await runStep6(ctx, { elementorZipRemotePath, elementorLicenseKey, extraZipRemotePath, excludedBlacklistSlugs });
    assertNotAborted(ctx.signal);

    await runStep7(ctx);
    assertNotAborted(ctx.signal);

    await runStep8(ctx);
    assertNotAborted(ctx.signal);

    await runStep9(ctx);
    assertNotAborted(ctx.signal);

    await runStep10(ctx);

    return { success: true, steps };

  } catch (err) {
    if (err instanceof StepError) {
      emit(err.stepNum, `[FAILED] Step ${err.stepNum}: ${err.message}`, 'error');
    } else {
      emit('ERR', `Error fatal en reconstrucción: ${err.message}`, 'error');
    }
    return { success: false, error: err.message, steps };
  }
}

module.exports = {
  reconstructDomain,
};
