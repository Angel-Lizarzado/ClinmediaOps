'use strict';

/**
 * Servicio de Blindaje — orquesta la aplicación y la verificación del
 * hardening de WordPress sobre dominios de Plesk.
 *
 * Es la ÚNICA fuente de verdad del hardening. Antes había dos scripts
 * divergentes (audit-service.generateHardenScript y sourcesync/step10) que
 * aplicaban cosas distintas; ambos pasan a consumir este módulo.
 */

const fs = require('fs');
const { getSshService } = require('../ssh-service');
const { buildApplyScript, buildUnlockScript } = require('./applyScript');
const { buildVerifyScript } = require('./verifyScript');
const {
  MEASURES,
  MEASURE_IDS,
  DEFAULT_MEASURES,
  VERIFY_STATUS,
  HARDENING_TIMEOUTS,
  LOGIN_SLUG,
} = require('./constants');

// ── Parseo de marcadores ──────────────────────────────────────────────────────

/**
 * Extrae los marcadores `@@@TIPO@@@{json}@@@END@@@` de un chunk de salida.
 * El script remoto los emite mientras corre, así la UI ve el avance en vivo
 * en vez de esperar a que termine todo.
 */
function parseMarkers(chunk, tipo) {
  const salida = [];
  const regex = new RegExp(`@@@${tipo}@@@(.*?)@@@END@@@`, 'g');
  let match;
  while ((match = regex.exec(chunk)) !== null) {
    try {
      salida.push(JSON.parse(match[1]));
    } catch (_) {
      // Un marcador malformado no debe tumbar la corrida
    }
  }
  return salida;
}

/** Valida y normaliza la lista de medidas pedidas. */
function normalizeMeasures(measures) {
  if (!Array.isArray(measures) || measures.length === 0) return [...DEFAULT_MEASURES];
  const validas = measures.filter((m) => MEASURE_IDS.includes(m));
  return validas.length > 0 ? validas : [...DEFAULT_MEASURES];
}

// ── Aplicación ────────────────────────────────────────────────────────────────

/**
 * Aplica el blindaje sobre un dominio.
 *
 * @param {object} sshClient          Cliente SSH ya conectado
 * @param {string} domain             Dominio (ASCII/punycode)
 * @param {object} [opts]
 * @param {string[]} [opts.measures]  Medidas a aplicar
 * @param {boolean} [opts.dryRun]     Reporta sin escribir nada
 * @param {Function} [opts.onProgress] (payload) por cada avance
 * @returns {Promise<object>} resultado con las medidas aplicadas
 */
async function applyHardening(sshClient, domain, opts = {}) {
  const { dryRun = false, onProgress, elementorPro = null } = opts;
  const measures = normalizeMeasures(opts.measures);
  const sshService = getSshService();

  // Si se pidió reinstall y hay ZIP de Elementor Pro configurado, asegurar que esté en el servidor
  if (!dryRun && measures.includes('reinstall') && elementorPro?.zipPath && fs.existsSync(elementorPro.zipPath)) {
    try {
      const checkRes = await sshService.executeCommand(sshClient, '[ -f "/tmp/kraken-elementor-pro.zip" ] && echo "EXISTS" || echo "MISSING"');
      if (!checkRes.stdout?.includes('EXISTS')) {
        if (typeof onProgress === 'function') {
          onProgress({ domain, phase: 'apply', measure: 'reinstall', status: 'running', msg: 'Subiendo ZIP de Elementor Pro al servidor...' });
        }
        await sshService.uploadFileFast(sshClient, elementorPro.zipPath, '/tmp/kraken-elementor-pro.zip');
        await sshService.executeCommand(sshClient, 'chmod 644 /tmp/kraken-elementor-pro.zip 2>/dev/null || true');
      }
    } catch (epUploadErr) {
      if (typeof onProgress === 'function') {
        onProgress({ domain, phase: 'apply', measure: 'reinstall', status: 'warn', msg: `No se pudo subir Elementor Pro ZIP: ${epUploadErr.message}` });
      }
    }
  }

  const script = buildApplyScript({ domain, measures, dryRun, elementorPro });

  const aplicadas = [];
  let entorno = null;

  const onChunk = (chunk) => {
    for (const p of parseMarkers(chunk, 'PROGRESS')) {
      if (typeof onProgress === 'function') {
        onProgress({ domain, phase: 'apply', ...p });
      }
    }
    for (const m of parseMarkers(chunk, 'MEASURE')) {
      aplicadas.push(m);
      if (typeof onProgress === 'function') {
        onProgress({
          domain,
          phase: 'apply',
          measure: m.measure,
          status: m.applied ? 'ok' : 'skip',
          msg: m.detail,
        });
      }
    }
    for (const e of parseMarkers(chunk, 'ENV')) {
      entorno = e;
        const detalle = e.wpFound === false
          ? `${e.error || 'WordPress no encontrado'} (${e.webroot || 'desconocido'})`
          : (e.webroot ? `Servidor web: ${e.webserver} (${e.webroot})` : `Servidor web: ${e.webserver}`);
        onProgress({ domain, phase: 'apply', measure: 'entorno', status: e.wpFound === false ? 'fail' : 'info', msg: detalle });
    }
  };

  const resultado = await sshService.executeStreamCommand(sshClient, script, onChunk);

  if (entorno && entorno.wpFound === false) {
    return {
      domain,
      success: false,
      dryRun,
      error: entorno.error ? (entorno.webroot ? `${entorno.error} en ${entorno.webroot}` : entorno.error) : 'No se encontró WordPress en el dominio',
      environment: entorno,
      measures: [],
    };
  }

  return {
    domain,
    success: (resultado?.code ?? 0) === 0,
    dryRun,
    environment: entorno,
    measures: aplicadas,
    requested: measures,
  };
}

