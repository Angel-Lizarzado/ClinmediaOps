import type { HardeningMeasure } from '../../types/hardening';

// Selector de medidas. El catálogo llega de `hardening:get-measures`, así que
// una medida nueva en el backend aparece acá sin tocar la UI.

interface MeasurePickerProps {
  measures: HardeningMeasure[];
  selected: string[];
  disabled: boolean;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectDefaults: () => void;
}

export default function MeasurePicker({
  measures,
  selected,
  disabled,
  onToggle,
  onSelectAll,
  onSelectDefaults,
}: MeasurePickerProps) {
  return (
    <div className="space-y-sm">
      <div className="flex items-center justify-between">
        <label className="font-label-caps text-label-caps uppercase text-outline">
          Medidas a aplicar
          <span className="ml-sm text-tertiary">
            {selected.length} de {measures.length}
          </span>
        </label>
        <div className="flex gap-sm">
          <button
            type="button"
            onClick={onSelectDefaults}
            disabled={disabled}
            className="rounded border border-outline-variant px-sm py-0.5 font-label-caps text-label-caps uppercase text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
          >
            Por defecto
          </button>
          <button
            type="button"
            onClick={onSelectAll}
            disabled={disabled}
            className="rounded border border-outline-variant px-sm py-0.5 font-label-caps text-label-caps uppercase text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
          >
            Todas
          </button>
        </div>
      </div>

      {measures.length === 0 ? (
        <p className="font-body-sm text-body-sm text-outline">Cargando catálogo de medidas...</p>
      ) : (
        <div className="grid grid-cols-1 gap-xs md:grid-cols-2">
          {measures.map((m) => {
            const marcada = selected.includes(m.id);
            return (
              <label
                key={m.id}
                className={`flex cursor-pointer items-start gap-sm rounded border px-sm py-sm transition-colors ${
                  marcada
                    ? 'border-secondary/40 bg-secondary-container/10'
                    : 'border-outline-variant bg-surface-container'
                } ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-container-high'}`}
              >
                <input
                  type="checkbox"
                  checked={marcada}
                  disabled={disabled}
                  onChange={() => onToggle(m.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-outline-variant bg-surface-container-lowest text-secondary focus:ring-1 focus:ring-secondary"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-xs">
                    <span className="font-body-md text-body-md text-on-surface">{m.name}</span>
                    {m.guide !== null && (
                      <span className="rounded bg-surface-container-highest px-1 font-code-sm text-code-sm text-outline">
                        guía {m.guide}
                      </span>
                    )}
                    {m.destructive && (
                      <span
                        title="Borra archivos del servidor. Revise el resultado en simulación antes de ejecutarla de verdad."
                        className="rounded border border-error/40 bg-error/15 px-1 font-label-caps text-label-caps uppercase text-error"
                      >
                        Destructiva
                      </span>
                    )}
                    {m.needsApache && (
                      <span
                        title="Depende de .htaccess. En un dominio servido solo por nginx se reporta como no aplica."
                        className="rounded border border-outline-variant px-1 font-label-caps text-label-caps uppercase text-outline"
                      >
                        Requiere Apache
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block font-body-sm text-body-sm text-on-surface-variant">
                    {m.short}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
