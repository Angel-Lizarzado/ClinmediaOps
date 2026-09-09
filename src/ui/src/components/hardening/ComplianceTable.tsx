import { Fragment } from 'react';
import type {
  DomainRow,
  HardeningMeasure,
  MeasureVerdict,
  VerifyCheck,
  VerifyStatus,
} from '../../types/hardening';
import StatusCell, { LeyendaEstados, estiloDeEstado, normalizarEstado } from './StatusCell';

// Tabla de cumplimiento: una fila por dominio, una columna por medida.
// Al hacer clic en una fila se despliega el detalle de las comprobaciones
// individuales con el texto que devolvió el servidor.

/** Color del porcentaje de cumplimiento. Verde solo con el 100%. */
function colorDeScore(score: number): string {
  if (score >= 100) return 'text-green-400';
  if (score >= 60) return 'text-tertiary';
  return 'text-error';
}

/** Veredicto de una medida sobre una fila, tolerando filas sin verificación. */
function veredictoDeMedida(row: DomainRow, measureId: string): VerifyStatus {
  const verdicts = row.result?.verify?.measures;
  if (!verdicts) return 'unknown';
  const verdict: MeasureVerdict | undefined = verdicts[measureId];
  if (!verdict) return 'unknown';
  return normalizarEstado(verdict.status);
}

/** Agrupa las comprobaciones por medida, respetando el orden de las columnas. */
function agruparChecks(
  checks: VerifyCheck[],
  measures: HardeningMeasure[],
): Array<{ id: string; name: string; checks: VerifyCheck[] }> {
  const grupos: Array<{ id: string; name: string; checks: VerifyCheck[] }> = [];

  for (const m of measures) {
    const propias = checks.filter((c) => c.measure === m.id);
    if (propias.length > 0) grupos.push({ id: m.id, name: m.name, checks: propias });
  }

  // Comprobaciones que no pertenecen a ninguna medida del catálogo — por
  // ejemplo las de `entorno`. Se muestran igual en vez de descartarse.
  const idsConocidos = new Set(measures.map((m) => m.id));
  const sueltas = checks.filter((c) => !idsConocidos.has(c.measure));
  if (sueltas.length > 0) {
    grupos.push({ id: '__otras__', name: 'Entorno y otras comprobaciones', checks: sueltas });
  }

  return grupos;
}

interface ComplianceTableProps {
  rows: DomainRow[];
  /** Columnas: solo las medidas efectivamente pedidas en esta corrida. */
  measures: HardeningMeasure[];
  expandedDomain: string | null;
  onToggleExpand: (domain: string) => void;
  averageScore: number | null;
}

