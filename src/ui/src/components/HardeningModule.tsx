import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useToast } from './Toast';
import MeasurePicker from './hardening/MeasurePicker';
import LiveStatusPanel from './hardening/LiveStatusPanel';
import LiveConsole from './hardening/LiveConsole';
import ComplianceTable from './hardening/ComplianceTable';
import ConfirmarEjecucionReal from './hardening/ConfirmarEjecucionReal';
import type {
  BatchResult,
  ConsoleEntry,
  DomainResult,
  DomainRow,
  HardeningMeasure,
  HardeningProgress,
  MeasuresResponse,
  RowState,
} from '../types/hardening';

// Módulo de Blindaje (hardening de WordPress).
//
// El trabajo pesado corre entero en el proceso principal: `hardening:run-batch`
// es UN invoke que recién resuelve cuando terminó el lote completo. Por eso la
// pantalla no se construye con el valor de retorno sino con los eventos
// `hardening:progress` y `hardening:result`, que llegan mientras corre. Ese es
// el requisito central: ver qué está haciendo, no esperar quince minutos a que
// aparezca todo junto.

/** Tope del registro en vivo. Con cientos de dominios el DOM se va de las manos. */
const MAX_ENTRADAS_CONSOLA = 800;

/** Modo de corrida en curso. */
type RunMode = 'idle' | 'batch' | 'verify';

/** Puente IPC. `any` acotado a este punto: es el patrón que ya usa el proyecto. */
interface ApiBridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  receive: (channel: string, cb: (...args: unknown[]) => void) => (() => void) | void;
}

function getApi(): ApiBridge | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (window as any).api;
    return bridge ? (bridge as ApiBridge) : null;
  } catch {
    return null;
  }
}

// ── Guardas de tipo sobre las respuestas del IPC ──────────────────────────────

function esObjeto(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function comoMeasuresResponse(value: unknown): MeasuresResponse | null {
  if (!esObjeto(value) || !Array.isArray(value.measures)) return null;
  return {
    success: value.success === true,
    measures: value.measures as HardeningMeasure[],
    defaults: Array.isArray(value.defaults) ? (value.defaults as string[]) : [],
    loginSlug: typeof value.loginSlug === 'string' ? value.loginSlug : '',
  };
}

function comoDomainResult(value: unknown): DomainResult | null {
  if (!esObjeto(value) || typeof value.domain !== 'string') return null;
  return value as unknown as DomainResult;
}

function comoBatchResult(value: unknown): BatchResult {
  if (!esObjeto(value)) return { success: false, error: 'Respuesta inválida del proceso principal' };
  return value as unknown as BatchResult;
}

function comoProgress(value: unknown): HardeningProgress | null {
  if (!esObjeto(value) || typeof value.domain !== 'string') return null;
  const phase = value.phase;
  return {
    domain: value.domain,
    phase: phase === 'apply' || phase === 'verify' || phase === 'batch' ? phase : 'apply',
    measure: typeof value.measure === 'string' ? value.measure : '',
    status: typeof value.status === 'string' ? value.status : 'info',
    msg: typeof value.msg === 'string' ? value.msg : undefined,
    index: typeof value.index === 'number' ? value.index : undefined,
    total: typeof value.total === 'number' ? value.total : undefined,
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : Date.now(),
  };
}

// ── Componente ────────────────────────────────────────────────────────────────

interface HardeningModuleProps {
  onLog?: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string) => void;
}

