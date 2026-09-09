import type { HardeningMeasure, HardeningProgress } from '../../types/hardening';

// Panel "qué está haciendo ahora mismo".
//
// Responde tres preguntas en un vistazo, que es el requisito del operador:
//   1. qué dominio se está procesando y en qué posición del lote
//   2. qué medida se está tocando en este instante
//   3. cuál fue el último mensaje que mandó el servidor

interface LiveStatusPanelProps {
  running: boolean;
  /** Último evento de progreso recibido. */
  last: HardeningProgress | null;
  /** Índice 0-based del dominio en curso dentro del lote. */
  index: number | null;
  total: number | null;
  /** Catálogo, para traducir el id de la medida a su nombre legible. */
  measures: HardeningMeasure[];
  dryRun: boolean;
  aborting: boolean;
}

const FASE_LABEL: Record<string, string> = {
  apply: 'Aplicando',
  verify: 'Verificando',
  batch: 'Preparando dominio',
};

export default function LiveStatusPanel({
  running,
  last,
  index,
  total,
  measures,
  dryRun,
  aborting,
}: LiveStatusPanelProps) {
  const nombreMedida = (() => {
    if (!last) return '—';
    if (last.measure === 'entorno') return 'Detección del entorno';
    if (last.measure === 'lote') return 'Apertura del dominio';
    const meta = measures.find((m) => m.id === last.measure);
    return meta ? meta.name : last.measure;
  })();

  const posicion =
    index !== null && total !== null && total > 0 ? `${index + 1}/${total}` : null;

  const porcentaje =
    !running && total !== null && total > 0
      ? 100
      : index !== null && total !== null && total > 0
        ? Math.min(100, Math.round(((index + (last?.phase === 'verify' ? 1 : 0.5)) / total) * 100))
        : 0;

  return (
    <div className="rounded border border-outline-variant bg-surface-container-low p-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <span className="flex items-center gap-sm font-label-caps text-label-caps uppercase text-outline">
          Actividad
          {running && !aborting && (
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-tertiary" />
          )}
        </span>
        <span className="flex items-center gap-sm">
          {dryRun && (
            <span className="rounded border border-green-400/40 bg-green-400/15 px-sm py-0.5 font-label-caps text-label-caps uppercase text-green-400">
              Simulación
            </span>
          )}
          {aborting && (
            <span className="rounded border border-error/40 bg-error/15 px-sm py-0.5 font-label-caps text-label-caps uppercase text-error">
              Deteniendo al terminar el dominio
            </span>
          )}
        </span>
      </div>

      {!running && !last ? (
        <p className="mt-sm font-body-sm text-body-sm text-outline">
          En reposo. Seleccione servidor, dominios y medidas para comenzar.
        </p>
      ) : (
        <>
          <div className="mt-sm grid grid-cols-1 gap-sm md:grid-cols-3">
            <div className="min-w-0">
              <span className="block font-label-caps text-label-caps uppercase text-outline">
                Dominio
              </span>
              <span
                className="block truncate font-code-md text-code-md text-on-surface"
                title={last?.domain ?? ''}
              >
                {last?.domain || '—'}
                {posicion && <span className="ml-sm text-tertiary">({posicion})</span>}
              </span>
            </div>

            <div className="min-w-0">
              <span className="block font-label-caps text-label-caps uppercase text-outline">
                {last ? (FASE_LABEL[last.phase] ?? 'Procesando') : 'Fase'}
              </span>
              <span className="block truncate font-body-md text-body-md text-on-surface" title={nombreMedida}>
                {nombreMedida}
              </span>
            </div>

            <div className="min-w-0">
              <span className="block font-label-caps text-label-caps uppercase text-outline">
                Último mensaje
              </span>
              <span
                className="block truncate font-code-sm text-code-sm text-on-surface-variant"
                title={last?.msg ?? ''}
              >
                {last?.msg || '—'}
              </span>
            </div>
          </div>

          {total !== null && total > 1 && (
            <div className="mt-md">
              <div className="mb-xs flex justify-between font-label-caps text-label-caps uppercase text-outline">
                <span>Avance del lote</span>
                <span className="font-code-sm text-code-sm text-on-surface-variant">{porcentaje}%</span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-surface-container-highest">
                <div
                  className="h-full rounded-full bg-tertiary transition-all duration-300 ease-out"
                  style={{ width: `${porcentaje}%` }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
