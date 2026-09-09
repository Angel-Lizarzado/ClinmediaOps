// Tests de la lógica pura del servicio de Blindaje: parseo de marcadores,
// normalización de medidas y resumen de la verificación.
//
// Es la parte que decide qué se le muestra al operador. Un marcador malformado
// que tumbe la corrida, o un resumen que cuente las n/a como incumplimiento,
// convierten un reporte de cumplimiento en ruido.

// El servicio abre SSH al cargarse; acá no se ejercita esa ruta.
jest.mock('../../ssh-service', () => ({
  getSshService: () => ({
    executeCommand: jest.fn(),
    executeStreamCommand: jest.fn(),
  }),
}));

const {
  parseMarkers,
  normalizeMeasures,
  summarize,
  DEFAULT_MEASURES,
  MEASURE_IDS,
  VERIFY_STATUS,
} = require('../hardeningService');

// ── parseMarkers ──────────────────────────────────────────────────────────────

describe('parseMarkers', () => {
  test('extrae un marcador bien formado', () => {
    const chunk = '@@@MEASURE@@@{"measure":"files","applied":true,"detail":"listo"}@@@END@@@\n';

    expect(parseMarkers(chunk, 'MEASURE')).toEqual([
      { measure: 'files', applied: true, detail: 'listo' },
    ]);
  });

  test('extrae varios marcadores del mismo chunk', () => {
    const chunk = [
      '@@@CHECK@@@{"measure":"files","id":"indexes","status":"pass","detail":"ok"}@@@END@@@',
      '@@@CHECK@@@{"measure":"xmlrpc","id":"xmlrpc_http","status":"fail","detail":"200"}@@@END@@@',
    ].join('\n');

    const marcadores = parseMarkers(chunk, 'CHECK');

    expect(marcadores).toHaveLength(2);
    expect(marcadores[0].id).toBe('indexes');
    expect(marcadores[1].status).toBe('fail');
  });

  test('ignora la salida suelta que rodea a los marcadores', () => {
    const chunk = [
      '[BLINDAJE] arrancando',
      'warning: algo irrelevante',
      '@@@ENV@@@{"webserver":"apache","wpFound":true}@@@END@@@',
      '[BLINDAJE OK] Terminado',
    ].join('\n');

    expect(parseMarkers(chunk, 'ENV')).toEqual([{ webserver: 'apache', wpFound: true }]);
  });

  test('un marcador malformado no tumba la corrida y no frena a los siguientes', () => {
    // Una línea cortada por el buffer del stream no debe hacer explotar el
    // parseo: el resto de la salida tiene que seguir procesándose.
    const chunk = [
      '@@@MEASURE@@@{esto no es json}@@@END@@@',
      '@@@MEASURE@@@{"measure":"login","applied":true,"detail":"ok"}@@@END@@@',
      '@@@MEASURE@@@{"measure":"roto"@@@END@@@',
    ].join('\n');

    let marcadores;
    expect(() => {
      marcadores = parseMarkers(chunk, 'MEASURE');
    }).not.toThrow();

    expect(marcadores).toEqual([{ measure: 'login', applied: true, detail: 'ok' }]);
  });

  test('un chunk sin marcadores devuelve lista vacía', () => {
    expect(parseMarkers('[BLINDAJE OK] Terminado para ejemplo.test\n', 'MEASURE')).toEqual([]);
    expect(parseMarkers('', 'CHECK')).toEqual([]);
  });

  test('no mezcla tipos de marcador', () => {
    const chunk = [
      '@@@PROGRESS@@@{"measure":"files","status":"running","msg":"trabajando"}@@@END@@@',
      '@@@MEASURE@@@{"measure":"files","applied":true,"detail":"listo"}@@@END@@@',
    ].join('\n');

    expect(parseMarkers(chunk, 'PROGRESS')).toHaveLength(1);
    expect(parseMarkers(chunk, 'PROGRESS')[0].status).toBe('running');
    expect(parseMarkers(chunk, 'MEASURE')).toHaveLength(1);
    expect(parseMarkers(chunk, 'MEASURE')[0].applied).toBe(true);
  });

  test('un marcador sin cierre se ignora', () => {
    const chunk = '@@@MEASURE@@@{"measure":"files","applied":true}';
    expect(parseMarkers(chunk, 'MEASURE')).toEqual([]);
  });
});

