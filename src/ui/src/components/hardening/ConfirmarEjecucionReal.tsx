import { useState } from 'react';

// Confirmación de tipeo antes de una corrida REAL sobre producción.
//
// No se reutiliza `dashboard/ConfirmDialog` porque ese componente está atado a
// un caso concreto (apagado de un servidor): su copia, su palabra clave
// "APAGAR" y su prop `serverName` son fijas. Este pide una palabra distinta y
// muestra el recuento de dominios y las medidas destructivas involucradas.

const PALABRA_CLAVE = 'BLINDAR';

interface ConfirmarEjecucionRealProps {
  domainCount: number;
  serverName: string;
  /** Nombres de las medidas destructivas seleccionadas, si hay alguna. */
  destructiveNames: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmarEjecucionReal({
  domainCount,
  serverName,
  destructiveNames,
  onConfirm,
  onCancel,
}: ConfirmarEjecucionRealProps) {
  const [texto, setTexto] = useState('');
  const habilitado = texto.trim().toUpperCase() === PALABRA_CLAVE;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmar-blindaje-titulo"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-md"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-outline bg-surface-container shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-outline-variant px-lg py-md">
          <h3 id="confirmar-blindaje-titulo" className="font-headline-md text-title-sm font-bold text-on-surface">
            Confirmar ejecución real
          </h3>
        </div>

        <div className="space-y-md p-lg">
          <p className="font-body-md text-body-md text-on-surface-variant">
            El modo simulación está desactivado. Se van a escribir cambios en{' '}
            <strong className="text-on-surface">{domainCount}</strong> dominio
            {domainCount !== 1 ? 's' : ''} del servidor{' '}
            <strong className="text-on-surface">{serverName}</strong>.
          </p>

          {destructiveNames.length > 0 && (
            <div className="rounded border border-error/30 bg-error/10 p-md">
              <p className="mb-xs font-label-caps text-label-caps uppercase text-error">
                Medidas destructivas seleccionadas
              </p>
              <ul className="space-y-0.5">
                {destructiveNames.map((n) => (
                  <li key={n} className="font-body-sm text-body-sm text-on-surface-variant">
                    {n} — borra archivos del servidor
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-xs">
            <label
              htmlFor="confirmar-blindaje-input"
              className="block font-body-sm text-body-sm text-on-surface-variant"
            >
              Escriba{' '}
              <code className="rounded bg-black/30 px-1 font-code-sm text-code-sm text-on-surface">
                {PALABRA_CLAVE}
              </code>{' '}
              para continuar.
            </label>
            <input
              id="confirmar-blindaje-input"
              type="text"
              autoFocus
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder={PALABRA_CLAVE}
              className="w-full rounded border border-outline-variant bg-background px-md py-sm text-center font-code-md text-code-md text-on-surface transition-all focus:border-tertiary focus:ring-1 focus:ring-tertiary"
            />
          </div>
        </div>

        <div className="flex justify-end gap-sm border-t border-outline-variant px-lg py-md">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-outline-variant bg-surface-container px-md py-sm font-title-sm text-on-surface transition-all hover:bg-surface-container-high active:scale-95"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!habilitado}
            className="rounded bg-error px-md py-sm font-title-sm text-on-error transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Blindar de verdad
          </button>
        </div>
      </div>
    </div>
  );
}
