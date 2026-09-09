'use strict';

/**
 * Paso 10 — Blindaje y limpieza final del pipeline de SourceSync.
 *
 * Este paso tenía su propio script de hardening, distinto del que usaba el
 * módulo de Validación: uno protegía wp-config.php pero no bloqueaba
 * wp-comments-post.php, el otro al revés. Dos fuentes de verdad para lo mismo.
 *
 * Ahora delega en el servicio de blindaje, que es la única fuente de verdad.
 */

const { createStepLogger } = require('../utils/logger');
const { applyHardening } = require('../../hardening/hardeningService');
const { TIMEOUTS } = require('../constants');

/**
 * Medidas que aplica el pipeline al terminar un despliegue.
 *
 * `sanitize` queda fuera a propósito: acabamos de desplegar el sitio nosotros,
 * así que no hay nada que purgar, y borrar archivos justo después de subirlos
 * es un riesgo innecesario.
 */
const MEDIDAS_PIPELINE = ['files', 'xmlrpc', 'restapi', 'login', 'optimize', 'wpconfig'];

async function runStep10(ctx) {
  const log = createStepLogger(ctx.emit, 10, ctx.totalSteps);
  log.info('Aplicando blindaje, memoria y limpieza final...');

  // cmsReconstructor inyecta el cliente SSH como ctx.client
  const sshClient = ctx.client;

  if (!sshClient) {
    // Sin cliente SSH directo no se puede usar el servicio de blindaje, que
    // necesita streaming. Se avisa en vez de fallar en silencio.
    log.warn('SKIP — no hay cliente SSH disponible para el blindaje');
    return;
  }

  try {
    const resultado = await applyHardening(sshClient, ctx.domain, {
      measures: MEDIDAS_PIPELINE,
      dryRun: !!ctx.dryRun,
      onProgress: (payload) => {
        if (payload.msg) log.detail(payload.msg);
      },
    });

    if (resultado.environment?.webserver === 'nginx-solo') {
      log.warn('El dominio lo sirve nginx directo: las reglas .htaccess NO se aplican');
    }

    const aplicadas = (resultado.measures || []).filter((m) => m.applied).length;
    const total = (resultado.measures || []).length;
    log.success(`Blindaje aplicado (${aplicadas}/${total} medidas) ✓`);
  } catch (err) {
    // Igual que antes: un fallo del blindaje no tumba el despliegue completo.
    log.warn(`Fallo en el blindaje final: ${err.message}`);
  }

  // Purga de caché de WP Toolkit — específica del pipeline, no del blindaje.
  if (ctx.instanceId) {
    try {
      await ctx.run(
        `plesk ext wp-toolkit --clear-cache -instance-id ${ctx.instanceId} || true\n` +
        `plesk ext wp-toolkit --clear-wpt-cache || true`,
        { allowFail: true, timeout: TIMEOUTS.MEDIUM }
      );
      log.detail('Caché de WP Toolkit purgada ✓');
    } catch (err) {
      log.warn(`No se pudo purgar la caché de WP Toolkit: ${err.message}`);
    }
  }

  log.success('Blindaje y limpieza completados ✓');
}

module.exports = { runStep10, MEDIDAS_PIPELINE };
