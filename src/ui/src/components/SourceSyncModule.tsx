import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useToast } from './Toast';
import { Rocket, Terminal, ChevronRight } from 'lucide-react';

// ── Tipos ────────────────────────────────────────────────────────────────────

interface DeployStep {
  paso: string;
  progreso: number;
  mensaje: string;
  ts: number;
}

type DeployStatus = 'running' | 'success' | 'error';

interface DeployEntry {
  id: string;
  domain: string;
  serverName: string;
  startedAt: number;
  finishedAt?: number;
  steps: DeployStep[];
  status: DeployStatus;
}

interface SourceSyncModuleProps {
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string) => void;
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

// ── Utilidades ────────────────────────────────────────────────────────────────

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

function parsearUrl(url: string) {
  const m = url.trim().match(GITHUB_URL_REGEX);
  return m ? { repoOwner: m[1], repoName: m[2] } : null;
}


const IconGithub = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

function tsNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

function duracion(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Íconos ────────────────────────────────────────────────────────────────────



// ── Barra de progreso compacta ────────────────────────────────────────────────

function ProgressBar({ pct, status }: { pct: number; status: DeployStatus }) {
  const bgClass =
    status === 'error' ? 'bg-error' :
    status === 'success' ? 'bg-green-400' :
    'bg-secondary';
  return (
    <div className="h-1 rounded-full bg-surface-container-highest overflow-hidden mt-2">
      <div 
        className={`h-full rounded-full transition-all duration-300 ease-in-out ${bgClass} ${status === 'running' ? 'animate-pulse' : ''}`}
        style={{ width: `${pct}%` }} 
      />
    </div>
  );
}

// ── Acordeón de un despliegue ─────────────────────────────────────────────────

interface AccordionItemProps {
  entry: DeployEntry;
  isOpen: boolean;
  onToggle: () => void;
}

function AccordionItem({ entry, isOpen, onToggle }: AccordionItemProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entry.steps.length, isOpen]);

  const statusColorClass =
    entry.status === 'error' ? 'text-error bg-error/10 border-error/20' :
    entry.status === 'success' ? 'text-green-400 bg-green-400/10 border-green-400/20' :
    'text-tertiary bg-tertiary/10 border-tertiary/20';

  const statusLabel =
    entry.status === 'error' ? '✗ Error' :
    entry.status === 'success' ? '✓ Listo' :
    '⟳ Desplegando';

  const lastPct = entry.steps.length > 0 ? entry.steps[entry.steps.length - 1].progreso : 0;
  const elapsed = entry.finishedAt
    ? duracion(entry.finishedAt - entry.startedAt)
    : duracion(Date.now() - entry.startedAt);

  return (
    <div
      className={`rounded overflow-hidden transition-opacity border ${
        entry.status === 'running' ? 'border-tertiary/50' : 
        entry.status === 'error' ? 'border-error/50 opacity-85' : 'border-outline-variant'
      }`}
    >
      {/* ── Cabecera del acordeón ── */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-sm px-md py-sm text-left bg-surface-container hover:bg-surface-container-high transition-colors select-none"
      >
        <ChevronRight size={14} className={`text-outline transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`} />

        {/* Dominio */}
        <span className="font-code-md text-code-md text-on-surface flex-1 truncate">
          {entry.domain}
        </span>

        {/* Servidor */}
        <span className="font-code-sm text-code-sm text-outline hidden sm:inline">
          {entry.serverName}
        </span>

        {/* Tiempo */}
        <span className="font-code-sm text-code-sm text-outline min-w-[32px] text-right">
          {elapsed}
        </span>

        {/* Badge de estado */}
        <span className={`font-label-caps text-label-caps px-sm py-0.5 rounded border whitespace-nowrap ${statusColorClass}`}>
          {statusLabel}
        </span>
      </button>

      {/* Barra de progreso siempre visible */}
      {entry.status === 'running' && (
        <div className="px-md pb-sm bg-surface-container">
          <ProgressBar pct={lastPct} status={entry.status} />
          <div className="font-code-sm text-code-sm text-tertiary mt-xs">
            {lastPct}% — {entry.steps[entry.steps.length - 1]?.mensaje || '…'}
          </div>
        </div>
      )}

      {/* ── Cuerpo: logs ── */}
      {isOpen && (
        <div className="bg-black border-t border-outline-variant/50 p-md font-code-sm text-code-sm overflow-y-auto max-h-80 space-y-[2px] scanline-effect">
          {entry.steps.length === 0 ? (
            <span className="text-outline italic">Conectando…</span>
          ) : (
            entry.steps.map((step, idx) => {
              const isError = step.paso === 'error' || step.paso === 'error-fatal';
              const isDone = step.paso === 'completado' || step.progreso >= 100;
              const colorClass = isError ? 'text-error' : isDone ? 'text-green-400' : 'text-on-surface-variant';
              const tsStr = new Date(step.ts).toTimeString().slice(0, 8);
              return (
                <div key={idx} className="flex items-start gap-sm py-px">
                  <span className="text-outline shrink-0 select-none">[{tsStr}]</span>
                  <span className={`break-all ${colorClass}`}>{step.mensaje}</span>
                </div>
              );
            })
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

const SourceSyncModule: React.FC<SourceSyncModuleProps> = ({ onLog }) => {
  const toast = useToast();
  const api = (window as any).api;

  // ── Formulario ─────────────────────────────────────────────────────────────
  const [servidores, setServidores] = useState<string[]>([]);
  const [serverName, setServerName] = useState('');
  const [domain, setDomain] = useState('');
  const [httpsUrl, setHttpsUrl] = useState('');
  const [vincularGitHub, setVincularGitHub] = useState(true);

  // ── Estado de ejecución ────────────────────────────────────────────────────
  const [desplegando, setDesplegando] = useState(false);

  // ── Historial de despliegues (Terminal Accordion) ──────────────────────────
  const [deploymentLog, setDeploymentLog] = useState<DeployEntry[]>([]);
  const [openAccordions, setOpenAccordions] = useState<Set<string>>(new Set());
  const activeEntryIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // ── Hidratar desde AppStateManager al montar ──────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const state = await api?.invoke('sourcesync:get-state');
        if (state?.deploymentLog?.length > 0) {
          setDeploymentLog(state.deploymentLog);
          // Abrir el más reciente automáticamente
          setOpenAccordions(new Set([state.deploymentLog[0].id]));
        }
        if (state?.isRunning && state.activeDomain) {
          setDesplegando(true);
        }
      } catch { /* silencioso */ }
    })();
  }, []);

  // ── Cargar servidores configurados ─────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api?.invoke('config:get');
        const destinos: string[] = (cfg?.destinationServers || []).map((s: any) => s.name).filter(Boolean);
        setServidores(destinos);
        if (destinos.length > 0 && !serverName) setServerName(destinos[0]);
      } catch { /* silencioso */ }
    })();
  }, []);

  // ── Escuchar config:updated ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (cfg: any) => {
      if (!cfg?.config?.destinationServers) return;
      const d = cfg.config.destinationServers.map((s: any) => s.name).filter(Boolean);
      setServidores(d);
    };
    api?.receive('config:updated', handler);
    return () => api?.removeListener('config:updated', handler);
  }, []);

  // ── Cleanup al desmontar ────────────────────────────────────────────────────
  useEffect(() => {
    return () => { cleanupRef.current?.(); cleanupRef.current = null; };
  }, []);

  // ── Escuchar state:update para sincronizar deploymentLog ───────────────────
  // Antes escuchaba 'app:state-update', un canal que ningún emisor manda, con
  // una forma de payload ({ module, state }) que tampoco existe. El listener
  // nunca se disparó. AppStateManager._broadcast() emite 'state:update' con el
  // estado completo, un módulo por clave.
  useEffect(() => {
    const handler = (payload: any) => {
      const sl = payload?.sourcesync;
      if (!sl) return;
      if (sl.deploymentLog) setDeploymentLog([...sl.deploymentLog]);
      if (typeof sl.isRunning === 'boolean') setDesplegando(sl.isRunning);
    };
    const cleanup = api?.receive('state:update', handler);
    return () => {
      if (typeof cleanup === 'function') cleanup();
      else api?.removeListener('state:update', handler);
    };
  }, []);

  // ── Toggle acordeón ────────────────────────────────────────────────────────
  const toggleAccordion = useCallback((id: string) => {
    setOpenAccordions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ── Validación del formulario ─────────────────────────────────────────────
  const formularioValido = !!(serverName.trim() && domain.trim() && httpsUrl.trim() && parsearUrl(httpsUrl));

  // ── Iniciar despliegue ────────────────────────────────────────────────────
  const handleDesplegar = useCallback(async () => {
    if (!formularioValido || desplegando) return;

    const parsed = parsearUrl(httpsUrl);
    if (!parsed) { toast.error('URL de GitHub inválida. Formato: https://github.com/org/repo'); return; }

    const entryId = `${domain.trim()}-${Date.now()}`;
    activeEntryIdRef.current = entryId;

    // Crear entrada local inmediatamente (UI responde antes de que AppState actualice)
    const localEntry: DeployEntry = {
      id: entryId,
      domain: domain.trim(),
      serverName: serverName.trim(),
      startedAt: Date.now(),
      steps: [{ paso: 'inicio', progreso: 0, mensaje: `Iniciando despliegue de "${domain.trim()}" en servidor "${serverName.trim()}"...`, ts: Date.now() }],
      status: 'running',
    };

    setDeploymentLog(prev => [localEntry, ...prev.filter(e => e.id !== entryId)].slice(0, 20));
    setOpenAccordions(prev => new Set([entryId, ...prev]));
    setDesplegando(true);

    // Suscribir a progreso en tiempo real (enriquece la entrada local)
    if (cleanupRef.current) cleanupRef.current();

    const progressHandler = (evento: any) => {
      const step: DeployStep = {
        paso: evento.paso || '',
        progreso: evento.progreso ?? 0,
        mensaje: evento.mensaje || '',
        ts: Date.now(),
      };
      setDeploymentLog(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], steps: [...updated[idx].steps, step] };
        return updated;
      });
    };

    api?.receive('sourcesync:progreso', progressHandler);
    cleanupRef.current = () => api?.removeListener('sourcesync:progreso', progressHandler);

    try {
      const resultado = await api?.invoke('sourcesync:deploy', {
        serverName: serverName.trim(),
        domain: domain.trim(),
        httpsUrl: httpsUrl.trim(),
        repoOwner: parsed.repoOwner,
        repoName: parsed.repoName,
        vincularGitHub,
        rama: 'main',
      });

      const finalStatus: DeployStatus = resultado?.success ? 'success' : 'error';
      const finalMsg = resultado?.success
        ? `Despliegue completado. Node.js ${resultado.versionNode}. Repo: ${resultado.urlSsh || httpsUrl}`
        : `Error: ${resultado?.error || 'Error desconocido.'}`;

      setDeploymentLog(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          status: finalStatus,
          finishedAt: Date.now(),
          steps: [...updated[idx].steps, { paso: finalStatus, progreso: resultado?.success ? 100 : 0, mensaje: finalMsg, ts: Date.now() }],
        };
        return updated;
      });

      if (resultado?.success) {
        toast.success('Despliegue configurado correctamente.');
        onLog(`[SOURCESYNC] ${finalMsg}`, 'success', 'sourcesync');
      } else {
        toast.error(resultado?.error || 'Error en el despliegue.');
        onLog(`[SOURCESYNC] Error: ${resultado?.error}`, 'error', 'sourcesync');
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Error de comunicación IPC.';
      setDeploymentLog(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          status: 'error',
          finishedAt: Date.now(),
          steps: [...updated[idx].steps, { paso: 'error', progreso: 0, mensaje: `Error inesperado: ${errMsg}`, ts: Date.now() }],
        };
        return updated;
      });
      toast.error(errMsg);
      onLog(`[SOURCESYNC] Error inesperado: ${errMsg}`, 'error', 'sourcesync');
    } finally {
      setDesplegando(false);
      cleanupRef.current?.();
      cleanupRef.current = null;
      activeEntryIdRef.current = null;
    }
  }, [formularioValido, desplegando, serverName, domain, httpsUrl, vincularGitHub, toast, onLog]);

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      
      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md border-b border-outline-variant/30">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-md">
          <div>
            <h2 className="font-display-lg text-display-lg text-secondary mb-xs flex items-center gap-sm">
              <span className="flex items-center justify-center w-8 h-8 rounded bg-secondary-container/20 text-secondary">
                <Rocket size={16} />
              </span>
              SourceSync
            </h2>
            <p className="font-body-md text-on-surface-variant max-w-2xl">
              Despliegue automatizado de proyectos Next.js (Standalone) a Plesk vía Git
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg mt-md">
        <div className="max-w-4xl mx-auto space-y-lg pb-24">

          {/* ── Formulario ── */}
          <section>
            <h2 className="font-label-caps text-label-caps text-outline uppercase mb-sm">Configurar despliegue</h2>
            <div className="bg-surface-container-low border border-outline-variant p-lg space-y-md rounded">

              <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
                {/* Servidor */}
                <div className="space-y-xs">
                  <label htmlFor="sourcesync-server" className="font-label-caps text-label-caps text-outline">
                    Servidor Plesk destino
                  </label>
                  {servidores.length > 0 ? (
                    <select
                      id="sourcesync-server"
                      value={serverName}
                      onChange={e => setServerName(e.target.value)}
                      disabled={desplegando}
                      className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm"
                    >
                      {servidores.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  ) : (
                    <p className="text-xs py-sm px-md rounded bg-tertiary-container/20 text-tertiary border border-tertiary/30">
                      No hay servidores Plesk configurados. Agregue uno desde el Panel principal.
                    </p>
                  )}
                </div>

                {/* Dominio */}
                <div className="space-y-xs">
                  <label htmlFor="sourcesync-domain" className="font-label-caps text-label-caps text-outline">
                    Dominio de destino
                  </label>
                  <input
                    id="sourcesync-domain"
                    type="text"
                    value={domain}
                    onChange={e => setDomain(e.target.value)}
                    disabled={desplegando}
                    placeholder="ej: app.example.com"
                    className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-code-md rounded px-sm py-sm"
                  />
                </div>
              </div>

              {/* URL repo */}
              <div className="space-y-xs">
                <label htmlFor="sourcesync-repo" className="font-label-caps text-label-caps text-outline">
                  URL HTTPS del repositorio GitHub
                </label>
                <div className="flex items-center gap-sm bg-surface-container border border-outline-variant rounded px-sm focus-within:border-secondary focus-within:ring-1 focus-within:ring-secondary transition-all">
                  <span className="text-outline shrink-0"><IconGithub /></span>
                  <input
                    id="sourcesync-repo"
                    type="text"
                    value={httpsUrl}
                    onChange={e => setHttpsUrl(e.target.value)}
                    disabled={desplegando}
                    placeholder="https://github.com/organización/repositorio"
                    className="w-full bg-transparent text-on-surface font-code-md py-sm outline-none"
                  />
                </div>
                {httpsUrl && !parsearUrl(httpsUrl) && (
                  <p className="font-body-sm text-error mt-xs">
                    URL inválida. Formato requerido: https://github.com/org/repo
                  </p>
                )}
              </div>

              {/* Checkbox vincular */}
              <div className="flex items-start gap-sm py-sm">
                <input
                  id="sourcesync-vincular"
                  type="checkbox"
                  checked={vincularGitHub}
                  onChange={e => setVincularGitHub(e.target.checked)}
                  disabled={desplegando}
                  className="mt-1 w-4 h-4 accent-secondary bg-surface-container border-outline-variant rounded disabled:opacity-50 cursor-pointer"
                />
                <label htmlFor="sourcesync-vincular" className="cursor-pointer">
                  <div className="font-body-md text-on-surface">Generar y registrar llave SSH Ed25519 en GitHub</div>
                  <div className="font-body-sm text-on-surface-variant mt-xs">Desmarca si el dominio ya tiene la llave configurada previamente.</div>
                </label>
              </div>

              {/* Botón */}
              <div className="flex items-center gap-md pt-sm border-t border-outline-variant/30 mt-sm">
                <button
                  id="sourcesync-btn-deploy"
                  onClick={handleDesplegar}
                  disabled={desplegando || !formularioValido}
                  className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${
                    formularioValido && !desplegando
                      ? 'bg-secondary-container text-on-secondary-container hover:brightness-110'
                      : 'bg-surface-container-highest text-outline cursor-not-allowed'
                  }`}
                >
                  {desplegando
                    ? <><span className="w-4 h-4 rounded-full border-2 border-outline border-t-transparent animate-spin shrink-0" />Desplegando...</>
                    : <><Rocket size={16} />Iniciar Despliegue</>
                  }
                </button>
                {deploymentLog.length > 0 && !desplegando && (
                  <button
                    onClick={() => setDeploymentLog([])}
                    className="font-label-caps text-label-caps text-on-surface-variant hover:text-on-surface transition-colors"
                  >
                    Limpiar historial
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* ── Terminal Accordion ── */}
          {deploymentLog.length > 0 && (
            <section>
              <h2 className="font-label-caps text-label-caps text-outline uppercase mb-sm flex items-center gap-sm">
                <Terminal size={14} />
                Historial de despliegues
                <span className="bg-surface-container px-2 py-0.5 rounded text-[10px] ml-auto">
                  {deploymentLog.length}
                </span>
              </h2>
              <div className="space-y-sm bg-surface-container-low border border-outline-variant p-sm rounded">
                {deploymentLog.map(entry => (
                  <AccordionItem
                    key={entry.id}
                    entry={entry}
                    isOpen={openAccordions.has(entry.id)}
                    onToggle={() => toggleAccordion(entry.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── Nota técnica ── */}
          <section>
            <div className="bg-surface-container-lowest border border-outline-variant p-md rounded space-y-sm text-on-surface-variant font-body-sm">
              <p className="font-title-sm text-secondary">Requisitos previos</p>
              <ul className="list-disc list-inside space-y-xs ml-xs">
                <li>El GitHub API Token debe estar configurado en <strong>Configuración → Integraciones Externas</strong>.</li>
                <li>El repositorio debe contener <code className="font-code-sm px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant/50">deploy.sh</code> en la raíz.</li>
                <li>Node.js v24.15.0 se usará como fallback si las versiones LTS están deshabilitadas en Plesk.</li>
                <li>El despliegue es idempotente: puede re-ejecutarse sin duplicar la configuración.</li>
              </ul>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
};

export default SourceSyncModule;
