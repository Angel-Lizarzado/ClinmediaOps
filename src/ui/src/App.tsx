import { useState, useCallback, useEffect, useRef } from 'react';
import MainLayout from './components/MainLayout';
import Dashboard from './components/Dashboard';
import SyncDnsModule from './components/SyncDnsModule';
import ExtractionModule from './components/ExtractionModule';
import DeploymentModule from './components/DeploymentModule';
import ProvisioningModule from './components/ProvisioningModule';
import ConfigPanel from './components/ConfigPanel';
import MalwareScannerModule from './components/MalwareScannerModule';
import HardeningModule from './components/HardeningModule';
import SourceSyncModule from './components/SourceSyncModule';
import SecurityModule from './components/SecurityModule';
import CmsReconstructorModule from './components/CmsReconstructorModule';
import RescueSorterModule from './components/RescueSorterModule';
import { ToastProvider } from './components/Toast';
import UpdateNotifier from './components/UpdateNotifier';
import { ConfigProvider } from './contexts/ConfigContext';
import { AppStateProvider } from './contexts/AppStateContext';
import { useIpc } from './hooks/useIpc';
import { useLogBuffer } from './hooks/useLogBuffer';
import type { LogLevel } from './types/ipc';

// ── Persistent module IDs ─────────────────────────────────────────────────────
// All modules mount once and stay mounted. Tab switching only toggles display
// via CSS, preserving all React state (hooks, timers, IPC listeners).
const PERSISTENT_MODULE_IDS = [
  'dashboard',
  'syncdns',
  'extraction',
  'migration',
  'provisioning',
  'config',
  'validation',
  'hardening',
  'sourcesync',
  'security',
  'cms',
  'rescuesorter',
] as const;

type ModuleId = typeof PERSISTENT_MODULE_IDS[number];

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const { isConnected, progressEvents } = useIpc();
  const [activeModule, setActiveModule] = useState<ModuleId>('dashboard');

  const { entries: logEntries, clear: clearLogs } = useLogBuffer();

  const progressLenRef = useRef(0);
  useEffect(() => {
    if (progressEvents.length <= progressLenRef.current) return;
    progressLenRef.current = progressEvents.length;
  }, [progressEvents.length]);

  const handleModuleChange = useCallback((moduleId: string) => {
    if (PERSISTENT_MODULE_IDS.includes(moduleId as ModuleId)) {
      setActiveModule(moduleId as ModuleId);
    }
  }, []);

  // logToConsole: compatibility shim for modules that accept onLog prop.
  // Real logs flow via log:batch IPC from the Main Process.
  const logToConsole = useCallback((_message: string, _type: LogLevel = 'info') => {}, []);

  // Logs filtered by module for per-module terminals
  const getModuleLogs = useCallback((moduleId: string) =>
    logEntries.filter(e => e.module === moduleId || !e.module),
    [logEntries]
  );

  void isConnected;
  void clearLogs;

  return (
    <ConfigProvider>
      <AppStateProvider>
        <ToastProvider>
          <MainLayout activeModule={activeModule as string} setActiveModule={(m) => handleModuleChange(m)}>
            <UpdateNotifier />
            {/*
              Persistence strategy: ALL modules are mounted simultaneously.
              Only the active module has display !== 'none'.
              - React keeps all internal state intact (hooks, timers, refs).
              - IPC listeners keep working in the background.
              - Navigation between tabs preserves all progress and log history.
              - No AnimatePresence/key (that causes destructive remount).
              - Modules are shown/hidden via conditional Tailwind classes (flex vs hidden).
            */}
            <div className="relative min-h-0 flex-1 flex flex-col">

              <ModulePane id="dashboard" activeModule={activeModule}>
                <Dashboard onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="syncdns" activeModule={activeModule}>
                <SyncDnsModule onLog={logToConsole} logs={getModuleLogs('syncdns')} />
              </ModulePane>

              <ModulePane id="extraction" activeModule={activeModule}>
                <ExtractionModule onLog={logToConsole} logs={getModuleLogs('extraction')} />
              </ModulePane>

              <ModulePane id="migration" activeModule={activeModule}>
                <DeploymentModule onLog={logToConsole} logs={getModuleLogs('migration')} />
              </ModulePane>

              <ModulePane id="provisioning" activeModule={activeModule}>
                <ProvisioningModule onLog={logToConsole} logs={getModuleLogs('provisioning')} />
              </ModulePane>

              <ModulePane id="config" activeModule={activeModule}>
                <ConfigPanel onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="validation" activeModule={activeModule}>
                <MalwareScannerModule onLog={logToConsole} logs={getModuleLogs('validation')} />
              </ModulePane>

              <ModulePane id="hardening" activeModule={activeModule}>
                <HardeningModule onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="sourcesync" activeModule={activeModule}>
                <SourceSyncModule onLog={logToConsole} logs={getModuleLogs('sourcesync')} />
              </ModulePane>

              <ModulePane id="security" activeModule={activeModule}>
                <SecurityModule onLog={logToConsole} logs={getModuleLogs('security')} />
              </ModulePane>

              <ModulePane id="cms" activeModule={activeModule}>
                <CmsReconstructorModule onLog={logToConsole} logs={getModuleLogs('cms')} />
              </ModulePane>

              <ModulePane id="rescuesorter" activeModule={activeModule}>
                <RescueSorterModule logs={getModuleLogs('rescuesorter')} />
              </ModulePane>

            </div>
          </MainLayout>
        </ToastProvider>
      </AppStateProvider>
    </ConfigProvider>
  );
}

// ── ModulePane ────────────────────────────────────────────────────────────────
interface ModulePaneProps {
  id: string;
  activeModule: string;
  children: React.ReactNode;
}

function ModulePane({ id, activeModule, children }: ModulePaneProps) {
  const isActive = id === activeModule;
  return (
    <div className={isActive ? 'flex-1 flex flex-col min-h-0 overflow-hidden' : 'hidden'}>
      {children}
    </div>
  );
}