// ── normalizeMeasures ─────────────────────────────────────────────────────────

describe('normalizeMeasures', () => {
  test('una lista vacía cae en las medidas por defecto', () => {
    expect(normalizeMeasures([])).toEqual(DEFAULT_MEASURES);
  });

  test('lo que no es un array cae en las medidas por defecto', () => {
    expect(normalizeMeasures(undefined)).toEqual(DEFAULT_MEASURES);
    expect(normalizeMeasures(null)).toEqual(DEFAULT_MEASURES);
    expect(normalizeMeasures('wpconfig')).toEqual(DEFAULT_MEASURES);
  });

  test('devuelve una copia: mutarla no altera el default del módulo', () => {
    const normalizadas = normalizeMeasures([]);
    normalizadas.push('inventada');

    expect(normalizeMeasures([])).toEqual(DEFAULT_MEASURES);
    expect(DEFAULT_MEASURES).not.toContain('inventada');
  });

  test('filtra los ids inválidos y conserva los válidos', () => {
    expect(normalizeMeasures(['wpconfig', 'inexistente', 'login'])).toEqual(['wpconfig', 'login']);
    expect(normalizeMeasures(['files', '', null, 'restapi'])).toEqual(['files', 'restapi']);
  });

  test('si TODOS los ids son inválidos cae en las medidas por defecto', () => {
    // Mejor blindar con el set por defecto que no blindar nada por un typo.
    expect(normalizeMeasures(['inexistente', 'otra-cosa'])).toEqual(DEFAULT_MEASURES);
  });

  test('respeta el orden en que se pidieron las medidas válidas', () => {
    expect(normalizeMeasures(['login', 'wpconfig'])).toEqual(['login', 'wpconfig']);
    expect(normalizeMeasures(['wpconfig', 'login'])).toEqual(['wpconfig', 'login']);
  });

  test('acepta todas las medidas declaradas por el módulo', () => {
    expect(normalizeMeasures([...MEASURE_IDS])).toEqual([...MEASURE_IDS]);
  });
});

// ── summarize ─────────────────────────────────────────────────────────────────

/** Atajo para armar comprobaciones. */
const check = (measure, id, status) => ({ measure, id, status, detail: `${id}: ${status}` });

const ENTORNO = { measure: 'entorno', id: 'webserver', status: 'pass', detail: 'servidor web: apache' };

