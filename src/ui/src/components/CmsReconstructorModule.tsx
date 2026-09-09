import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { LogLevel } from '../types/ipc';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DomainEntry {
  domain: string;
  status: 'idle' | 'running' | 'success' | 'error';
  steps: Array<{ msg: string; level: string }>;
  error?: string;
  duration?: number;
}

type CmsMode = 'full' | 'core-only' | 'security-only' | 'solo-plugin' | 'flush-permalinks';

interface CmsProgress {
  type: string;
  domain?: string;
  msg?: string;
  level?: string;
  success?: boolean;
  duration?: number;
  total?: number;
}

interface Props {
  onLog: (msg: string, type?: LogLevel) => void;
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODE_LABELS: Record<CmsMode, string> = {
  'full':             'Full',
  'core-only':        'Solo Core',
  'security-only':    'Seguridad',
  'solo-plugin':      'Plugin',
  'flush-permalinks': 'Permalinks',
};

const MODE_DESCRIPTIONS: Record<CmsMode, string> = {
  'full':             'Reconstrucción completa: core, plugins, seguridad y caché',
  'core-only':        'Solo actualiza el core de WordPress',
  'security-only':    'Aplica hardening y revisa checksums del core',
  'solo-plugin':      'Instala Elementor Pro (config) + ZIP adicional + desactiva plugins conflictivos',
  'flush-permalinks': 'Flusheea permalinks y caché WP (wp rewrite flush --hard)',
};

const BLACKLIST_PLUGINS = [
  { slug: 'all-in-one-wp-migration', name: 'All-in-One WP Migration' },
  { slug: 'gdpr-cookie-compliance', name: 'GDPR Cookie Compliance' },
  { slug: 'litespeed-cache', name: 'LiteSpeed Cache' },
  { slug: 'duplicate-page', name: 'Duplicate Page' },
  { slug: 'starter-templates', name: 'Starter Templates' },
  { slug: 'migrate-guru', name: 'Migrate Guru' },
];

// ── Badge component ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DomainEntry['status'] }) {
  const map = {
    idle:    { label: 'Pendiente',    color: '#a5a5a5', bg: 'rgba(255, 255, 255, 0.05)' },
    running: { label: '⟳ Procesando', color: '#f59e0b', bg: 'oklch(0.55 0.15 75 / 0.15)' },
    success: { label: '✓ OK',         color: '#33d9b2', bg: 'oklch(0.55 0.15 145 / 0.12)' },
    error:   { label: '✗ Error',      color: '#ff5252', bg: 'oklch(0.45 0.12 25 / 0.12)' },
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

export default function CmsReconstructorModule({ onLog }: Props) {
  const api = (window as any).api;

  // Config
  const [serverName, setServerName]       = useState('');
  const [domainsRaw, setDomainsRaw]       = useState('');
  const [localZipPath, setLocalZipPath]   = useState('');
  const [targetPhpVersion, setTargetPhpVersion] = useState('Mantener actual');
  const [mode, setMode]                   = useState<CmsMode>('full');
  const [dryRun, setDryRun]               = useState(false);
  const [phpSwitch, setPhpSwitch]         = useState(false);
  const [servers, setServers]             = useState<string[]>([]);

  // Lista negra: plugins excluidos (deshabilitados de la purga, para conservarlos)
  const [excludedBlacklistSlugs, setExcludedBlacklistSlugs] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('kraken_excluded_blacklist_slugs');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const toggleBlacklistSlug = (slug: string) => {
    setExcludedBlacklistSlugs(prev => {
      const next = prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug];
      try {
        localStorage.setItem('kraken_excluded_blacklist_slugs', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Elementor Pro auto-detectado desde configuración
  const [elementorConfig, setElementorConfig] = useState<{ zipPath: string; licenseKey: string } | null>(null);

  // Versions
  const [versionesPHP, setVersionesPHP]   = useState<any[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);

  // Runtime
  const [isRunning, setIsRunning]         = useState(false);
  const [entries, setEntries]             = useState<DomainEntry[]>([]);
  const [openDomains, setOpenDomains]     = useState<Set<string>>(new Set());
  const [filterFailed, setFilterFailed]   = useState(false);
  const [globalMsg, setGlobalMsg]         = useState('');

  // Stats
  const succeeded   = entries.filter(e => e.status === 'success').length;
  const failed      = entries.filter(e => e.status === 'error').length;
  const running     = entries.filter(e => e.status === 'running').length;
  const total       = entries.length;
  const visibleEntries = filterFailed ? entries.filter(e => e.status === 'error') : entries;

  // Parsed domains from textarea
  const parsedDomains = domainsRaw
    .split(/[\n,;]+/)
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);

  // Hydrate servers list + elementor config
  useEffect(() => {
    api?.invoke('config:get').then((cfg: any) => {
      if (cfg?.destinationServers) {
        setServers(cfg.destinationServers.map((s: any) => s.name));
        if (cfg.destinationServers.length > 0) setServerName(cfg.destinationServers[0].name);
      }
      // Leer Elementor Pro desde config
      if (cfg?.elementorPro?.zipPath) {
        setElementorConfig({
          zipPath:    cfg.elementorPro.zipPath,
          licenseKey: cfg.elementorPro.licenseKey || '',
        });
      }
    }).catch(() => {});

    // Hydrate persisted state
    api?.invoke('cms:get-state').then((res: any) => {
      if (!res?.state) return;
      const s = res.state;
      if (s.history?.length > 0) {
        setEntries(s.history.map((h: any) => ({
          domain: h.domain,
          status: h.status === 'success' ? 'success' : 'error',
          steps: h.error ? [{ msg: h.error, level: 'error' }] : [],
          error: h.error,
          duration: h.duration,
        })));
      }
      if (s.isRunning) setIsRunning(true);
    }).catch(() => {});
  }, []);

  // Hydrate PHP versions when server changes (not needed for flush mode but kept for other modes)
  useEffect(() => {
    if (!serverName || mode === 'flush-permalinks') {
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
      .catch(() => setVersionesPHP([]))
      .finally(() => setIsLoadingVersions(false));
  }, [serverName, mode]);

  // Fix: solo procesar eventos si este módulo inició el batch
  const batchOwner = useRef(false);

  // cms:progress listener
  useEffect(() => {
    const handler = (event: CmsProgress) => {
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
        batchOwner.current = false;
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
          const stepMsg = { msg: event.msg || 'Subiendo Plugin...', level: event.level || 'info' };
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

  const handleStart = useCallback(async () => {
    if (!parsedDomains.length || !serverName) return;

    batchOwner.current = true;
    setEntries(parsedDomains.map(domain => ({ domain, status: 'idle', steps: [] })));
    setOpenDomains(new Set());
    setFilterFailed(false);
    setGlobalMsg('');

    let res: any;

    if (mode === 'flush-permalinks') {
      res = await api?.invoke('cms:flush-permalinks', { serverName, domains: parsedDomains });
    } else {
      res = await api?.invoke('cms:start-batch', {
        serverName,
        domains: parsedDomains,
        localZipPath: localZipPath || null,
        targetPhpVersion,
        mode,
        dryRun,
        phpSwitch,
        excludedBlacklistSlugs,
      });
    }

    if (!res?.success) {
      batchOwner.current = false;
      setGlobalMsg(`Error: ${res?.error || 'No se pudo iniciar'}`);
      onLog(`[CMS] ${res?.error}`, 'error');
    }
  }, [serverName, parsedDomains, localZipPath, targetPhpVersion, mode, dryRun, phpSwitch, excludedBlacklistSlugs, onLog]);

  const handleAbort = useCallback(async () => {
    await api?.invoke('cms:abort');
    setIsRunning(false);
  }, []);

  const handlePickZip = useCallback(async () => {
    const result = await api?.invoke('dialog:open-file', {
      title: 'Seleccionar ZIP Plugin',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (result?.filePath) setLocalZipPath(result.filePath);
  }, []);

  const toggleDomain = useCallback((domain: string) => {
    setOpenDomains(prev => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }, []);

  const exportCsv = useCallback(() => {
    const rows = ['dominio,estado,duracion_s,error'];
    entries.forEach(e => {
      rows.push([e.domain, e.status, ((e.duration || 0) / 1000).toFixed(1), e.error || ''].join(','));
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cms-reconstructor-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [entries]);

  const canStart = !!serverName && parsedDomains.length > 0 && !isRunning && (mode === 'flush-permalinks' || !isLoadingVersions);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">

      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-md">
          <div>
            <h2 className="font-display-lg text-display-lg text-secondary mb-xs">CMS Reconstructor</h2>
            <p className="font-body-md text-on-surface-variant max-w-2xl">
              Reconstrucción industrial de WordPress — hasta 600 dominios. Core, Seguridad, Full, o Permalinks.
            </p>
          </div>
          <div className="flex gap-sm shrink-0">
            {entries.length > 0 && (
              <button onClick={exportCsv}
                className="flex items-center gap-xs px-md py-sm font-label-caps text-label-caps bg-surface-container-highest text-on-surface-variant rounded border border-outline-variant hover:bg-surface-bright transition-all active:scale-95">
                Exportar CSV
              </button>
            )}
            {isRunning ? (
              <button onClick={handleAbort}
                className="flex items-center gap-xs px-md py-sm font-title-sm bg-error/20 text-error hover:bg-error/30 rounded border border-error/50 transition-all active:scale-95">
                ⛔ Abortar
              </button>
            ) : (
              <button onClick={handleStart} disabled={!canStart}
                className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${
                  canStart
                    ? 'bg-secondary-container text-on-secondary-container hover:brightness-110'
                    : 'bg-surface-container-highest text-outline cursor-not-allowed'
                }`}>
                {isLoadingVersions && mode !== 'flush-permalinks' ? '⏳ Cargando...' : '▶ Iniciar'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg space-y-md">

        {/* ── Progress Dashboard ── */}
        {entries.length > 0 && (
          <div className="bg-surface-container-low border border-outline-variant p-md">
            <div className="grid grid-cols-4 gap-md text-center">
              <div>
                <div className="font-display text-2xl text-on-surface">{total}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">TOTAL</div>
              </div>
              <div>
                <div className="font-display text-2xl text-green-400">{succeeded}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">OK</div>
              </div>
              <div>
                <div className="font-display text-2xl text-error">{failed}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">ERROR</div>
              </div>
              <div>
                <div className="font-display text-2xl text-secondary">{running}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">ACTIVOS</div>
              </div>
            </div>
            {total > 0 && (
              <div className="mt-md w-full bg-surface-container-highest h-1.5 rounded-full overflow-hidden">
                <div className="h-full transition-all duration-500"
                  style={{
                    width: `${((succeeded + failed) / total) * 100}%`,
                    backgroundColor: failed > 0 ? '#ff5252' : '#33d9b2',
                  }} />
              </div>
            )}
            {globalMsg && (
              <p className="font-code-sm text-code-sm text-outline mt-sm text-center">{globalMsg}</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-md">

          {/* ── Config Panel ── */}
          <div className="bg-surface-container-low border border-outline-variant p-md space-y-md h-fit">
            <h2 className="font-label-caps text-label-caps text-outline uppercase">Configuración</h2>

            {/* Servidor destino */}
            <div className="space-y-xs">
              <label className="font-label-caps text-label-caps text-outline">Servidor Plesk</label>
              <select value={serverName} onChange={e => setServerName(e.target.value)}
                className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm">
                <option value="">— Selecciona servidor —</option>
                {servers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Modo */}
            <div className="space-y-xs">
              <label className="font-label-caps text-label-caps text-outline">Modo</label>
              <div className="grid grid-cols-2 gap-xs">
                {(['full', 'core-only', 'security-only', 'solo-plugin', 'flush-permalinks'] as CmsMode[]).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className={`font-label-caps text-[10px] px-sm py-sm rounded border transition-all ${
                      mode === m
                        ? 'bg-secondary-container/20 text-secondary border-secondary/50'
                        : 'bg-surface-container text-outline border-outline-variant hover:border-outline'
                    } ${m === 'flush-permalinks' ? 'col-span-2' : ''}`}>
                    {MODE_LABELS[m]}
                  </button>
                ))}
              </div>
              <p className="font-body-sm text-[11px] text-on-surface-variant leading-snug pt-xs">
                {MODE_DESCRIPTIONS[mode]}
              </p>
            </div>

            {/* Versión PHP Destino — oculta en modo flush */}
            {mode !== 'flush-permalinks' && (
              <div className="space-y-xs">
                <label className="font-label-caps text-label-caps text-outline flex justify-between">
                  <span>Versión PHP Destino</span>
                  {isLoadingVersions && <span className="animate-pulse text-secondary">Cargando...</span>}
                </label>
                <select value={targetPhpVersion} onChange={e => setTargetPhpVersion(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm disabled:opacity-50"
                  disabled={isLoadingVersions || versionesPHP.length === 0}>
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
            )}

            {/* ── Panel de Plugins — solo si aplica ── */}
            {(mode === 'full' || mode === 'solo-plugin') && (
              <div className="space-y-sm pt-xs border-t border-outline-variant/40">
                <label className="font-label-caps text-label-caps text-outline">Plugins</label>

                {/* Elementor Pro — auto desde config */}
                <div className={`flex items-start gap-sm p-sm rounded border ${
                  elementorConfig
                    ? 'border-secondary/30 bg-secondary/5'
                    : 'border-outline-variant bg-surface-container'
                }`}>
                  <span className={`mt-px text-[11px] font-bold shrink-0 ${
                    elementorConfig ? 'text-secondary' : 'text-outline'
                  }`}>{elementorConfig ? '✓' : '–'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-label-caps text-[10px] text-on-surface">
                      Elementor Pro
                      {elementorConfig
                        ? <span className="ml-sm text-secondary font-normal">desde config</span>
                        : <span className="ml-sm text-outline font-normal">no configurado</span>
                      }
                    </p>
                    {elementorConfig && (
                      <p className="font-code-sm text-[10px] text-outline mt-[2px] truncate">
                        {elementorConfig.zipPath.split(/[\\/]/).pop()}
                        {elementorConfig.licenseKey && (
                          <span className="ml-sm text-on-surface-variant">• key: {elementorConfig.licenseKey.slice(0, 6)}••••••</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>

                {/* ZIP adicional */}
                <div className="space-y-xs">
                  <label className="font-label-caps text-[10px] text-outline">ZIP adicional (opcional)</label>
                  <div className="flex gap-sm">
                    <input type="text" value={localZipPath} onChange={e => setLocalZipPath(e.target.value)}
                      placeholder="Seleccionar .zip..."
                      className="w-full bg-surface-container border border-outline-variant text-on-surface font-code-sm text-[11px] px-sm py-xs rounded" readOnly />
                    <button onClick={handlePickZip}
                      className="px-sm py-xs bg-surface-container-highest border border-outline-variant rounded hover:bg-surface-bright transition-colors text-on-surface-variant shrink-0">
                      <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    </button>
                    {localZipPath && (
                      <button onClick={() => setLocalZipPath('')}
                        className="px-xs py-xs text-outline hover:text-error transition-colors text-[11px] shrink-0">
                        ×
                      </button>
                    )}
                  </div>
                </div>

                {/* Lista negra — configurable */}
                <div className="space-y-xs pt-xs border-t border-outline-variant/30">
                  <div className="flex items-center justify-between">
                    <label className="font-label-caps text-[10px] text-outline">
                      Lista negra de plugins
                    </label>
                    <span className="text-[9px] font-mono text-on-surface-variant">
                      {excludedBlacklistSlugs.length > 0
                        ? `${excludedBlacklistSlugs.length} conservado(s)`
                        : 'Todos a purgar'}
                    </span>
                  </div>
                  <p className="text-[9px] text-on-surface-variant leading-snug">
                    Marcados se purgan. Desmarcá para conservarlos intactos en el sitio:
                  </p>
                  <div className="space-y-1 pt-0.5">
                    {BLACKLIST_PLUGINS.map(p => {
                      const isPurged = !excludedBlacklistSlugs.includes(p.slug);
                      return (
                        <label
                          key={p.slug}
                          className={`flex items-center justify-between gap-xs py-1 px-2 rounded border transition-all cursor-pointer select-none ${
                            isPurged
                              ? 'bg-surface-container/50 border-outline-variant/30 hover:border-error/40'
                              : 'bg-surface-container-low border-secondary/40 hover:border-secondary/60'
                          }`}
                        >
                          <div className="flex items-center gap-xs min-w-0">
                            <input
                              type="checkbox"
                              checked={isPurged}
                              onChange={() => toggleBlacklistSlug(p.slug)}
                              className="w-3.5 h-3.5 rounded border-outline-variant bg-surface-container text-secondary focus:ring-secondary cursor-pointer shrink-0"
                            />
                            <span
                              className={`font-code-sm text-[10px] truncate transition-colors ${
                                isPurged
                                  ? 'text-on-surface font-medium'
                                  : 'text-on-surface-variant'
                              }`}
                              title={p.name}
                            >
                              {p.name}
                            </span>
                          </div>
                          <span
                            className={`text-[9px] font-mono px-1.5 py-0.5 rounded border font-semibold shrink-0 ${
                              isPurged
                                ? 'border-error/30 text-error bg-error/10'
                                : 'border-secondary/40 text-secondary bg-secondary/10'
                            }`}
                          >
                            {isPurged ? 'Purgar' : 'Conservar'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Opciones avanzadas — ocultas en modo flush */}
            {mode !== 'flush-permalinks' && (
              <div className="space-y-sm pt-xs border-t border-outline-variant/40">
                <label className="flex items-center gap-sm cursor-pointer group">
                  <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)}
                    className="w-4 h-4 rounded border-outline-variant bg-surface-container text-secondary focus:ring-secondary cursor-pointer" />
                  <span className="font-label-caps text-label-caps text-outline group-hover:text-on-surface-variant transition-colors">Dry Run (sin cambios reales)</span>
                </label>
                <label className="flex items-center gap-sm cursor-pointer group">
                  <input type="checkbox" checked={phpSwitch} onChange={e => setPhpSwitch(e.target.checked)}
                    className="w-4 h-4 rounded border-outline-variant bg-surface-container text-secondary focus:ring-secondary cursor-pointer" />
                  <span className="font-label-caps text-label-caps text-outline group-hover:text-on-surface-variant transition-colors">Cambiar versión PHP</span>
                </label>
              </div>
            )}
          </div>

          {/* ── Domain Input Panel ── */}
          <div className="bg-surface-container-low border border-outline-variant flex flex-col min-h-[300px]">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-label-caps text-label-caps text-on-surface">
                Lista de Dominios
                {parsedDomains.length > 0 && (
                  <span className="ml-sm text-secondary">({parsedDomains.length})</span>
                )}
              </span>
              {parsedDomains.length > 0 && (
                <button onClick={() => setDomainsRaw('')}
                  className="font-label-caps text-label-caps text-outline hover:text-error transition-colors text-[10px]">
                  Limpiar
                </button>
              )}
            </div>

            <div className="flex-1 flex flex-col p-md gap-sm">
              <textarea
                value={domainsRaw}
                onChange={e => setDomainsRaw(e.target.value)}
                placeholder={"Pega los dominios aquí — uno por línea:\n\ndominio1.com\ndominio2.es\ndominio3.net"}
                className="flex-1 w-full min-h-[220px] bg-surface-container border border-outline-variant text-on-surface font-code-sm text-[12px] px-md py-sm rounded resize-none focus:border-secondary focus:ring-1 focus:ring-secondary focus:outline-none placeholder:text-outline placeholder:italic leading-relaxed"
                spellCheck={false}
                disabled={isRunning}
              />
              {parsedDomains.length > 0 && (
                <p className="font-code-sm text-[11px] text-outline">
                  {parsedDomains.length} dominio{parsedDomains.length !== 1 ? 's' : ''} detectado{parsedDomains.length !== 1 ? 's' : ''}
                  {mode === 'flush-permalinks' && <span className="text-secondary ml-sm">→ wp rewrite flush --hard</span>}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Terminal Accordion (Per Domain Logs) ── */}
        {entries.length > 0 && (
          <div className="bg-surface-container-low border border-outline-variant flex flex-col">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-title-sm text-on-surface">Progreso por dominio</span>
              <label className="flex items-center gap-sm cursor-pointer">
                <input type="checkbox" checked={filterFailed} onChange={e => setFilterFailed(e.target.checked)}
                  className="accent-secondary" />
                <span className="font-label-caps text-label-caps text-outline">
                  Ver solo fallidos ({failed})
                </span>
              </label>
            </div>

            <div className="divide-y divide-outline-variant/30">
              {visibleEntries.map(entry => (
                <div key={entry.domain} className="bg-surface-container-lowest">
                  {/* Accordion header */}
                  <button
                    onClick={() => toggleDomain(entry.domain)}
                    className="w-full flex items-center gap-md px-md py-sm text-left hover:bg-surface-container-high transition-colors">
                    <StatusBadge status={entry.status} />
                    <span className="font-code-md text-code-md text-on-surface flex-1">{entry.domain}</span>
                    {entry.duration && (
                      <span className="font-code-sm text-code-sm text-outline">
                        {(entry.duration / 1000).toFixed(1)}s
                      </span>
                    )}
                    <span className="text-outline text-[10px]">
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
                        className="overflow-hidden">
                        <div className="bg-black border-t border-outline-variant/50 p-md font-code-sm text-code-sm overflow-y-auto max-h-60 space-y-[2px] scanline-effect">
                          {entry.steps.length === 0 ? (
                            <p className="text-outline italic">Esperando inicio...</p>
                          ) : entry.steps.map((step, i) => {
                            const colorClass =
                              step.level === 'error'   ? 'text-error' :
                              step.level === 'success' ? 'text-green-400' :
                              step.level === 'warn'    ? 'text-tertiary' :
                              'text-on-surface-variant';
                            return (
                              <p key={i} className={`leading-relaxed break-all ${colorClass}`}>
                                {step.msg}
                              </p>
                            );
                          })}
                          {entry.status === 'running' && (
                            <p className="text-secondary animate-pulse mt-sm">▌ Procesando...</p>
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
