import React from 'react';
import {
  LayoutDashboard, Rocket, Globe, Archive, Database, LifeBuoy,
  GitMerge, ShieldCheck, Settings, FileText, HelpCircle, Terminal, Bell, Wrench, Shield
} from 'lucide-react';

interface MainLayoutProps {
  children: React.ReactNode;
  activeModule: string;
  setActiveModule: (id: string) => void;
}

// Maps module id → nav label + icon
const NAV_ITEMS = [
  { id: 'dashboard',    icon: LayoutDashboard, label: 'Panel Principal' },
  { id: 'syncdns',      icon: Globe,           label: 'SyncDns' },
  { id: 'extraction',   icon: Archive,         label: 'Extracción' },
  { id: 'migration',    icon: Rocket,          label: 'Migración' },
  { id: 'provisioning', icon: Database,        label: 'DNS -> SSL' },
  { id: 'validation',   icon: ShieldCheck,     label: 'Validación' },
  { id: 'hardening',    icon: Shield,          label: 'Blindaje' },
  { id: 'sourcesync',   icon: GitMerge,        label: 'Git -> Plesk' },
  { id: 'cms',          icon: Wrench,          label: 'Reconstructor' },
  { id: 'rescuesorter', icon: LifeBuoy,        label: 'Organizador Rescue' },
];

const MODULE_TITLES: Record<string, string> = {
  dashboard:    'Panel Principal',
  syncdns:      'SyncDns',
  extraction:   'Extracción',
  migration:    'Migración',
  provisioning: 'DNS -> SSL',
  validation:   'Validación',
  hardening:    'Blindaje',
  sourcesync:   'Git -> Plesk',
  cms:          'Reconstructor',
  rescuesorter: 'Organizador Rescue',
  security:     'Centro de Seguridad',
  config:       'Ajustes del Sistema',
};

const MainLayout: React.FC<MainLayoutProps> = ({ children, activeModule, setActiveModule }) => {
  const [appVersion, setAppVersion] = React.useState('...');

  React.useEffect(() => {
    try {
      const electronAPI = (window as any).electronAPI;
      const api = (window as any).api;
      const getter = electronAPI?.getAppVersion
        ? () => electronAPI.getAppVersion()
        : api?.invoke
          ? () => api.invoke('app:get-version')
          : null;
      if (getter) {
        getter().then((v: string) => setAppVersion(v)).catch(() => setAppVersion('?'));
      }
    } catch {
      setAppVersion('?');
    }
  }, []);

  return (
    <div className="bg-background text-on-surface font-body-md h-screen flex overflow-hidden">

      {/* ── Sidebar ── */}
      <aside className="w-sidebar_width hover:w-sidebar_expanded transition-all duration-300 h-screen bg-surface-container-lowest border-r border-secondary/20 shadow-[1px_0_15px_rgba(192,193,255,0.05)] z-50 flex flex-col overflow-hidden group shrink-0">
        
        {/* Logo */}
        <div className="h-16 flex items-center px-md flex-shrink-0 gap-md">
          <div className="w-8 h-8 bg-secondary rounded flex items-center justify-center shrink-0">
            <Terminal size={16} className="text-on-secondary" />
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
            <p className="font-display-lg text-title-sm font-bold text-secondary">Kraken CLI</p>
            <p className="font-label-caps text-label-caps text-outline">v{appVersion}</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-sm mt-md flex flex-col gap-xs overflow-y-auto">
          {NAV_ITEMS.map(({ id, icon: Icon, label }) => {
            const isActive = activeModule === id;
            return (
              <button
                key={id}
                onClick={() => setActiveModule(id)}
                className={`flex items-center h-10 px-sm rounded text-left transition-colors duration-150 ease-in-out w-full gap-md ${
                  isActive
                    ? 'text-secondary border-l-2 border-secondary bg-secondary-container/10'
                    : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface border-l-2 border-transparent'
                }`}
              >
                <Icon size={20} className="shrink-0" />
                <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap font-body-md">
                  {label}
                </span>
              </button>
            );
          })}

          <div className="my-xs h-[1px] bg-outline-variant/40 mx-sm" />

          {/* Settings — always at bottom of nav */}
          <button
            onClick={() => setActiveModule('config')}
            className={`flex items-center h-10 px-sm rounded text-left transition-colors duration-150 ease-in-out w-full gap-md ${
              activeModule === 'config'
                ? 'text-secondary border-l-2 border-secondary bg-secondary-container/10'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface border-l-2 border-transparent'
            }`}
          >
            <Settings size={20} className="shrink-0" />
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap font-body-md">
              Ajustes
            </span>
          </button>
        </nav>

        {/* Footer links */}
        <div className="px-sm pb-md space-y-xs mt-auto shrink-0">
          <button className="flex items-center h-10 px-sm text-outline hover:text-on-surface transition-colors w-full gap-md">
            <FileText size={20} className="shrink-0" />
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap font-body-md">
              Documentación
            </span>
          </button>
          <button className="flex items-center h-10 px-sm text-outline hover:text-on-surface transition-colors w-full gap-md">
            <HelpCircle size={20} className="shrink-0" />
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap font-body-md">
              Soporte
            </span>
          </button>
        </div>
      </aside>

      {/* ── Main canvas ── */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        
        {/* TopAppBar */}
        <header className="h-16 w-full bg-surface-container border-b border-secondary/20 shadow-[0_1px_15px_rgba(192,193,255,0.05)] flex items-center justify-between px-lg shrink-0 z-40">
          <div className="flex items-center gap-lg">
            <h1 className="font-headline-md text-headline-md font-black tracking-tighter text-on-surface">
              {MODULE_TITLES[activeModule] ?? activeModule}
            </h1>
          </div>
          <div className="flex items-center gap-md">
            <button className="p-xs text-on-surface-variant hover:text-on-surface transition-colors active:scale-95">
              <Bell size={20} />
            </button>
          </div>
        </header>

        {/* Dynamic module content */}
        <main className="flex-1 overflow-hidden flex flex-col bg-background">
          {children}
        </main>

        {/* Footer */}
        <footer className="h-10 border-t border-outline-variant/30 flex items-center justify-between px-lg text-outline font-label-caps text-label-caps shrink-0 bg-surface-container-lowest">
          <div className="flex items-center gap-md">
            <span>
              2026 ©KRAKEN  |  Desarrollado por <a href="https://github.com/Angel-Lizarzado" target="_blank" rel="noreferrer" className="text-secondary hover:underline">Angel Lizarzado</a>
            </span>
          </div>
          <div className="flex items-center gap-xs">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-on-surface">API: EN LÍNEA</span>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default MainLayout;