export default function HardeningModule({ onLog }: HardeningModuleProps) {
  const { config } = useIpc();
  const toast = useToast();

  // ── Configuración de la corrida ──
  const [serverName, setServerName] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [measures, setMeasures] = useState<HardeningMeasure[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loginSlug, setLoginSlug] = useState('');
  const [dryRun, setDryRun] = useState(false); // por defecto ejecución real

  // ── Estado de la corrida ──
  const [mode, setMode] = useState<RunMode>('idle');
  const [aborting, setAborting] = useState(false);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [lastProgress, setLastProgress] = useState<HardeningProgress | null>(null);
  const [runIndex, setRunIndex] = useState<number | null>(null);
  const [runTotal, setRunTotal] = useState<number | null>(null);
  const [results, setResults] = useState<Record<string, DomainResult>>({});
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [runOrder, setRunOrder] = useState<string[]>([]);
  const [runMeasures, setRunMeasures] = useState<string[]>([]);
  const [averageScore, setAverageScore] = useState<number | null>(null);
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  /** Contador para dar una clave estable a cada línea de la consola. */
  const consoleSeqRef = useRef(0);
  /**
   * Bandera de aborto del bucle de verificación, que corre en el renderer.
   * Es un ref y no estado porque el bucle tiene que leer el valor vigente en
   * cada vuelta, no el capturado en el cierre cuando arrancó.
   */
  const abortVerifyRef = useRef(false);

  const cleanDomainInput = (raw: string): string => {
    let d = raw.trim();
    d = d.replace(/^https?:\/\//i, '');
    d = d.split('/')[0].split(':')[0];
    d = d.replace(/^[.\s]+|[.\s]+$/g, '');
    return d.toLowerCase();
  };

  const domains = useMemo(
    () =>
      domainInput
        .split('\n')
        .map(cleanDomainInput)
        .filter((d) => d.length > 0),
    [domainInput],
  );

  const pleskServers = useMemo(
    () => (config?.destinationServers ?? []).filter((s) => s.name !== 'Global'),
    [config],
  );

  const running = mode !== 'idle';

  // ── Catálogo de medidas ────────────────────────────────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api) return;
    let vigente = true;

    api
      .invoke('hardening:get-measures')
      .then((raw) => {
        if (!vigente) return;
        const parsed = comoMeasuresResponse(raw);
        if (!parsed) return;
        setMeasures(parsed.measures);
        setDefaults(parsed.defaults);
        setSelected(parsed.defaults);
        setLoginSlug(parsed.loginSlug);
      })
      .catch(() => {
        if (vigente) toast.error('No se pudo cargar el catálogo de medidas');
      });

    return () => {
      vigente = false;
    };
    // Solo al montar: el catálogo es estático dentro de una sesión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Suscripción a los eventos en vivo ──────────────────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api) return;

    const onProgress = (...args: unknown[]) => {
      const payload = comoProgress(args[0]);
      if (!payload) return;

      setLastProgress(payload);
      if (typeof payload.index === 'number') setRunIndex(payload.index);
      if (typeof payload.total === 'number') setRunTotal(payload.total);

      // El dominio que emite progreso es, por definición, el que está en curso.
      setRowStates((prev) => (prev[payload.domain] === 'pending' ? { ...prev, [payload.domain]: 'running' } : prev));

      consoleSeqRef.current += 1;
      const entry: ConsoleEntry = { ...payload, key: `p-${consoleSeqRef.current}` };
      setEntries((prev) => {
        const next = prev.length >= MAX_ENTRADAS_CONSOLA ? prev.slice(prev.length - MAX_ENTRADAS_CONSOLA + 1) : prev;
        return [...next, entry];
      });
    };

    const onResult = (...args: unknown[]) => {
      const payload = comoDomainResult(args[0]);
      if (!payload) return;

      setResults((prev) => ({ ...prev, [payload.domain]: payload }));
      setRowStates((prev) => ({ ...prev, [payload.domain]: payload.success ? 'done' : 'error' }));
      // Un dominio que llega por evento sin estar en la lista (por ejemplo, si
      // otra pantalla disparó un blindaje) igual se agrega a la tabla.
      setRunOrder((prev) => (prev.includes(payload.domain) ? prev : [...prev, payload.domain]));
    };

    const cleanupProgress = api.receive('hardening:progress', onProgress);
    const cleanupResult = api.receive('hardening:result', onResult);

    return () => {
      if (typeof cleanupProgress === 'function') cleanupProgress();
      if (typeof cleanupResult === 'function') cleanupResult();
    };
  }, []);

  // ── Selección de medidas ───────────────────────────────────────────────────
  const toggleMeasure = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const selectAll = useCallback(() => {
    setSelected(measures.map((m) => m.id));
  }, [measures]);

  const selectDefaults = useCallback(() => {
    setSelected(defaults);
  }, [defaults]);

  /** Prepara la tabla y el registro para una corrida nueva. */
  const prepararCorrida = useCallback(() => {
    setResults({});
    setRowStates(Object.fromEntries(domains.map((d) => [d, 'pending' as RowState])));
    setRunOrder(domains);
    setRunMeasures(selected);
    setAverageScore(null);
    setExpandedDomain(null);
    setLastProgress(null);
    setRunIndex(null);
    setRunTotal(domains.length);
    setAborting(false);
  }, [domains, selected]);

  // ── Blindar lote ───────────────────────────────────────────────────────────
  const ejecutarLote = useCallback(async () => {
    const api = getApi();
    if (!api) return;

    prepararCorrida();
    setMode('batch');

    try {
      const raw = await api.invoke('hardening:run-batch', {
        domains,
        serverName,
        measures: selected,
        dryRun,
      });
      const batch = comoBatchResult(raw);

      if (!batch.success) {
        toast.error(batch.error ?? 'El lote de blindaje falló');
        onLog?.(`[BLINDAJE] ${batch.error ?? 'El lote falló'}`, 'error', 'hardening');
      } else {
        setAverageScore(batch.averageScore ?? null);
        const resumen = `${batch.total ?? 0} dominios · ${batch.failed ?? 0} con error · promedio ${batch.averageScore ?? 0}%`;
        if (batch.aborted) {
          toast.info(`Lote detenido — ${resumen}`);
          onLog?.(`[BLINDAJE] Lote detenido — ${resumen}`, 'warning', 'hardening');
        } else {
          toast.success(`Lote terminado — ${resumen}`);
          onLog?.(`[BLINDAJE] Lote terminado — ${resumen}`, 'success', 'hardening');
        }
      }
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : 'Error desconocido';
      toast.error(`El lote de blindaje falló: ${mensaje}`);
      onLog?.(`[BLINDAJE] ${mensaje}`, 'error', 'hardening');
    } finally {
      setMode('idle');
      setAborting(false);
    }
  }, [domains, serverName, selected, dryRun, prepararCorrida, toast, onLog]);

  /** Punto de entrada del botón: en modo real exige confirmación de tipeo. */
  const handleBlindar = useCallback(() => {
    if (dryRun) {
      void ejecutarLote();
      return;
    }
    setConfirmOpen(true);
  }, [dryRun, ejecutarLote]);

  const confirmarYEjecutar = useCallback(() => {
    setConfirmOpen(false);
    void ejecutarLote();
  }, [ejecutarLote]);

  // ── Solo verificar ─────────────────────────────────────────────────────────
  //
  // No hay canal de verificación por lote: `hardening:verify-domain` trabaja
  // sobre UN dominio. El recorrido secuencial se hace acá, con su propia
  // bandera de parada, porque `hardening:abort` solo corta el lote del proceso
  // principal y no tiene efecto sobre este bucle.
  const ejecutarVerificacion = useCallback(async () => {
    const api = getApi();
    if (!api) return;

    prepararCorrida();
    abortVerifyRef.current = false;
    setMode('verify');

    const scores: number[] = [];

    try {
      for (let i = 0; i < domains.length; i++) {
        if (abortVerifyRef.current) break;

        const domain = domains[i];
        setRunIndex(i);
        setRowStates((prev) => ({ ...prev, [domain]: 'running' }));

        try {
          const raw = await api.invoke('hardening:verify-domain', {
            domain,
            serverName,
            measures: selected,
          });
          const resultado = comoDomainResult(raw);
          if (resultado) {
            setResults((prev) => ({ ...prev, [domain]: resultado }));
            setRowStates((prev) => ({ ...prev, [domain]: resultado.success ? 'done' : 'error' }));
            if (resultado.success && typeof resultado.score === 'number') scores.push(resultado.score);
          }
        } catch (error) {
          const mensaje = error instanceof Error ? error.message : 'Error desconocido';
          setResults((prev) => ({ ...prev, [domain]: { domain, success: false, error: mensaje } }));
          setRowStates((prev) => ({ ...prev, [domain]: 'error' }));
        }
      }

      const promedio = scores.length
        ? Math.round(scores.reduce((acc, s) => acc + s, 0) / scores.length)
        : 0;
      setAverageScore(promedio);

      if (abortVerifyRef.current) {
        toast.info(`Verificación detenida — promedio ${promedio}%`);
      } else {
        toast.success(`Verificación terminada — promedio ${promedio}%`);
      }
      onLog?.(`[BLINDAJE] Verificación terminada — promedio ${promedio}%`, 'info', 'hardening');
    } finally {
      setMode('idle');
      setAborting(false);
      abortVerifyRef.current = false;
    }
  }, [domains, serverName, selected, prepararCorrida, toast, onLog]);

  // ── Abortar ────────────────────────────────────────────────────────────────
  const handleAbortar = useCallback(async () => {
    setAborting(true);
    abortVerifyRef.current = true; // corta el bucle de verificación del renderer

    if (mode === 'batch') {
      const api = getApi();
      if (!api) return;
      try {
        await api.invoke('hardening:abort');
        toast.info('Parada solicitada — el lote se detiene al terminar el dominio actual');
      } catch {
        toast.error('No se pudo solicitar la parada del lote');
      }
    }
  }, [mode, toast]);

  const appendConsole = useCallback((msg: string, status: string = 'info', domain: string = '') => {
    consoleSeqRef.current += 1;
    const entry: ConsoleEntry = {
      key: `u-${consoleSeqRef.current}`,
      domain,
      phase: 'apply',
      measure: 'wpconfig',
      status,
      msg,
      timestamp: Date.now(),
    };
    setEntries((prev) => {
      const next = prev.length >= MAX_ENTRADAS_CONSOLA ? prev.slice(prev.length - MAX_ENTRADAS_CONSOLA + 1) : prev;
      return [...next, entry];
    });
  }, []);

  const handleUnlock = useCallback(async () => {
    const api = getApi();
    if (!api || !serverName || domains.length === 0) return;
    setUnlocking(true);
    try {
      for (const d of domains) {
        appendConsole(`Levantando candado de seguridad (DISALLOW_FILE_MODS) en ${d}...`, 'warn', d);
        const res = (await api.invoke('hardening:unlock', { domain: d, serverName })) as {
          success?: boolean;
          output?: string;
          error?: string;
        };
        if (res?.success) {
          appendConsole(`Candado levantado en ${d}: ${res.output || 'OK'}`, 'pass', d);
          toast.success(`Candado levantado en ${d}`);
        } else {
          appendConsole(`Fallo al levantar candado en ${d}: ${res?.error || res?.output || 'error desconocido'}`, 'fail', d);
          toast.error(`Fallo al levantar candado en ${d}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendConsole(`Error al levantar candado: ${msg}`, 'fail');
      toast.error(msg);
    } finally {
      setUnlocking(false);
    }
  }, [serverName, domains, appendConsole, toast]);

  const limpiarConsola = useCallback(() => setEntries([]), []);

  const toggleExpand = useCallback((domain: string) => {
    setExpandedDomain((prev) => (prev === domain ? null : domain));
  }, []);

  // ── Derivados de render ────────────────────────────────────────────────────

  const rows: DomainRow[] = useMemo(
    () =>
      runOrder.map((domain) => ({
        domain,
        state: rowStates[domain] ?? 'pending',
        result: results[domain] ?? null,
      })),
    [runOrder, rowStates, results],
  );

  /** Columnas de la tabla: las medidas de la corrida, en el orden del catálogo. */
  const columnas = useMemo(
    () => measures.filter((m) => runMeasures.includes(m.id)),
    [measures, runMeasures],
  );

  const destructivasElegidas = useMemo(
    () => measures.filter((m) => m.destructive && selected.includes(m.id)).map((m) => m.name),
    [measures, selected],
  );

  const puedeArrancar = domains.length > 0 && serverName !== '' && selected.length > 0 && !running;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* ── Encabezado ── */}
      <div className="flex-none border-b border-outline-variant/30 px-lg pb-md pt-lg">
        <h2 className="mb-xs font-display-lg text-display-lg text-secondary">Blindaje</h2>
        <p className="max-w-2xl font-body-md text-body-md text-on-surface-variant">
          Hardening de WordPress sobre servidores Plesk: aplica y verifica cada medida por separado
          y reporta el cumplimiento dominio por dominio.
          {loginSlug && (
            <>
              {' '}Slug de acceso de la flota:{' '}
              <code className="rounded bg-surface-container px-1 font-code-sm text-code-sm text-on-surface">
                /{loginSlug}
              </code>
              .
            </>
          )}
        </p>
      </div>

      <div className="mt-md flex-1 overflow-y-auto px-lg pb-lg">
        <div className="mx-auto max-w-7xl space-y-lg pb-24">
          {/* ── Configuración ── */}
          <section>
            <h3 className="mb-sm font-label-caps text-label-caps uppercase text-outline">Configuración</h3>
            <div className="space-y-md rounded border border-outline-variant bg-surface-container-low p-lg">
              <div className="grid grid-cols-1 gap-md md:grid-cols-3">
                <div className="space-y-xs">
                  <label
                    htmlFor="blindaje-servidor"
                    className="font-label-caps text-label-caps uppercase text-outline"
                  >
                    Servidor Plesk
                  </label>
                  <select
                    id="blindaje-servidor"
                    value={serverName}
                    disabled={running}
                    onChange={(e) => setServerName(e.target.value)}
                    className="w-full rounded border border-outline-variant bg-surface-container px-sm py-sm font-body-md text-body-md text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary disabled:opacity-50"
                  >
                    <option value="">Seleccionar servidor</option>
                    {pleskServers.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name} {s.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-xs md:col-span-2">
                  <label
                    htmlFor="blindaje-dominios"
                    className="flex items-center gap-xs font-label-caps text-label-caps uppercase text-outline"
                  >
                    Dominios
                    {domains.length > 0 && (
                      <span className="font-code-sm text-code-sm text-tertiary">
                        ({domains.length} dominio{domains.length !== 1 ? 's' : ''})
                      </span>
                    )}
                  </label>
                  <textarea
                    id="blindaje-dominios"
                    value={domainInput}
                    disabled={running}
                    onChange={(e) => setDomainInput(e.target.value)}
                    placeholder={'ejemplo.com\notro-dominio.net'}
                    rows={5}
                    className="min-h-[6rem] w-full resize-y rounded border border-outline-variant bg-surface-container px-sm py-sm font-code-md text-code-md text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="border-t border-outline-variant/30 pt-md">
                <MeasurePicker
                  measures={measures}
                  selected={selected}
                  disabled={running}
                  onToggle={toggleMeasure}
                  onSelectAll={selectAll}
                  onSelectDefaults={selectDefaults}
                />
                {selected.includes('reinstall') && (
                  <div className="mt-sm flex items-center justify-between rounded border border-secondary/30 bg-surface-container-high px-md py-xs">
                    <div className="flex items-center gap-sm">
                      <span className={`font-code-md ${config?.elementorPro?.zipPath ? 'text-secondary' : 'text-outline'}`}>
                        {config?.elementorPro?.zipPath ? '✓' : '–'}
                      </span>
                      <div>
                        <p className="font-label-sm text-on-surface">
                          Elementor Pro — Inyección automática en reinstalación
                        </p>
                        <p className="font-body-xs text-on-surface-variant">
                          {config?.elementorPro?.zipPath
                            ? `ZIP: ${config.elementorPro.zipPath.split(/[\\/]/).pop()} • Licencia: ${
                                config.elementorPro.licenseKey
                                  ? `${config.elementorPro.licenseKey.slice(0, 6)}••••••`
                                  : 'sin clave'
                              }`
                            : 'Sin ZIP configurado en Ajustes. Elementor Pro no se reinstalará si está instalado.'}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Modo de ejecución ── */}
              <div
                className={`rounded border p-md transition-colors ${
                  dryRun
                    ? 'border-green-400/40 bg-green-400/10'
                    : 'border-error/40 bg-error/10'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-md">
                  <div className="min-w-0">
                    <p
                      className={`font-title-sm ${dryRun ? 'text-green-400' : 'text-error'}`}
                    >
                      {dryRun ? 'Modo simulación activo' : 'Modo ejecución real activo'}
                    </p>
                    <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
                      {dryRun
                        ? 'Reporta el estado actual de cada dominio sin escribir absolutamente nada en el servidor.'
                        : 'Se escribirán cambios reales en wp-config.php, .htaccess y mu-plugins de cada dominio.'}
                    </p>
                  </div>

                  <div className="flex shrink-0 overflow-hidden rounded border border-outline-variant">
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => setDryRun(true)}
                      className={`px-md py-sm font-title-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        dryRun
                          ? 'bg-green-400/20 text-green-400'
                          : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                      }`}
                    >
                      Simulación
                    </button>
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => setDryRun(false)}
                      className={`border-l border-outline-variant px-md py-sm font-title-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        !dryRun
                          ? 'bg-error/20 text-error'
                          : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                      }`}
                    >
                      Ejecución real
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Acciones ── */}
              <div className="flex flex-wrap gap-md border-t border-outline-variant/30 pt-md">
                <button
                  type="button"
                  onClick={handleBlindar}
                  disabled={!puedeArrancar}
                  className={`flex items-center gap-xs rounded px-md py-sm font-title-sm transition-all active:scale-95 ${
                    puedeArrancar
                      ? 'bg-secondary-container text-on-secondary-container hover:brightness-110'
                      : 'cursor-not-allowed bg-surface-container-highest text-outline'
                  }`}
                >
                  {mode === 'batch' && (
                    <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-outline border-t-transparent" />
                  )}
                  {mode === 'batch'
                    ? 'Blindando lote...'
                    : dryRun
                      ? `Simular lote (${domains.length})`
                      : `Blindar lote (${domains.length})`}
                </button>

                <button
                  type="button"
                  onClick={() => void ejecutarVerificacion()}
                  disabled={!puedeArrancar}
                  className={`flex items-center gap-xs rounded border px-md py-sm font-title-sm transition-all active:scale-95 ${
                    puedeArrancar
                      ? 'border-outline-variant bg-surface-container text-on-surface hover:bg-surface-container-high'
                      : 'cursor-not-allowed border-outline-variant/50 bg-surface-container-highest text-outline'
                  }`}
                >
                  {mode === 'verify' && (
                    <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-outline border-t-transparent" />
                  )}
                  {mode === 'verify' ? 'Verificando...' : 'Solo verificar'}
                </button>

                <button
                  type="button"
                  onClick={() => void handleUnlock()}
                  disabled={!serverName || domains.length === 0 || running || unlocking}
                  className={`flex items-center gap-xs rounded border px-md py-sm font-title-sm transition-all active:scale-95 ${
                    serverName && domains.length > 0 && !running && !unlocking
                      ? 'border-tertiary/50 bg-tertiary/15 text-tertiary hover:bg-tertiary/25'
                      : 'cursor-not-allowed border-outline-variant/50 bg-surface-container-highest text-outline'
                  }`}
                  title="Quita temporalmente DISALLOW_FILE_MODS y DISALLOW_FILE_EDIT para poder subir plugins o editar temas"
                >
                  {unlocking ? 'Levantando...' : '🔓 Levantar candado (M2)'}
                </button>

                <button
                  type="button"
                  onClick={() => void handleAbortar()}
                  disabled={!running || aborting}
                  className={`rounded border px-md py-sm font-title-sm transition-all active:scale-95 ${
                    running && !aborting
                      ? 'border-error/50 bg-error/20 text-error hover:bg-error/30'
                      : 'cursor-not-allowed border-outline-variant/50 bg-surface-container-highest text-outline'
                  }`}
                >
                  {aborting ? 'Deteniendo...' : 'Abortar'}
                </button>
              </div>
            </div>
          </section>

          {/* ── Vista en vivo ── */}
          <section>
            <h3 className="mb-sm font-label-caps text-label-caps uppercase text-outline">En vivo</h3>
            <div className="space-y-md">
              <LiveStatusPanel
                running={running}
                last={lastProgress}
                index={runIndex}
                total={runTotal}
                measures={measures}
                dryRun={dryRun}
                aborting={aborting}
              />
              <div className="h-80 overflow-hidden">
                <LiveConsole entries={entries} onClear={limpiarConsola} />
              </div>
            </div>
          </section>

          {/* ── Cumplimiento ── */}
          {rows.length > 0 && (
            <section>
              <h3 className="mb-sm font-label-caps text-label-caps uppercase text-outline">
                Cumplimiento por dominio
              </h3>
              <ComplianceTable
                rows={rows}
                measures={columnas}
                expandedDomain={expandedDomain}
                onToggleExpand={toggleExpand}
                averageScore={averageScore}
              />
            </section>
          )}
        </div>
      </div>

      {confirmOpen && (
        <ConfirmarEjecucionReal
          domainCount={domains.length}
          serverName={serverName}
          destructiveNames={destructivasElegidas}
          onConfirm={confirmarYEjecutar}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