export default function ComplianceTable({
  rows,
  measures,
  expandedDomain,
  onToggleExpand,
  averageScore,
}: ComplianceTableProps) {
  if (rows.length === 0) return null;

  const evaluadas = rows.filter((r) => r.state === 'done' && r.result?.verify);
  const conFallos = rows.filter((r) => r.state === 'error').length;
  const alCien = evaluadas.filter((r) => (r.result?.score ?? 0) >= 100).length;

  return (
    <div className="space-y-sm rounded border border-outline-variant bg-surface-container-low p-md">
      <LeyendaEstados />

      <div className="overflow-x-auto rounded border border-outline-variant bg-surface-container-lowest">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-container">
            <tr className="border-b border-outline-variant">
              <th className="px-md py-sm text-left font-label-caps text-label-caps uppercase text-outline">
                Dominio
              </th>
              {measures.map((m) => (
                <th
                  key={m.id}
                  title={`${m.name} — ${m.short}`}
                  className="w-12 px-xs py-sm text-center font-label-caps text-label-caps uppercase text-outline"
                >
                  {/* Encabezado abreviado: el nombre completo va en el title y
                      en el detalle expandido. Con 7 medidas no entra entero. */}
                  {m.guide !== null ? `M${m.guide}` : m.id.slice(0, 4).toUpperCase()}
                </th>
              ))}
              <th className="w-24 px-md py-sm text-right font-label-caps text-label-caps uppercase text-outline">
                Cumplim.
              </th>
              <th className="w-28 px-md py-sm text-left font-label-caps text-label-caps uppercase text-outline">
                Servidor web
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const abierta = expandedDomain === row.domain;
              const score = row.result?.score ?? row.result?.verify?.score ?? null;
              const checks = row.result?.verify?.checks ?? [];

              return (
                // La fila y su detalle son dos <tr> hermanos dentro del mismo
                // <tbody>: un Fragment los agrupa sin insertar marcado inválido.
                <Fragment key={row.domain}>
                  <FilaDominio
                    row={row}
                    measures={measures}
                    score={score}
                    abierta={abierta}
                    onToggleExpand={onToggleExpand}
                  />
                  {abierta && (
                    <FilaDetalle
                      row={row}
                      measures={measures}
                      checks={checks}
                      columnas={measures.length + 3}
                    />
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-md border-t border-outline-variant/40 pt-sm font-body-sm text-body-sm text-on-surface-variant">
        <span>
          {rows.length} dominio{rows.length !== 1 ? 's' : ''}
        </span>
        <span className="text-outline">·</span>
        <span className="text-green-400">{alCien} al 100%</span>
        <span className="text-outline">·</span>
        <span className={conFallos > 0 ? 'text-error' : ''}>{conFallos} con error</span>
        {averageScore !== null && (
          <>
            <span className="text-outline">·</span>
            <span>
              Promedio del lote{' '}
              <span className={`font-code-md text-code-md ${colorDeScore(averageScore)}`}>
                {averageScore}%
              </span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Fila principal ────────────────────────────────────────────────────────────

interface FilaDominioProps {
  row: DomainRow;
  measures: HardeningMeasure[];
  score: number | null;
  abierta: boolean;
  onToggleExpand: (domain: string) => void;
}

function FilaDominio({ row, measures, score, abierta, onToggleExpand }: FilaDominioProps) {
  const clickeable = row.result !== null;

  return (
    <tr
      onClick={() => clickeable && onToggleExpand(row.domain)}
      className={`border-b border-outline-variant/40 transition-colors ${
        clickeable ? 'cursor-pointer hover:bg-surface-container' : ''
      } ${abierta ? 'bg-surface-container' : ''} ${row.state === 'pending' ? 'opacity-50' : ''}`}
    >
      <td className="px-md py-sm">
        <span className="flex items-center gap-sm">
          <span className="w-3 shrink-0 text-outline">{clickeable ? (abierta ? '▾' : '▸') : ' '}</span>
          <span className="truncate font-code-md text-code-md text-on-surface" title={row.domain}>
            {row.domain}
          </span>
          {row.state === 'running' && (
            <span className="shrink-0 rounded border border-tertiary/40 bg-tertiary/15 px-sm py-0.5 font-label-caps text-label-caps uppercase text-tertiary">
              En curso
            </span>
          )}
          {row.state === 'pending' && (
            <span className="shrink-0 font-label-caps text-label-caps uppercase text-outline">
              En cola
            </span>
          )}
          {row.state === 'error' && (
            <span
              title={row.result?.error ?? 'Error'}
              className="shrink-0 truncate rounded border border-error/40 bg-error/15 px-sm py-0.5 font-label-caps text-label-caps uppercase text-error"
            >
              Error
            </span>
          )}
        </span>
      </td>

      {measures.map((m) => (
        <td key={m.id} className="px-xs py-sm text-center">
          <StatusCell status={veredictoDeMedida(row, m.id)} measureName={m.name} />
        </td>
      ))}

      <td className="px-md py-sm text-right">
        {score === null ? (
          <span className="font-code-md text-code-md text-outline">—</span>
        ) : (
          <span className={`font-code-md text-code-md ${colorDeScore(score)}`}>{score}%</span>
        )}
      </td>

      <td className="px-md py-sm">
        <span className="font-code-sm text-code-sm text-on-surface-variant">
          {row.result?.verify?.webserver ?? '—'}
        </span>
      </td>
    </tr>
  );
}

// ── Fila de detalle ───────────────────────────────────────────────────────────

interface FilaDetalleProps {
  row: DomainRow;
  measures: HardeningMeasure[];
  checks: VerifyCheck[];
  columnas: number;
}

function FilaDetalle({ row, measures, checks, columnas }: FilaDetalleProps) {
  const grupos = agruparChecks(checks, measures);
  const error = row.result?.error;

  return (
    <tr className="border-b border-outline-variant/40 bg-surface-container-lowest">
      <td colSpan={columnas} className="px-md py-md">
        {error && (
          <p className="mb-md rounded border border-error/40 bg-error/10 px-md py-sm font-code-sm text-code-sm text-error">
            {error}
          </p>
        )}

        {grupos.length === 0 ? (
          <p className="font-body-sm text-body-sm text-outline">
            Sin comprobaciones registradas para este dominio.
          </p>
        ) : (
          <div className="space-y-md">
            {grupos.map((grupo) => (
              <div key={grupo.id}>
                <h4 className="mb-xs font-label-caps text-label-caps uppercase text-outline">
                  {grupo.name}
                </h4>
                <ul className="space-y-0">
                  {grupo.checks.map((check, i) => {
                    const estado = normalizarEstado(check.status);
                    return (
                      <li
                        key={`${check.measure}-${check.id}-${i}`}
                        className="flex items-start gap-sm border-b border-outline-variant/20 py-1 last:border-b-0"
                      >
                        <StatusCell status={estado} />
                        <span className="w-48 shrink-0 truncate font-code-sm text-code-sm text-on-surface-variant" title={check.id}>
                          {check.id}
                        </span>
                        <span className="min-w-0 flex-1 font-body-sm text-body-sm text-on-surface">
                          {check.detail}
                        </span>
                        <span className="shrink-0 font-label-caps text-label-caps uppercase text-outline">
                          {estiloDeEstado(estado).label}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