// ── Verificación ──────────────────────────────────────────────────────────────

/**
 * Verifica el blindaje de un dominio y devuelve un resultado por medida.
 *
 * Es de solo lectura salvo por una sonda: para probar de verdad que no se
 * ejecuta PHP en uploads hay que dejar un archivo, pedirlo por HTTP y
 * borrarlo. Que el .htaccess exista no prueba que Apache lo esté leyendo.
 */
async function verifyHardening(sshClient, domain, opts = {}) {
  const { onProgress } = opts;
  const measures = normalizeMeasures(opts.measures);
  const sshService = getSshService();

  const script = buildVerifyScript({ domain, measures });

  const checks = [];
  const onChunk = (chunk) => {
    for (const c of parseMarkers(chunk, 'CHECK')) {
      checks.push(c);
      if (typeof onProgress === 'function') {
        onProgress({ domain, phase: 'verify', measure: c.measure, status: c.status, msg: c.detail });
      }
    }
  };

  await sshService.executeStreamCommand(sshClient, script, onChunk);

  return summarize(domain, measures, checks);
}

/**
 * Resume las comprobaciones individuales en un veredicto por medida y un
 * porcentaje de cumplimiento del dominio.
 *
 * Regla: una medida está `pass` solo si TODAS sus comprobaciones pasan.
 * Las `n/a` no cuentan ni a favor ni en contra — no se puede exigir
 * .htaccess en un dominio servido por nginx, pero tampoco se puede reportar
 * como cumplido.
 */
function summarize(domain, measures, checks) {
  const porMedida = {};

  for (const id of measures) {
    const propias = checks.filter((c) => c.measure === id);
    const meta = MEASURES.find((m) => m.id === id);

    if (propias.length === 0) {
      porMedida[id] = { id, name: meta?.name || id, status: VERIFY_STATUS.UNKNOWN, checks: [] };
      continue;
    }

    const fallos = propias.filter((c) => c.status === VERIFY_STATUS.FAIL);
    const na = propias.filter((c) => c.status === VERIFY_STATUS.NOT_APPLICABLE);
    const desconocidos = propias.filter((c) => c.status === VERIFY_STATUS.UNKNOWN);

    let status;
    if (fallos.length > 0) {
      status = VERIFY_STATUS.FAIL;
    } else if (na.length === propias.length) {
      status = VERIFY_STATUS.NOT_APPLICABLE;
    } else if (desconocidos.length > 0) {
      // Un check que no se pudo ejecutar NO es un check aprobado. Sin esto,
      // un wp-cli caído se leía como cumplimiento en el informe.
      status = VERIFY_STATUS.UNKNOWN;
    } else {
      status = VERIFY_STATUS.PASS;
    }

    porMedida[id] = { id, name: meta?.name || id, status, checks: propias };
  }

  const entorno = checks.find((c) => c.measure === 'entorno' && c.id === 'webserver');

  // El porcentaje solo mira las medidas que aplican a este dominio
  const evaluables = Object.values(porMedida).filter((m) => m.status !== VERIFY_STATUS.NOT_APPLICABLE);
  const pasadas = evaluables.filter((m) => m.status === VERIFY_STATUS.PASS).length;
  const score = evaluables.length > 0 ? Math.round((pasadas / evaluables.length) * 100) : 0;

  return {
    domain,
    webserver: entorno ? entorno.detail.replace('servidor web: ', '') : 'desconocido',
    score,
    passed: pasadas,
    evaluated: evaluables.length,
    notApplicable: Object.values(porMedida).filter((m) => m.status === VERIFY_STATUS.NOT_APPLICABLE).length,
    measures: porMedida,
    checks,
  };
}

// ── Aplicar y verificar en una pasada ─────────────────────────────────────────

/**
 * Flujo completo sobre un dominio: aplica y a continuación verifica.
 * En dry-run solo verifica el estado actual, sin tocar nada.
 */
async function hardenAndVerify(sshClient, domain, opts = {}) {
  const { dryRun = false } = opts;

  const aplicacion = await applyHardening(sshClient, domain, opts);

  if (!aplicacion.success && aplicacion.error) {
    return { domain, success: false, error: aplicacion.error, apply: aplicacion, verify: null };
  }

  // En dry-run la verificación refleja el estado ACTUAL, que es justamente lo
  // que se quiere ver antes de disparar sobre cientos de dominios.
  const verificacion = await verifyHardening(sshClient, domain, opts);

  return {
    domain,
    success: true,
    dryRun,
    apply: aplicacion,
    verify: verificacion,
    score: verificacion.score,
  };
}

// ── Levantar el candado ───────────────────────────────────────────────────────

/**
 * Quita DISALLOW_FILE_MODS para que se puedan volver a instalar plugins.
 * Lo usa el CMS Reconstructor antes de trabajar sobre un dominio blindado.
 * Después hay que volver a correr el blindaje.
 */
async function unlockFileMods(sshClient, domain) {
  const sshService = getSshService();
  const result = await sshService.executeCommand(sshClient, buildUnlockScript(domain), {
    timeoutMs: HARDENING_TIMEOUTS.DETECT,
  });
  return {
    domain,
    success: result.code === 0,
    output: (result.stdout || '').trim(),
  };
}

module.exports = {
  applyHardening,
  verifyHardening,
  hardenAndVerify,
  unlockFileMods,
  summarize,
  normalizeMeasures,
  parseMarkers,
  MEASURES,
  MEASURE_IDS,
  DEFAULT_MEASURES,
  VERIFY_STATUS,
  LOGIN_SLUG,
};
