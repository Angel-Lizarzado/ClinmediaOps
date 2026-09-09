import type { VerifyStatus } from '../../types/hardening';

// Semáforo de una celda de la tabla de cumplimiento.
//
// Regla de diseño: `n/a` NO puede leerse como aprobado. Significa "no aplica
// en este dominio" — típicamente reglas de .htaccess en un dominio servido
// solo por nginx. Se distingue de `pass` y de `fail` por TRES señales a la
// vez, no solo por color:
//   - glifo distinto (✓ / ✕ / — / ?)
//   - relleno distinto (sólido para los veredictos, vacío para los no-veredictos)
//   - contorno distinto (sin borde / discontinuo / punteado)
// Así sigue siendo legible en escala de grises y para daltonismo rojo-verde.

interface StatusStyle {
  /** Glifo del centro de la celda. */
  glyph: string;
  /** Etiqueta corta para la leyenda. */
  label: string;
  /** Texto largo para el `title` nativo. */
  hint: string;
  className: string;
}

const STATUS_STYLE: Record<VerifyStatus, StatusStyle> = {
  pass: {
    glyph: '✓',
    label: 'Cumple',
    hint: 'Cumple — la medida está aplicada y comprobada',
    className: 'bg-green-400/20 text-green-400 border border-green-400/40',
  },
  fail: {
    glyph: '✕',
    label: 'No cumple',
    hint: 'No cumple — la medida no está aplicada',
    className: 'bg-error/20 text-error border border-error/40',
  },
  'n/a': {
    glyph: '—',
    label: 'No aplica',
    hint: 'No aplica en este dominio (por ejemplo, .htaccess en un servidor solo nginx). No cuenta como cumplida.',
    className: 'bg-transparent text-outline border border-dashed border-outline',
  },
  unknown: {
    glyph: '?',
    label: 'Sin dato',
    hint: 'Sin dato — no se pudo comprobar la medida',
    className: 'bg-transparent text-outline/60 border border-dotted border-outline/50',
  },
};

/** Estilo de un veredicto. Exportado para reutilizarlo en la leyenda. */
export function estiloDeEstado(status: VerifyStatus): StatusStyle {
  return STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
}

/** Normaliza un valor arbitrario del backend a un VerifyStatus conocido. */
export function normalizarEstado(value: string | undefined): VerifyStatus {
  if (value === 'pass' || value === 'fail' || value === 'n/a') return value;
  return 'unknown';
}

interface StatusCellProps {
  status: VerifyStatus;
  /** Nombre de la medida, para componer el texto del `title`. */
  measureName?: string;
}

export default function StatusCell({ status, measureName }: StatusCellProps) {
  const style = estiloDeEstado(status);
  const title = measureName ? `${measureName}: ${style.hint}` : style.hint;

  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-flex h-5 w-7 items-center justify-center rounded font-code-sm text-code-sm leading-none ${style.className}`}
    >
      {style.glyph}
    </span>
  );
}

/** Leyenda de los cuatro veredictos. Va sobre la tabla. */
export function LeyendaEstados() {
  const orden: VerifyStatus[] = ['pass', 'fail', 'n/a', 'unknown'];
  return (
    <div className="flex flex-wrap items-center gap-md">
      {orden.map((status) => {
        const style = estiloDeEstado(status);
        return (
          <span key={status} className="flex items-center gap-xs">
            <StatusCell status={status} />
            <span className="font-body-sm text-body-sm text-on-surface-variant">{style.label}</span>
          </span>
        );
      })}
    </div>
  );
}
