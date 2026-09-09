import { useEffect, useRef, useState } from 'react';
import type { ConsoleEntry } from '../../types/hardening';

// Consola de progreso en vivo.
//
// Decisión: el registro crece HACIA ABAJO (lo más reciente al final) con
// auto-desplazamiento, igual que un `tail -f`. Es el orden que ya espera un
// sysadmin y evita que la línea que está leyendo salte de lugar.
// El auto-desplazamiento se suspende solo si el operador sube a mirar algo
// anterior, y se reanuda solo cuando vuelve al fondo.

/** Margen en píxeles para considerar que la vista está "pegada" al fondo. */
const UMBRAL_FONDO = 24;

/** Color del estado que reporta el backend. */
function colorDeEstado(status: string): string {
  switch (status) {
    case 'fail':
      return 'text-error';
    case 'ok':
    case 'pass':
      return 'text-green-400';
    case 'n/a':
    case 'skip':
      return 'text-outline';
    case 'running':
      return 'text-tertiary';
    default:
      return 'text-on-surface-variant';
  }
}

/** Etiqueta corta de la fase, de ancho fijo para que las columnas se alineen. */
function etiquetaDeFase(phase: string): string {
  switch (phase) {
    case 'apply':
      return 'APLICA';
    case 'verify':
      return 'VERIF.';
    case 'batch':
      return 'LOTE  ';
    default:
      return 'INFO  ';
  }
}

function formatearHora(timestamp: number | undefined): string {
  const fecha = timestamp ? new Date(timestamp) : new Date();
  const hh = String(fecha.getHours()).padStart(2, '0');
  const mm = String(fecha.getMinutes()).padStart(2, '0');
  const ss = String(fecha.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

interface LiveConsoleProps {
  entries: ConsoleEntry[];
  onClear: () => void;
}

export default function LiveConsole({ entries, onClear }: LiveConsoleProps) {
  const contenedorRef = useRef<HTMLDivElement | null>(null);
  const [pegadoAlFondo, setPegadoAlFondo] = useState(true);

  // Auto-desplazamiento: solo mientras la vista siga pegada al fondo.
  useEffect(() => {
    if (!pegadoAlFondo) return;
    const nodo = contenedorRef.current;
    if (!nodo) return;
    nodo.scrollTop = nodo.scrollHeight;
  }, [entries, pegadoAlFondo]);

  const handleScroll = () => {
    const nodo = contenedorRef.current;
    if (!nodo) return;
    const distanciaAlFondo = nodo.scrollHeight - nodo.scrollTop - nodo.clientHeight;
    setPegadoAlFondo(distanciaAlFondo <= UMBRAL_FONDO);
  };

  const irAlFondo = () => {
    const nodo = contenedorRef.current;
    if (!nodo) return;
    nodo.scrollTop = nodo.scrollHeight;
    setPegadoAlFondo(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-outline-variant bg-surface-container-lowest">
      <div className="flex shrink-0 items-center justify-between border-b border-outline-variant/50 px-md py-sm">
        <span className="font-label-caps text-label-caps uppercase text-outline">
          Registro en vivo
          <span className="ml-sm text-on-surface-variant">{entries.length}</span>
        </span>
        <div className="flex items-center gap-sm">
          {!pegadoAlFondo && (
            <button
              type="button"
              onClick={irAlFondo}
              className="rounded border border-tertiary/50 px-sm py-0.5 font-label-caps text-label-caps uppercase text-tertiary transition-colors hover:bg-tertiary/10"
            >
              Ir al final
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            disabled={entries.length === 0}
            className="rounded border border-outline-variant px-sm py-0.5 font-label-caps text-label-caps uppercase text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
          >
            Limpiar
          </button>
        </div>
      </div>

      <div
        ref={contenedorRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-md py-sm"
      >
        {entries.length === 0 ? (
          <p className="py-lg text-center font-body-sm text-body-sm text-outline">
            Sin actividad. El avance de cada medida aparece aquí mientras corre.
          </p>
        ) : (
          <ul className="space-y-0">
            {entries.map((entry) => (
              <li key={entry.key} className="flex gap-sm py-0.5 font-code-sm text-code-sm">
                <span className="shrink-0 text-outline">{formatearHora(entry.timestamp)}</span>
                <span className="shrink-0 whitespace-pre text-outline">{etiquetaDeFase(entry.phase)}</span>
                <span className="w-40 shrink-0 truncate text-on-surface-variant" title={entry.domain}>
                  {entry.domain}
                </span>
                <span className={`min-w-0 flex-1 break-words ${colorDeEstado(entry.status)}`}>
                  {entry.msg || entry.measure}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
