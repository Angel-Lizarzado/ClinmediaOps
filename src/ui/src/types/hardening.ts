// Tipos del módulo de Blindaje (hardening de WordPress).
//
// Espejo en TypeScript del contrato que expone `src/main/ipc/hardening.ipc.js`
// y de la forma que devuelve `summarize()` en `hardeningService.js`.
// Si cambia alguno de esos dos archivos, este es el que hay que actualizar.

// ── Verificación ──────────────────────────────────────────────────────────────

/** Veredicto de una comprobación o de una medida completa. */
export const VERIFY_STATUS = {
  PASS: 'pass',
  FAIL: 'fail',
  NOT_APPLICABLE: 'n/a',
  UNKNOWN: 'unknown',
} as const;

export type VerifyStatus = (typeof VERIFY_STATUS)[keyof typeof VERIFY_STATUS];

/** Comprobación individual dentro de una medida. */
export interface VerifyCheck {
  measure: string;
  id: string;
  status: VerifyStatus;
  detail: string;
}

/** Veredicto consolidado de una medida sobre un dominio. */
export interface MeasureVerdict {
  id: string;
  name: string;
  status: VerifyStatus;
  checks: VerifyCheck[];
}

/** Resultado de `verifyHardening()` — lo que arma `summarize()`. */
export interface VerifySummary {
  domain: string;
  webserver: string;
  score: number;
  passed: number;
  evaluated: number;
  notApplicable: number;
  measures: Record<string, MeasureVerdict>;
  checks: VerifyCheck[];
}

// ── Catálogo de medidas ───────────────────────────────────────────────────────

/**
 * Medida del catálogo. Llega desde `hardening:get-measures`, nunca se
 * hardcodea en la UI: el backend puede sumar medidas (`optimize` se agregó
 * después de la guía original) y la pantalla tiene que reflejarlo sola.
 */
export interface HardeningMeasure {
  id: string;
  /** Número de medida en la guía del cliente. `null` si no sale de la guía. */
  guide: number | null;
  name: string;
  short: string;
  /** Depende de .htaccess: en un dominio solo nginx se reporta como n/a. */
  needsApache: boolean;
  /** Borra archivos. Exige confirmación explícita del operador. */
  destructive: boolean;
}

export interface MeasuresResponse {
  success: boolean;
  measures: HardeningMeasure[];
  defaults: string[];
  loginSlug: string;
}

// ── Aplicación ────────────────────────────────────────────────────────────────

/** Entrada del marcador `@@@MEASURE@@@` que emite el script remoto. */
export interface AppliedMeasure {
  measure: string;
  applied: boolean;
  detail?: string;
}

/** Entorno detectado en el dominio (marcador `@@@ENV@@@`). */
export interface HardeningEnvironment {
  webserver?: string;
  wpFound?: boolean;
  error?: string;
}

/** Resultado de `applyHardening()`. */
export interface ApplyReport {
  domain: string;
  success: boolean;
  dryRun?: boolean;
  environment?: HardeningEnvironment | null;
  measures?: AppliedMeasure[];
  requested?: string[];
  error?: string;
}

// ── Resultados por dominio y por lote ─────────────────────────────────────────

/**
 * Resultado consolidado de un dominio. Es lo que devuelven
 * `hardening:run-domain` y `hardening:verify-domain`, y también lo que viaja
 * por el evento `hardening:result` en cada vuelta del lote.
 */
export interface DomainResult {
  domain: string;
  success: boolean;
  dryRun?: boolean;
  apply?: ApplyReport | null;
  verify?: VerifySummary | null;
  score?: number;
  error?: string;
}

/** Resultado de `hardening:run-batch`. */
export interface BatchResult {
  success: boolean;
  aborted?: boolean;
  dryRun?: boolean;
  total?: number;
  failed?: number;
  averageScore?: number;
  results?: DomainResult[];
  error?: string;
}

export interface AbortResponse {
  success: boolean;
}

// ── Progreso en vivo ──────────────────────────────────────────────────────────

/** Fase del pipeline que emitió el evento. */
export type ProgressPhase = 'apply' | 'verify' | 'batch';

/**
 * Evento `hardening:progress`. `status` no es un enum cerrado: la fase de
 * aplicación emite `ok`/`skip`/`info`/`running` y la de verificación reenvía
 * los VerifyStatus tal cual, así que se tipa como string y se normaliza en la
 * UI en vez de romper si el backend suma un valor nuevo.
 */
export interface HardeningProgress {
  domain: string;
  phase: ProgressPhase;
  measure: string;
  status: string;
  msg?: string;
  index?: number;
  total?: number;
  timestamp?: number;
}

/** Entrada de la consola: el evento más un id estable para el `key` de React. */
export interface ConsoleEntry extends HardeningProgress {
  key: string;
}

// ── Estado de una fila de la tabla ────────────────────────────────────────────

export const ROW_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
} as const;

export type RowState = (typeof ROW_STATE)[keyof typeof ROW_STATE];

/** Fila de la tabla de cumplimiento: dominio + su último resultado conocido. */
export interface DomainRow {
  domain: string;
  state: RowState;
  result: DomainResult | null;
}