describe('summarize', () => {
  test('una medida con TODAS sus comprobaciones en pass queda en pass', () => {
    const resumen = summarize('ejemplo.test', ['wpconfig'], [
      ENTORNO,
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
      check('wpconfig', 'disallow_file_mods', VERIFY_STATUS.PASS),
    ]);

    expect(resumen.measures.wpconfig.status).toBe(VERIFY_STATUS.PASS);
    expect(resumen.score).toBe(100);
    expect(resumen.passed).toBe(1);
    expect(resumen.evaluated).toBe(1);
  });

  test('una sola comprobación en fail arrastra la medida entera a fail', () => {
    // No hay medias tintas: una constante que falta deja la medida incumplida.
    const resumen = summarize('ejemplo.test', ['wpconfig'], [
      ENTORNO,
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
      check('wpconfig', 'disallow_file_mods', VERIFY_STATUS.FAIL),
    ]);

    expect(resumen.measures.wpconfig.status).toBe(VERIFY_STATUS.FAIL);
    expect(resumen.score).toBe(0);
    expect(resumen.passed).toBe(0);
  });

  test('un fail pesa más que un n/a en la misma medida', () => {
    const resumen = summarize('ejemplo.test', ['files'], [
      check('files', 'indexes', VERIFY_STATUS.NOT_APPLICABLE),
      check('files', 'uploads_php', VERIFY_STATUS.FAIL),
    ]);

    expect(resumen.measures.files.status).toBe(VERIFY_STATUS.FAIL);
  });

  test('una medida con TODAS sus comprobaciones en n/a queda en n/a', () => {
    const resumen = summarize('ejemplo.test', ['files'], [
      check('files', 'wp_config_http', VERIFY_STATUS.NOT_APPLICABLE),
      check('files', 'uploads_php', VERIFY_STATUS.NOT_APPLICABLE),
      check('files', 'indexes', VERIFY_STATUS.NOT_APPLICABLE),
    ]);

    expect(resumen.measures.files.status).toBe(VERIFY_STATUS.NOT_APPLICABLE);
    expect(resumen.notApplicable).toBe(1);
  });

  test('las medidas n/a salen del denominador del score', () => {
    // No se puede exigir .htaccess en un dominio servido por nginx, pero
    // tampoco se puede reportar como cumplido: sale de la cuenta.
    const resumen = summarize('ejemplo.test', ['wpconfig', 'files', 'restapi'], [
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
      check('files', 'uploads_php', VERIFY_STATUS.NOT_APPLICABLE),
      check('restapi', 'mu_file', VERIFY_STATUS.PASS),
    ]);

    expect(resumen.evaluated).toBe(2);
    expect(resumen.passed).toBe(2);
    expect(resumen.notApplicable).toBe(1);
    expect(resumen.score).toBe(100);
  });

  test('con todas las medidas en n/a el score es 0 y no divide por cero', () => {
    const resumen = summarize('ejemplo.test', ['files', 'xmlrpc'], [
      check('files', 'uploads_php', VERIFY_STATUS.NOT_APPLICABLE),
      check('xmlrpc', 'xmlrpc_http', VERIFY_STATUS.NOT_APPLICABLE),
    ]);

    expect(resumen.evaluated).toBe(0);
    expect(resumen.score).toBe(0);
    expect(resumen.notApplicable).toBe(2);
  });

  test('una medida sin comprobaciones queda en unknown y baja el score', () => {
    // Que el script no haya reportado nada no es lo mismo que cumplir.
    const resumen = summarize('ejemplo.test', ['wpconfig', 'login'], [
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
    ]);

    expect(resumen.measures.login.status).toBe(VERIFY_STATUS.UNKNOWN);
    expect(resumen.measures.login.checks).toEqual([]);
    expect(resumen.evaluated).toBe(2);
    expect(resumen.passed).toBe(1);
    expect(resumen.score).toBe(50);
  });

  test('el score se redondea al entero más cercano', () => {
    const resumen = summarize('ejemplo.test', ['wpconfig', 'files', 'restapi'], [
      check('wpconfig', 'a', VERIFY_STATUS.PASS),
      check('files', 'b', VERIFY_STATUS.FAIL),
      check('restapi', 'c', VERIFY_STATUS.FAIL),
    ]);

    expect(resumen.score).toBe(33);
  });

  test('cada medida solo mira sus propias comprobaciones', () => {
    const resumen = summarize('ejemplo.test', ['wpconfig', 'files'], [
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
      check('files', 'uploads_php', VERIFY_STATUS.FAIL),
    ]);

    expect(resumen.measures.wpconfig.status).toBe(VERIFY_STATUS.PASS);
    expect(resumen.measures.wpconfig.checks).toHaveLength(1);
    expect(resumen.measures.files.status).toBe(VERIFY_STATUS.FAIL);
    expect(resumen.measures.files.checks).toHaveLength(1);
  });

  test('la medida trae el nombre legible declarado en MEASURES', () => {
    const resumen = summarize('ejemplo.test', ['wpconfig'], [
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
    ]);

    expect(resumen.measures.wpconfig.name).toBe('Bloqueo de edición e instalación');
  });

  test('el servidor web sale del check de entorno', () => {
    const resumen = summarize('ejemplo.test', ['wpconfig'], [
      { measure: 'entorno', id: 'webserver', status: 'pass', detail: 'servidor web: nginx-solo' },
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
    ]);

    expect(resumen.webserver).toBe('nginx-solo');
  });

  test('sin check de entorno el servidor web queda como desconocido', () => {
    const resumen = summarize('ejemplo.test', ['wpconfig'], [
      check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS),
    ]);

    expect(resumen.webserver).toBe('desconocido');
  });

  test('el dominio y las comprobaciones crudas viajan en el resumen', () => {
    const checks = [ENTORNO, check('wpconfig', 'disallow_file_edit', VERIFY_STATUS.PASS)];
    const resumen = summarize('ejemplo.test', ['wpconfig'], checks);

    expect(resumen.domain).toBe('ejemplo.test');
    expect(resumen.checks).toEqual(checks);
  });

  test('sin medidas ni comprobaciones no explota', () => {
    const resumen = summarize('ejemplo.test', [], []);

    expect(resumen.measures).toEqual({});
    expect(resumen.score).toBe(0);
    expect(resumen.evaluated).toBe(0);
  });
});
