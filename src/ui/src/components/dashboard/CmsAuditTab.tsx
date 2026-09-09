import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { LogLevel } from '../../types/ipc';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DomainEntry {
  domain: string;
  status: 'idle' | 'running' | 'success' | 'error';
  steps: Array<{ msg: string; level: string }>;
  error?: string;
  duration?: number;
}

type CmsMode = 'full' | 'core-only' | 'security-only' | 'solo-plugin';

interface WpVersion { version: string; estado: string; esUltima?: boolean; }

interface CmsProgress {
  type: string;
  domain?: string;
  msg?: string;
  level?: string;
  success?: boolean;
  duration?: number;
  total?: number;
}

interface Props { onLog: (msg: string, type?: LogLevel) => void }

// ── Badge component ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DomainEntry['status'] }) {
  const map = {
    idle:    { label: 'Pendiente', color: '#a5a5a5',    bg: 'rgba(255, 255, 255, 0.05)' },
    running: { label: '⟳ Procesando', color: '#f59e0b',         bg: 'oklch(0.55 0.15 75 / 0.15)' },
    success: { label: '✓ OK',       color: '#33d9b2', bg: 'rgba(51, 217, 178, 0.12)' },
    error:   { label: '✗ Error',    color: '#ff5252',   bg: 'rgba(255, 82, 82, 0.12)' },
  };
  const s = map[status];
  return (
    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
      style={{ color: s.color, backgroundColor: s.bg, border: `1px solid ${s.color}30` }}>
      {s.label}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CmsAuditTab({ server }: { server: any }) {
  const onLog = (msg: string, type?: string) => console.log(msg);
  const serverName = server.name;
  const api = (window as any).api;

  // Config
    const [domainsRaw, setDomainsRaw]   = useState('');
  const [localZipPath, setLocalZipPath] = useState('');
  const [targetPhpVersion, setTargetPhpVersion] = useState('Mantener actual');
  const [mode, setMode]               = useState<CmsMode>('full');
  const [dryRun, setDryRun]           = useState(false);
  const [phpSwitch, setPhpSwitch]     = useState(false);
  const [servers, setServers]         = useState<string[]>([]);
  
  // Audit Table State
  const [auditPhase, setAuditPhase]   = useState<'idle' | 'auditing' | 'results'>('idle');
  const [auditResults, setAuditResults] = useState<any[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [auditMsg, setAuditMsg]       = useState('');
  
  // Versions
  const [versionesPHP, setVersionesPHP] = useState<any[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);

  // Runtime
  const [isRunning, setIsRunning]     = useState(false);
  const [entries, setEntries]         = useState<DomainEntry[]>([]);
  const [openDomains, setOpenDomains] = useState<Set<string>>(new Set());
  const [filterFailed, setFilterFailed] = useState(false);
  const [globalMsg, setGlobalMsg]     = useState('');

  // Stats
  const succeeded = entries.filter(e => e.status === 'success').length;
  const failed    = entries.filter(e => e.status === 'error').length;
  const running   = entries.filter(e => e.status === 'running').length;
  const total     = entries.length;

  // Hydrate persisted state
  useEffect(() => {
    api?.invoke('cms:get-state').then((res: any) => {
      if (!res?.state) return;
      const s = res.state;
      // Solo restaurar si el estado pertenece a este servidor (evita cruce con el Reconstructor Global u otros nodos)
      if (s.history?.length > 0 && s.serverName === serverName) {
        setEntries(s.history.map((h: any) => ({
          domain: h.domain,
          status: h.status === 'success' ? 'success' : 'error',
          steps: h.error ? [{ msg: h.error, level: 'error' }] : [],
          error: h.error,
          duration: h.duration,
        })));
      }
      if (s.isRunning && s.serverName === serverName) setIsRunning(true);
    }).catch(() => {});
  }, []);

  // Hydrate versions when server changes
  useEffect(() => {
    if (!serverName) {
      setVersionesPHP([]);
      return;
    }
    setIsLoadingVersions(true);
    api?.invoke('reconstructor:obtener-versiones', { serverName })
      .then((res: any) => {
        if (res?.success && res.versiones?.php?.exito) {
          setVersionesPHP(res.versiones.php.versiones || []);
          if (res.versiones.php.versiones?.length > 0) {
            setTargetPhpVersion(res.versiones.php.versiones[0].idCrudo);
          }
        } else {
          setVersionesPHP([]);
        }
      })
      .catch(() => {
        setVersionesPHP([]);
      })
      .finally(() => {
        setIsLoadingVersions(false);
      });
  }, [serverName]);

  // Fix 4.5: Prevenir duplicado de eventos de auditoría
  const auditOwner = useRef(false);

  // Audit Progress Listener
  useEffect(() => {
    const handler = (ev: any) => {
      if (!auditOwner.current) return;
      if (!ev) return;
      if (ev.type === 'audit-start') { setAuditMsg(ev.msg || ''); return; }
      if (ev.type === 'audit-domains-found') { setAuditMsg(ev.msg || ''); return; }
      if (ev.type === 'domain-audited') {
        if (ev.isWp !== false && ev.domain) {
          setAuditResults(prev => {
            const entry = {
              domain: ev.domain,
              wpVersion: ev.wpVersion,
              pluginCount: ev.pluginCount,
              phpHandler: ev.phpHandler,
              error: ev.error,
            };
            const idx = prev.findIndex(r => r.domain === ev.domain);
            if (idx >= 0) { const n = [...prev]; n[idx] = entry; return n; }
            return [...prev, entry];
          });
        }
        return;
      }
      if (ev.type === 'audit-done') {
        setAuditPhase('results');
        setAuditMsg(ev.msg || '');
        if (ev.results) setAuditResults(ev.results.filter((r: any) => r.isWp));
        auditOwner.current = false;
        return;
      }
      if (ev.type === 'audit-error') { 
        setAuditPhase('results'); 
        setAuditMsg(`Error: ${ev.msg}`); 
        auditOwner.current = false;
        return; 
      }
    };
    api?.receive('cms:audit-progress', handler);
    return () => { api?.removeListener?.('cms:audit-progress', handler); };
  }, []);

  // Fix 4: Prevenir duplicado de eventos cuando CmsAuditTab está activo.
  // Este módulo solo procesa eventos si FUE ÉL quien inició el batch.
  const batchOwner = useRef(false);

  // cms:progress listener
  useEffect(() => {
    const handler = (event: CmsProgress) => {
      // Ignorar eventos si el batch fue iniciado por CmsAuditTab, no por este módulo
      if (!batchOwner.current) return;
      if (!event) return;

      if (event.type === 'batch-start') {
        setGlobalMsg(event.msg || '');
        setIsRunning(true);
        return;
      }
      if (event.type === 'batch-done') {
        setGlobalMsg(event.msg || '');
        setIsRunning(false);
        batchOwner.current = false; // liberar ownership
        return;
      }
      if (event.type === 'php-switch') {
        setGlobalMsg(event.msg || '');
        return;
      }
      
      if (event.type === 'upload-start' || event.type === 'upload-done') {
        const uploadKey = '__upload_elementor__';
        setOpenDomains(prev => new Set([...prev, uploadKey]));
        setEntries(prev => {
          const exists = prev.find(e => e.domain === uploadKey);
          const stepMsg = { msg: event.msg || 'Subiendo Elementor...', level: event.level || 'info' };
          
          if (exists) {
            return prev.map(e => e.domain === uploadKey 
              ? { ...e, status: event.type === 'upload-done' ? 'success' : 'running', steps: [...e.steps, stepMsg] } 
              : e);
          }
          return [{ domain: uploadKey, status: event.type === 'upload-done' ? 'success' : 'running', steps: [stepMsg] }, ...prev];
        });
        setGlobalMsg(event.msg || '');
        return;
      }

      const domain = event.domain;
      if (!domain) return;

      if (event.type === 'domain-start') {
        setOpenDomains(prev => new Set([...prev, domain]));
        setEntries(prev => {
          const exists = prev.find(e => e.domain === domain);
          if (exists) return prev.map(e => e.domain === domain ? { ...e, status: 'running', steps: [] } : e);
          return [...prev, { domain, status: 'running', steps: [] }];
        });
        return;
      }

      if (event.type === 'domain-step') {
        setEntries(prev => prev.map(e =>
          e.domain === domain
            ? { ...e, steps: [...e.steps, { msg: event.msg || '', level: event.level || 'info' }] }
            : e
        ));
        return;
      }

      if (event.type === 'domain-done') {
        setEntries(prev => prev.map(e =>
          e.domain === domain
            ? { ...e, status: 'success', duration: event.duration }
            : e
        ));
        setOpenDomains(prev => { const n = new Set(prev); n.delete(domain); return n; });
        return;
      }

      if (event.type === 'domain-error') {
        setEntries(prev => prev.map(e =>
          e.domain === domain
            ? { ...e, status: 'error', error: event.msg, duration: event.duration }
            : e
        ));
        return;
      }
    };

    api?.receive('cms:progress', handler);
    return () => { api?.removeListener('cms:progress', handler); };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleAudit = useCallback(async () => {
    if (!serverName) return;
    auditOwner.current = true;
    setAuditPhase('auditing');
    setAuditResults([]);
    setSelectedDomains(new Set());
    setAuditMsg('');
    await api?.invoke('cms:audit-server', { serverName });
  }, [serverName]);

  const handleStart = useCallback(async () => {
    const domains = [...selectedDomains];
    if (!domains.length) return;
    if (!serverName) return;

    batchOwner.current = true; // Fix 4: este módulo es el dueño del batch
    setEntries(domains.map(domain => ({ domain, status: 'idle', steps: [] })));
    setOpenDomains(new Set());
    setFilterFailed(false);
    setGlobalMsg('');

    let excludedBlacklistSlugs: string[] = [];
    try {
      const saved = localStorage.getItem('kraken_excluded_blacklist_slugs');
      if (saved) excludedBlacklistSlugs = JSON.parse(saved);
    } catch {}

    const res = await api?.invoke('cms:start-batch', {
      serverName, domains, localZipPath: localZipPath || null,
      targetPhpVersion, mode, dryRun, phpSwitch,
      excludedBlacklistSlugs,
    });
    if (!res?.success) {
      batchOwner.current = false;
      setGlobalMsg(`Error: ${res?.error || 'No se pudo iniciar'}`);
      onLog(`[CMS] ${res?.error}`, 'error');
    }
  }, [serverName, selectedDomains, localZipPath, targetPhpVersion, mode, dryRun, phpSwitch, onLog]);

  const handleAbort = useCallback(async () => {
    await api?.invoke('cms:abort');
    setIsRunning(false);
    if (auditPhase === 'auditing') {
      setAuditPhase('results');
      setAuditMsg('⛔ Auditoría abortada por el usuario.');
    }
  }, [auditPhase]);

  const handlePickZip = useCallback(async () => {
    const result = await api?.invoke('dialog:open-file', {
      title: 'Seleccionar ZIP Plugin',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (result?.filePath) setLocalZipPath(result.filePath);
  }, []);

  const exportCsv = useCallback(() => {
    const rows = ['dominio,estado,duracion_s,error'];
    entries.forEach(e => {
      rows.push([e.domain, e.status, ((e.duration || 0) / 1000).toFixed(1), e.error || ''].join(','));
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `cms-report-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }, [entries]);

  const toggleDomain = (domain: string) => {
    setOpenDomains(prev => {
      const n = new Set(prev);
      n.has(domain) ? n.delete(domain) : n.add(domain);
      return n;
    });
  };

  const domains = [...selectedDomains];
  const visibleEntries = filterFailed ? entries.filter(e => e.status === 'error') : entries;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-6 space-y-5">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-xl font-bold">CMS Reconstructor</h1>
            <p className="text-xs mt-0.5" style={{ color: '#a5a5a5' }}>
              Reconstrucción industrial de WordPress — hasta 600 dominios
            </p>
          </div>
          <div className="flex items-center gap-2">
            {entries.length > 0 && (
              <button onClick={exportCsv} className="btn btn--ghost text-xs">
                Exportar CSV
              </button>
            )}
            {isRunning || auditPhase === 'auditing' ? (
              <button onClick={handleAbort} className="btn text-xs font-medium bg-error text-white">
                ⛔ Abortar
              </button>
            ) : (
              <button onClick={handleStart} disabled={!domains.length || !serverName || isLoadingVersions}
                className="btn btn--primary text-xs font-medium">
                {isLoadingVersions ? '⏳ Cargando...' : '🚀 Iniciar Reconstrucción'}
              </button>
            )}
          </div>
        </div>

        {/* ── Progress dashboard (visible cuando hay entradas) ── */}
        {entries.length > 0 && (
          <div className="card p-4">
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              {[
                { label: 'Total',     value: total,     color: '#ffffff' },
                { label: '✅ OK',     value: succeeded, color: '#33d9b2' },
                { label: '❌ Error',  value: failed,    color: '#ff5252' },
                { label: '⟳ Activos',value: running,   color: '#f59e0b' },
              ].map(s => (
                <div key={s.label} className="text-center">
                  <div className="text-2xl font-bold font-mono" style={{ color: s.color }}>{s.value}</div>
                  <div className="text-xs mt-0.5" style={{ color: '#a5a5a5' }}>{s.label}</div>
                </div>
              ))}
            </div>
            {total > 0 && (
              <div className="mt-3" style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255, 255, 255, 0.05)' }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: `${((succeeded + failed) / total) * 100}%`,
                  backgroundColor: failed > 0 ? '#ff5252' : '#33d9b2',
                  transition: 'width 400ms ease-out',
                }} />
              </div>
            )}
            {globalMsg && (
              <p className="text-xs mt-2 font-mono" style={{ color: '#a5a5a5' }}>{globalMsg}</p>
            )}
          </div>
        )}

        <div className="grid gap-5" style={{ gridTemplateColumns: '340px 1fr' }}>
          {/* ── Config panel ── */}
          <div className="card p-4 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#a5a5a5' }}>
              Configuración
            </h2>

            

            {/* Versión PHP Destino */}
            <div className="space-y-1">
              <label className="text-xs font-medium flex justify-between text-on-surface-variant">
                <span>Versión PHP Destino</span>
                {isLoadingVersions && <span className="animate-pulse text-tertiary">Cargando...</span>}
              </label>
              <select value={targetPhpVersion} onChange={e => setTargetPhpVersion(e.target.value)}
                className="input text-xs w-full" disabled={isLoadingVersions || versionesPHP.length === 0}>
                {versionesPHP.length === 0 ? (
                  <option value="Mantener actual">Mantener actual</option>
                ) : (
                  <>
                    <option value="Mantener actual">Mantener actual</option>
                    {versionesPHP.map(v => (
                      <option key={v.idCrudo} value={v.idCrudo}>
                        {v.version} — {v.etiquetaCompleta}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>

            {/* Modo */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-on-surface-variant">Modo</label>
              <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                {(['full', 'core-only', 'security-only', 'solo-plugin'] as CmsMode[]).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className="text-[10px] px-2 py-1.5 rounded-md transition-all"
                    style={{
                      backgroundColor: mode === m ? 'rgba(52, 172, 224, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                      color: mode === m ? '#34ace0' : '#a5a5a5',
                      border: `1px solid ${mode === m ? '#34ace0' : 'rgba(255, 255, 255, 0.1)'}`,
                    }}>
                    {m === 'full' ? 'Full' : m === 'core-only' ? 'Solo Core' : m === 'security-only' ? 'Solo Seguridad' : 'Solo Plugin'}
                  </button>
                ))}
              </div>
            </div>

            {/* ZIP Plugin */}
            {(mode === 'full' || mode === 'solo-plugin') && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-on-surface-variant">
                  ZIP Plugin
                </label>
                <div className="flex gap-1.5">
                  <input type="text" value={localZipPath} onChange={e => setLocalZipPath(e.target.value)}
                    placeholder="Ruta local del .zip" className="input text-[10px] flex-1 font-mono" readOnly />
                  <button onClick={handlePickZip} className="btn btn--ghost text-xs px-2">
                    📂
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Domains Table ── */}
          <div className="card p-4 space-y-2 flex flex-col" style={{ minHeight: 300 }}>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-on-surface-variant">
                Dominios WP: {auditResults.length} / Seleccionados: {selectedDomains.size}
              </label>
              <button onClick={handleAudit} disabled={!serverName || auditPhase === 'auditing'}
                className="btn btn--ghost text-xs">
                {auditPhase === 'auditing' ? '⏳ Auditando...' : '🔍 Auditar Servidor'}
              </button>
            </div>
            
            <div className="flex-1 overflow-auto border rounded-md border-outline-variant">
              <table className="w-full text-[10px]">
                <thead style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)' }}>
                  <tr>
                    <th className="px-3 py-1.5 text-left w-8">
                      <input type="checkbox"
                        checked={auditResults.length > 0 && selectedDomains.size === auditResults.length}
                        onChange={() => {
                          if (selectedDomains.size === auditResults.length) setSelectedDomains(new Set());
                          else setSelectedDomains(new Set(auditResults.map(r => r.domain)));
                        }} />
                    </th>
                    <th className="px-3 py-1.5 text-left font-medium" style={{ color: '#a5a5a5' }}>Dominio</th>
                    <th className="px-3 py-1.5 text-left font-medium" style={{ color: '#a5a5a5' }}>WP Ver.</th>
                    <th className="px-3 py-1.5 text-left font-medium" style={{ color: '#a5a5a5' }}>Plugins</th>
                    <th className="px-3 py-1.5 text-left font-medium" style={{ color: '#a5a5a5' }}>PHP</th>
                  </tr>
                </thead>
                <tbody>
                  {auditResults.map(row => (
                    <tr key={row.domain}
                      onClick={() => {
                        const n = new Set(selectedDomains);
                        n.has(row.domain) ? n.delete(row.domain) : n.add(row.domain);
                        setSelectedDomains(n);
                      }}
                      style={{
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor: selectedDomains.has(row.domain) ? 'rgba(52, 172, 224, 0.2)' : 'transparent',
                        cursor: 'pointer',
                      }}>
                      <td className="px-3 py-1.5 border-t border-outline-variant">
                        <input type="checkbox" checked={selectedDomains.has(row.domain)} readOnly />
                      </td>
                      <td className="px-3 py-1.5 border-t font-mono" style={{ borderColor: 'rgba(255, 255, 255, 0.1)', color: '#ffffff' }}>
                        {row.domain}
                      </td>
                      <td className="px-3 py-1.5 border-t font-mono border-outline-variant text-on-surface-variant">
                        {row.wpVersion || '?'}
                      </td>
                      <td className="px-3 py-1.5 border-t font-mono border-outline-variant text-on-surface-variant">
                        {row.pluginCount ?? '?'}
                      </td>
                      <td className="px-3 py-1.5 border-t font-mono" style={{ borderColor: 'rgba(255, 255, 255, 0.1)', color: '#a5a5a5' }}>
                        {row.phpHandler ? row.phpHandler.replace(/.*plesk-php|\/php.*/, '').trim() : '?'}
                      </td>
                    </tr>
                  ))}
                  {auditResults.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-xs" style={{ color: '#a5a5a5' }}>
                        {auditPhase === 'idle' ? 'Haz clic en Auditar Servidor para cargar dominios' : 'Sin dominios'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {auditMsg && <p className="text-[10px] font-mono mt-2" style={{ color: '#a5a5a5' }}>{auditMsg}</p>}
          </div>
        </div>

        {/* ── Terminal Accordion ── */}
        {entries.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Progreso por dominio</h2>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={filterFailed} onChange={e => setFilterFailed(e.target.checked)}
                  className="accent-tertiary" />
                <span className="text-xs" style={{ color: '#a5a5a5' }}>
                  Ver solo fallidos ({failed})
                </span>
              </label>
            </div>

            <div className="space-y-1.5">
              {visibleEntries.map(entry => (
                <div key={entry.domain} className="card overflow-hidden">
                  {/* Accordion header */}
                  <button
                    onClick={() => toggleDomain(entry.domain)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left"
                    style={{ backgroundColor: 'transparent' }}
                  >
                    <StatusBadge status={entry.status} />
                    <span className="text-xs font-mono flex-1" style={{ color: '#ffffff' }}>
                      {entry.domain}
                    </span>
                    {entry.duration && (
                      <span className="text-[10px] font-mono" style={{ color: '#a5a5a5' }}>
                        {(entry.duration / 1000).toFixed(1)}s
                      </span>
                    )}
                    <span style={{ color: '#a5a5a5', fontSize: 10 }}>
                      {openDomains.has(entry.domain) ? '▲' : '▼'}
                    </span>
                  </button>

                  {/* Accordion body */}
                  <AnimatePresence initial={false}>
                    {openDomains.has(entry.domain) && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div className="border-t px-4 py-3 space-y-0.5 border-outline-variant max-h-[240px] overflow-y-auto">
                          {entry.steps.length === 0 ? (
                            <p className="text-[10px] font-mono" style={{ color: '#a5a5a5' }}>
                              Esperando inicio...
                            </p>
                          ) : entry.steps.map((step, i) => {
                            const color = step.level === 'error' ? '#ff5252'
                              : step.level === 'success' ? '#33d9b2'
                              : step.level === 'warn' ? '#ffb142'
                              : '#d1d1d1';
                            return (
                              <p key={i} className="text-[10px] font-mono leading-relaxed"
                                style={{ color, wordBreak: 'break-all' }}>
                                {step.msg}
                              </p>
                            );
                          })}
                          {entry.status === 'running' && (
                            <p className="text-[10px] font-mono animate-pulse" style={{ color: '#f59e0b' }}>
                              ▌ Procesando...
                            </p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
