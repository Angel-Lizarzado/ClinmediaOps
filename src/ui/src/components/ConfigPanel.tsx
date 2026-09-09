import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useToast } from './Toast';
import { RefreshCw, TriangleAlert, Webhook, CloudUpload, ShieldAlert, Key, Award, FileArchive, Mail } from 'lucide-react';

interface ScanResult {
  workspaceRoot: string;
  accounts: Array<{
    name: string;
    clouds: Array<{ name: string; domains: string[] }>;
  }>;
}

interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
}

interface ConfigPanelProps {
  onLog: (message: string, type: LogEntry['type'], moduleId?: string) => void;
}

const ConfigPanel: React.FC<ConfigPanelProps> = ({ onLog }) => {
  const { config, loadConfig, scanWorkspace, getCloudflareToken, setCloudflareToken, generateSshKey } = useIpc();
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [cfTokenDisplay, setCfTokenDisplay] = useState('');
  const [cfTokenInput, setCfTokenInput] = useState('');
  const [savingCfToken, setSavingCfToken] = useState(false);
  const [cfAccountIdInput, setCfAccountIdInput] = useState('');
  const [savingCfAccountId, setSavingCfAccountId] = useState(false);
  const [ghTokenDisplay, setGhTokenDisplay] = useState('');
  const [ghTokenInput, setGhTokenInput] = useState('');
  const [savingGhToken, setSavingGhToken] = useState(false);
  const [sslEmailInput, setSslEmailInput] = useState('');
  const [savingSslEmail, setSavingSslEmail] = useState(false);
  const [masterPasswordInput, setMasterPasswordInput] = useState('');
  const [hasMasterPassword, setHasMasterPassword] = useState(false);
  const [savingMasterPassword, setSavingMasterPassword] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [driveConfig, setDriveConfig] = useState({ credentialsPath: '', rootFolderId: '' });
  const [selectedSyncTarget, setSelectedSyncTarget] = useState<string>('ALL');
  const [driveLogs, setDriveLogs] = useState<{msg: string, type: string, time: number}[]>([]);
  const [respaldosPath, setRespaldosPath] = useState<string>('');
  const [changingFolder, setChangingFolder] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const loadedRef = useRef(false);
  
  const [isOAuthAuthenticated, setIsOAuthAuthenticated] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [hostingerMailToken, setHostingerMailToken] = useState('');
  const [hostingerMailTokenDisplay, setHostingerMailTokenDisplay] = useState('');
  const [savingMailToken, setSavingMailToken] = useState(false);


  const handleScan = useCallback(async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const result: unknown = await scanWorkspace();
      if (typeof result === 'object' && result !== null && 'success' in result && (result as Record<string, unknown>).success) {
        setScanResult(result as unknown as ScanResult);
        await loadConfig();
        const scanData = result as unknown as ScanResult;
        const totalAccounts = scanData.accounts?.length || 0;
        const totalClouds = scanData.accounts?.reduce((t: number, a: { clouds?: Array<unknown> }) => t + (a.clouds?.length || 0), 0) || 0;
        onLog(`Escaneo completado en ${scanData.workspaceRoot}. Se han sincronizado ${totalAccounts} cuentas y ${totalClouds} clouds.`, 'success', 'config');
      } else {
        onLog(`Error al escanear workspace: ${(result as Record<string, unknown>).error ?? 'Error desconocido'}`, 'error', 'config');
      }
    } catch (err: unknown) {
      onLog(`Error al escanear workspace: ${err instanceof Error ? err.message : String(err)}`, 'error', 'config');
    } finally {
      setScanning(false);
    }
  }, [scanWorkspace, onLog, loadConfig]);

  // Load obfuscated token on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      const api = (window as any).api;
      if (!api) return;
      // Cargar CF token
      const result = await getCloudflareToken();
      if (result.success) {
        setCfTokenDisplay(result.obfuscated || '');
        setCfTokenInput(result.token || '');
      }
      // Cargar GitHub token
      try {
        const api = (window as any).api;
        if (api) {
          const ghResult = await api.invoke('config:get-github-token');
          if (ghResult?.success) {
            setGhTokenDisplay(ghResult.obfuscated || '');
            setGhTokenInput(ghResult.token || '');
          }

          // Cargar SSL email
          const sslResult = await api.invoke('config:get-ssl-email');
          if (sslResult?.success) {
            setSslEmailInput(sslResult.email || '');
          }

          // Cargar existencia de Master Password
          const pwResult = await api.invoke('correo:contrasena:existe');
          if (pwResult?.exito) {
            setHasMasterPassword(pwResult.existe);
          }
          
          // Cargar Cloudflare Account ID
          const accountIdResult = await api.invoke('config:get-cloudflare-account-id');
          if (accountIdResult?.success) {
            setCfAccountIdInput(accountIdResult.accountId || '');
          }
          
          // Cargar Drive config
          const dConf = await api.invoke('config:get-google-drive');
          if (dConf?.success && dConf.googleDrive) {
            setDriveConfig(dConf.googleDrive);
          }

          // Cargar Email (Hostinger Mail) token
          const emailConf = await api.invoke('email:get-config');
          if (emailConf?.success) {
            setHostingerMailTokenDisplay(emailConf.obfuscated || '');
          }

          // Cargar Elementor Pro config
          const epConf = await api.invoke('config:get');
          if (epConf?.elementorPro) {
            if (epConf.elementorPro.zipPath)    setEpZipPath(epConf.elementorPro.zipPath);
            if (epConf.elementorPro.licenseKey) setEpLicenseKey(epConf.elementorPro.licenseKey);
          }
        }
      } catch { /* silencioso */ }
      // Cargar workspace path actual
      try {
        const wp = await api.invoke('workspace:get-path');
        if (wp?.success) {
          setWorkspacePath(wp.workspacePath || '');
          setRespaldosPath(wp.respaldosPath || '');
        }
      } catch { /* silencioso */ }
    })();
  }, [getCloudflareToken]);

  useEffect(() => {
    // Listen to Drive Sync Logs
    let cleanupDriveLog: () => void;
    let cleanupSyncComplete: () => void;
    const api = (window as any).api;
    try {
      if (api.receive) {
        cleanupDriveLog = api.receive('drive:log', (data: any) => {
          setDriveLogs(prev => {
            const next = [...prev, { msg: data.msg, type: data.type || 'info', time: Date.now() }];
            return next.length > 200 ? next.slice(next.length - 200) : next;
          });
        });
        
        cleanupSyncComplete = api.receive('drive:sync-complete', (data: any) => {
          setIsDriveSyncing(false);
          if (!data?.success) {
            setDriveLogs(prev => [...prev, { msg: `Sync Failed: ${data?.error || 'Unknown error'}`, type: 'error', time: Date.now() }]);
          } else {
            setDriveLogs(prev => [...prev, { msg: `Sincronización finalizada exitosamente.`, type: 'success', time: Date.now() }]);
          }
        });
      }
    } catch (err) { console.error('Error attaching drive IPC listeners:', err); }

    return () => {
      if (cleanupDriveLog) cleanupDriveLog();
      if (cleanupSyncComplete) cleanupSyncComplete();
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current && autoScroll) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [driveLogs.length, autoScroll]);

  const handleTerminalScroll = () => {
    if (!terminalRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = terminalRef.current;
    const isBottom = scrollHeight - scrollTop - clientHeight < 20;
    setAutoScroll(isBottom);
  };

  const handleSaveCfToken = useCallback(async () => {
    const trimmed = cfTokenInput.trim();
    if (!trimmed) {
      onLog('No se puede guardar un token vacío. Ingrese un API Token de Cloudflare válido.', 'warning', 'config');
      return;
    }
    setSavingCfToken(true);
    try {
      const result = await setCloudflareToken(trimmed);
      if (result.success) {
        // Reload the obfuscated display
        const fresh = await getCloudflareToken();
        if (fresh.success) setCfTokenDisplay(fresh.obfuscated);
        onLog('[CONFIG] API Token de Cloudflare actualizado y encriptado.', 'success', 'config');
      } else {
        const errMsg = result.error || 'Error desconocido del backend';
        onLog(`Error al guardar token Cloudflare: ${errMsg}`, 'error', 'config');
        console.error('[CF-TOKEN-UI] Error del backend:', errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Error desconocido en la comunicación IPC';
      onLog(`Error al guardar token Cloudflare: ${errMsg}`, 'error', 'config');
      console.error('[CF-TOKEN-UI] Error en catch:', err?.stack || err);
    } finally {
      setSavingCfToken(false);
    }
  }, [cfTokenInput, setCloudflareToken, getCloudflareToken, onLog]);

  const handleSaveCfAccountId = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = cfAccountIdInput.trim();
    if (!trimmed) {
      onLog('No se puede guardar un Account ID vacío.', 'warning', 'config');
      return;
    }
    setSavingCfAccountId(true);
    try {
      const result = await api?.invoke('config:set-cloudflare-account-id', { accountId: trimmed });
      if (result?.success) {
        toast.success('Cloudflare Account ID guardado.');
        onLog('[CONFIG] Cloudflare Account ID actualizado.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Error desconocido';
        onLog(`Error al guardar Account ID: ${errMsg}`, 'error', 'config');
        toast.error(errMsg);
      }
    } catch (err: any) {
      onLog(`Error al guardar Account ID: ${err?.message}`, 'error', 'config');
      toast.error(err?.message || 'Error inesperado');
    } finally {
      setSavingCfAccountId(false);
    }
  }, [cfAccountIdInput, onLog, toast]);

  const handleSaveGhToken = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = ghTokenInput.trim();
    if (!trimmed) {
      onLog('No se puede guardar un token GitHub vacío.', 'warning', 'config');
      return;
    }
    setSavingGhToken(true);
    try {
      const result = await api?.invoke('config:set-github-token', { token: trimmed });
      if (result?.success) {
        const fresh = await api?.invoke('config:get-github-token');
        if (fresh?.success) setGhTokenDisplay(fresh.obfuscated || '');
        toast.success('GitHub API Token guardado.');
        onLog('[CONFIG] GitHub API Token actualizado y guardado.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Error desconocido';
        onLog(`Error al guardar GitHub token: ${errMsg}`, 'error', 'config');
        toast.error(errMsg);
      }
    } catch (err: any) {
      onLog(`Error al guardar GitHub token: ${err?.message}`, 'error', 'config');
      toast.error(err?.message || 'Error inesperado');
    } finally {
      setSavingGhToken(false);
    }
  }, [ghTokenInput, onLog, toast]);

  const handleSaveSslEmail = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = sslEmailInput.trim();
    setSavingSslEmail(true);
    try {
      const result = await api?.invoke('config:set-ssl-email', { email: trimmed });
      if (result?.success) {
        toast.success('Email SSL guardado correctamente.');
        onLog('[CONFIG] Email para SSL actualizado.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Error desconocido';
        onLog(`Error al guardar Email SSL: ${errMsg}`, 'error', 'config');
        toast.error(errMsg);
      }
    } catch (err: any) {
      onLog(`Error al guardar Email SSL: ${err?.message}`, 'error', 'config');
      toast.error(err?.message || 'Error inesperado');
    } finally {
      setSavingSslEmail(false);
    }
  }, [sslEmailInput, onLog, toast]);

  const handleSaveMasterPassword = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = masterPasswordInput.trim();
    if (!trimmed) {
      toast.error('La contraseña no puede estar vacía.');
      onLog('No se puede guardar una contraseña vacía.', 'warning', 'config');
      return;
    }
    if (!api) {
      toast.error('API no disponible. Reinicia la aplicación.');
      onLog('Error: API bridge no disponible.', 'error', 'config');
      return;
    }
    setSavingMasterPassword(true);
    try {
      const result = await api.invoke('correo:contrasena:guardar', { password: trimmed });
      if (result?.exito) {
        setHasMasterPassword(true);
        setMasterPasswordInput('');
        toast.success('Contraseña Maestra guardada correctamente.');
        onLog('[CONFIG] Contraseña Maestra de Correos actualizada.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Respuesta inesperada del servidor.';
        onLog(`Error al guardar Contraseña Maestra: ${errMsg}`, 'error', 'config');
        toast.error(`Error: ${errMsg}`);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Error inesperado';
      onLog(`Error al guardar Contraseña Maestra: ${errMsg}`, 'error', 'config');
      toast.error(errMsg);
    } finally {
      setSavingMasterPassword(false);
    }
  }, [masterPasswordInput, onLog, toast]);

  // 🔥 HOTFIX v1.6.0: Generate ED25519 SSH key
  const handleGenerateKey = useCallback(async () => {
    setGeneratingKey(true);
    try {
      const result = await generateSshKey();
      if (result.success) {
        toast.success(`Llave generada exitosamente en ${result.path || '~/.ssh/id_ed25519'}`);
        onLog(`Llave SSH generada: ${result.path || '~/.ssh/id_ed25519'}`, 'success', 'config');
        // Auto-discovery: recargar config para que la UI detecte la nueva llave
        await loadConfig();
      } else {
        const errMsg = result.error || 'Error desconocido';
        if (errMsg.includes('YA_EXISTE')) {
          toast.info('Ya existe una llave SSH en ~/.ssh/id_ed25519. No se sobrescribe.');
          onLog('Ya existe una llave SSH. No se sobrescribe por seguridad.', 'warning', 'config');
        } else if (errMsg.includes('SSH_KEYGEN_NOT_FOUND')) {
          toast.error('ssh-keygen no está disponible. Instale OpenSSH Client.');
          onLog(`ssh-keygen no disponible: ${errMsg}`, 'error', 'config');
        } else {
          toast.error(`Error: ${errMsg}`);
          onLog(`Error al generar llave SSH: ${errMsg}`, 'error', 'config');
        }
      }
    } catch (err: any) {
      toast.error(`Error inesperado: ${err.message}`);
      onLog(`Error inesperado al generar llave SSH: ${err.message}`, 'error', 'config');
    } finally {
      setGeneratingKey(false);
    }
  }, [generateSshKey, onLog, toast, loadConfig]);

  // Abre el selector de carpeta nativo y actualiza la ruta de respaldos
  const handleChangeFolder = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;
    setChangingFolder(true);
    try {
      // Abrir el diálogo de carpeta nativo
      const dialogResult = await api.invoke('dialog:open-directory', {
        title: 'Seleccionar directorio de respaldos',
        defaultPath: workspacePath || undefined,
      });

      if (!dialogResult.success) {
        if (!dialogResult.canceled) {
          const errMsg = dialogResult.error || 'La ruta seleccionada no es válida';
          onLog(`[CONFIG] Error al seleccionar carpeta: ${errMsg}`, 'error', 'config');
          toast.error(errMsg);
        }
        return;
      }

      // Guardar la nueva ruta como workspace (respaldos se calcula automáticamente dentro)
      const setResult = await api.invoke('workspace:set-path', { workspacePath: dialogResult.path });
      if (setResult.success) {
        setWorkspacePath(setResult.workspacePath);
        // Recargar el respaldosPath actualizado
        const wpResult = await api.invoke('workspace:get-path');
        if (wpResult?.success) setRespaldosPath(wpResult.respaldosPath || '');
        onLog(`[CONFIG] Directorio de respaldos actualizado: ${setResult.workspacePath}`, 'success', 'config');
        toast.success('Directorio de respaldos actualizado correctamente.');
      } else {
        onLog(`[CONFIG] Error al guardar ruta: ${setResult.error}`, 'error', 'config');
        toast.error(`Error al guardar: ${setResult.error || 'Error desconocido'}`);
      }
    } catch (err: any) {
      onLog(`[CONFIG] Error inesperado al cambiar carpeta: ${err.message}`, 'error', 'config');
      toast.error(`Error inesperado: ${err.message}`);
    } finally {
      setChangingFolder(false);
    }
  }, [workspacePath, onLog, toast]);


  const accountCount = config?.accounts?.length || 0;
  const serverCount = config?.destinationServers?.length || 0;
  const cloudCount = config?.accounts?.reduce((t: number, a: any) => t + (a.originClouds?.length || 0), 0) || 0;


  const [epZipPath, setEpZipPath] = useState<string>('');
  const [epLicenseDisplay, setEpLicenseDisplay] = useState<string>('');
  const [epLicenseKey, setEpLicenseKey] = useState<string>('');
  const [savingEp, setSavingEp] = useState<boolean>(false);
  const [isDriveSyncing, setIsDriveSyncing] = useState<boolean>(false);

  const handleSelectEpZip = useCallback(async () => {
    const api = (window as any).api;
    const res = await api.invoke('dialog:open-file', {
      title: 'Seleccionar ZIP de Elementor Pro',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (!res?.success || !res.filePath) return;

    const newPath = res.filePath;
    setEpZipPath(newPath);

    // Guardar en config
    const current = await api.invoke('config:get');
    const updated = {
      ...current,
      elementorPro: {
        ...(current?.elementorPro || {}),
        zipPath: newPath,
      },
    };
    api.send('config:save', updated);
    toast.success('ZIP de Elementor Pro guardado.');
  }, [toast]);

  const handleSaveEpLicense = useCallback(async () => {
    if (!epLicenseKey.trim()) {
      toast.error('Ingresá una license key válida.');
      return;
    }
    setSavingEp(true);
    const api = (window as any).api;
    try {
      const current = await api.invoke('config:get');
      const updated = {
        ...current,
        elementorPro: {
          ...(current?.elementorPro || {}),
          licenseKey: epLicenseKey.trim(),
        },
      };
      api.send('config:save', updated);
      toast.success('License key guardada.');
    } catch (err: any) {
      toast.error(`Error guardando: ${err.message}`);
    } finally {
      setSavingEp(false);
    }
  }, [epLicenseKey, toast]);

  const handleSyncDriveConfig = useCallback(async () => {
    const api = (window as any).api;
    if (!driveConfig.credentialsPath || !driveConfig.rootFolderId) {
      toast.error('Configura las credenciales y el Root Folder ID primero.');
      return;
    }
    setIsDriveSyncing(true);
    try {
      if (selectedSyncTarget === 'ALL') {
        await api.invoke('drive:start-sync', {});
        toast.success('Sincronización masiva iniciada en segundo plano.');
      } else {
        const [accName, cName] = selectedSyncTarget.split('|');
        await api.invoke('drive:start-sync', { accountName: accName, cloudName: cName });
        toast.success(`Sincronización iniciada para ${cName}.`);
      }
    } catch (err: any) {
      toast.error(`Error iniciando sync: ${err.message}`);
      setIsDriveSyncing(false);
    }
  }, [driveConfig, selectedSyncTarget, toast]);

  useEffect(() => {
    const api = (window as any).api;
    if (driveConfig.credentialsPath) {
      api.invoke('drive:check-auth', driveConfig.credentialsPath).then((res: any) => {
        if (res?.success) setIsOAuthAuthenticated(res.authenticated);
      });
    } else {
      setIsOAuthAuthenticated(false);
    }
  }, [driveConfig.credentialsPath]);

  const handleOAuthLogin = useCallback(async () => {
    const api = (window as any).api;
    setIsAuthenticating(true);
    try {
      const res = await api.invoke('drive:start-auth', driveConfig.credentialsPath);
      if (res?.success) {
        setIsOAuthAuthenticated(true);
        toast.success('Autenticación exitosa.');
      } else {
        toast.error(`Error: ${res?.error}`);
      }
    } catch (e: any) {
      toast.error('Error durante el login OAuth');
    } finally {
      setIsAuthenticating(false);
    }
  }, [driveConfig.credentialsPath, toast]);

  const handleOAuthLogout = useCallback(async () => {
    const api = (window as any).api;
    try {
      await api.invoke('drive:logout', driveConfig.credentialsPath);
      setIsOAuthAuthenticated(false);
      toast.success('Sesión cerrada.');
    } catch (e: any) {
      toast.error('Error al cerrar sesión');
    }
  }, [toast]);

  const handleSelectCredentials = useCallback(async () => {
    const api = (window as any).api;
    try {
      const res = await api.invoke('config:select-drive-credentials', {});
      if (res.success && res.path) {
        setDriveConfig(prev => ({ ...prev, credentialsPath: res.path }));
        toast.success('Credenciales guardadas.');
      }
    } catch (err: any) {
      toast.error(err.message);
    }
  }, [toast]);

  const handleSaveDriveRoot = useCallback(async (val: string) => {
    const api = (window as any).api;
    try {
      await api.invoke('config:set-drive-root', { rootFolderId: val });
      setDriveConfig(prev => ({ ...prev, rootFolderId: val }));
      toast.success('Root Folder ID guardado.');
    } catch (err: any) {
      toast.error(err.message);
    }
  }, [toast]);

  const handleChangeRespaldos = useCallback(async () => {
    toast.info('Cambio de carpeta de respaldos a implementar en breve.');
  }, [toast]);



  return (

    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* ── Header Section ── */}
      <div className="flex-none p-6 border-b" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex-1">
            <h1 className="font-display text-2xl font-bold mb-1 tracking-tight">Global Configuration</h1>
            <p className="text-sm max-w-2xl" style={{ color: '#a5a5a5' }}>
              Manage your infrastructure credentials, cloud storage providers, and security keys from a centralized industrial-grade terminal interface.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <select 
                className="input font-mono text-xs bg-surface-container h-full"
                value={selectedSyncTarget}
                onChange={(e) => setSelectedSyncTarget(e.target.value)}
              >
                <option value="ALL">Sync: ALL Clouds</option>
                {config?.accounts?.map((acc: any) => 
                  acc.originClouds?.map((c: any) => (
                    <option key={`${acc.name}|${c.name}`} value={`${acc.name}|${c.name}`}>
                      {acc.name} / {c.name}
                    </option>
                  ))
                )}
              </select>
              <button 
                onClick={handleSyncDriveConfig}
                disabled={isDriveSyncing}
                className="btn btn--primary flex items-center gap-2 px-6"
                title="Sincronizar"
              >
                <RefreshCw className={`w-4 h-4 ${isDriveSyncing ? 'animate-spin' : ''}`} />
                {selectedSyncTarget === 'ALL' ? 'Sync ALL to Drive' : 'Sync Seleccionado'}
              </button>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider" style={{ color: '#ff5252' }}>
              <TriangleAlert className="w-3.5 h-3.5" />
              Local disk will be purged after sync
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Content Scroll Area ── */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-4 pb-24">
          
          {/* API Integration */}
          <section className="md:col-span-8 card p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b pb-2 mb-2" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded flex items-center justify-center" style={{ backgroundColor: 'oklch(0.7 0.15 260 / 0.1)' }}>
                  <Webhook className="w-5 h-5" style={{ color: '#34ace0' }} />
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm">API Integration</h3>
                  <p className="text-[11px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Third-party service connectivity</p>
                </div>
              </div>
              <div className="px-2 py-0.5 rounded text-[10px] font-mono" style={{ backgroundColor: 'var(--surface-raised)', color: '#34ace0', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                CONNECTED
              </div>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Cloudflare API Token</label>
                <div className="flex gap-2">
                  <input 
                    className="flex-1 input font-mono text-sm" 
                    type="password" 
                    placeholder="••••••••••••••••••••••••"
                    value={cfTokenInput}
                    onChange={(e) => setCfTokenInput(e.target.value)}
                  />
                  <button onClick={handleSaveCfToken} disabled={savingCfToken} className="btn btn--secondary text-xs">
                    {savingCfToken ? 'Guardando...' : 'Save'}
                  </button>
                </div>
                <p className="text-[11px] italic" style={{ color: '#a5a5a5' }}>Used for DNS propagation and SSL challenges.</p>
              </div>
              
              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>GitHub Personal Access Token</label>
                <div className="flex gap-2">
                  <input 
                    className="flex-1 input font-mono text-sm" 
                    type="password" 
                    placeholder="ghp_7x2v93..."
                    value={ghTokenInput}
                    onChange={(e) => setGhTokenInput(e.target.value)}
                  />
                  <button onClick={handleSaveGhToken} disabled={savingGhToken} className="btn btn--secondary text-xs">
                    {savingGhToken ? 'Guardando...' : 'Save'}
                  </button>
                </div>
                <p className="text-[11px] italic" style={{ color: '#a5a5a5' }}>Requires 'repo' and 'workflow' scopes.</p>
              </div>

              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Cloudflare Account ID</label>
                <div className="flex gap-2">
                  <input 
                    className="flex-1 input font-mono text-sm" 
                    type="text" 
                    placeholder="Optional Account ID"
                    value={cfAccountIdInput}
                    onChange={(e) => setCfAccountIdInput(e.target.value)}
                  />
                  <button onClick={handleSaveCfAccountId} disabled={savingCfAccountId} className="btn btn--secondary text-xs">
                    Save
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-wider flex items-center justify-between" style={{ color: '#a5a5a5' }}>
                  <span>Hostinger Email API Token</span>
                  {hostingerMailTokenDisplay && (
                    <span className="text-[9px] font-mono lowercase" style={{ color: 'oklch(0.75 0.15 220)' }}>
                      ✓ {hostingerMailTokenDisplay}
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  <input 
                    className="flex-1 input font-mono text-sm" 
                    type="password" 
                    placeholder={hostingerMailTokenDisplay || "hPanel API Token..."}
                    value={hostingerMailToken}
                    onChange={(e) => setHostingerMailToken(e.target.value)}
                  />
                  <button 
                    onClick={async () => {
                      setSavingMailToken(true);
                      try {
                        const res = await (window as any).api.invoke('email:set-config', { apiToken: hostingerMailToken });
                        if (res?.success) {
                          const conf = await (window as any).api.invoke('email:get-config');
                          setHostingerMailTokenDisplay(conf?.obfuscated || '');
                          setHostingerMailToken('');
                        }
                      } finally {
                        setSavingMailToken(false);
                      }
                    }} 
                    disabled={savingMailToken} 
                    className="btn btn--secondary text-xs"
                  >
                    {savingMailToken ? 'Guardando...' : 'Save'}
                  </button>
                </div>
                <p className="text-[11px] italic" style={{ color: '#a5a5a5' }}>Extracción automática de correos via hPanel API.</p>
              </div>

              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Master Password</label>
                <div className="flex gap-2">
                  <input 
                    className="flex-1 input font-mono text-sm" 
                    type="password" 
                    placeholder="Contraseña Maestra..."
                    value={masterPasswordInput}
                    onChange={(e) => setMasterPasswordInput(e.target.value)}
                  />
                  <button onClick={handleSaveMasterPassword} disabled={savingMasterPassword} className="btn btn--secondary text-xs">
                    Save
                  </button>
                </div>
                <p className="text-[11px] italic" style={{ color: '#a5a5a5' }}>Para creación automática de buzones info@.</p>
              </div>
            </div>
          </section>

          {/* Cloud Storage */}
          <section className="md:col-span-4 card p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b pb-2 mb-2" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded flex items-center justify-center" style={{ backgroundColor: 'oklch(0.7 0.1 80 / 0.1)' }}>
                  <CloudUpload className="w-5 h-5" style={{ color: 'oklch(0.7 0.1 80)' }} />
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm">Cloud Storage</h3>
                  <p className="text-[11px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>G-Drive Automated Backups</p>
                </div>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Local Workspace Folder</label>
                <div className="flex gap-2">
                  <input 
                    className="flex-1 input font-mono text-xs bg-black/50 text-gray-200" 
                    type="text" 
                    readOnly
                    value={workspacePath}
                  />
                  <button onClick={handleChangeFolder} disabled={changingFolder} className="btn btn--secondary text-xs">Cambiar</button>
                </div>
              </div>
              
              {/* --- Configuración Drive --- */}
              <div className="space-y-4 pt-4 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
                <div className="space-y-2">
                  <label className="block text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Drive Credentials (JSON Client OAuth)</label>
                  <div className="flex gap-2">
                    <input 
                      className="flex-1 input font-mono text-xs bg-black/50 text-gray-200" 
                      type="text" 
                      readOnly
                      placeholder="client_secret_xxx.json path..."
                      value={driveConfig.credentialsPath}
                    />
                    <button onClick={handleSelectCredentials} className="btn btn--secondary text-xs">Seleccionar</button>
                  </div>
                  {driveConfig.credentialsPath && (
                    <div className="mt-2 flex items-center justify-between bg-black/30 p-2 rounded border border-white/5">
                      <span className="text-xs font-mono" style={{ color: isOAuthAuthenticated ? '#4ade80' : '#f87171' }}>
                        Estado: {isOAuthAuthenticated ? '🟢 Autenticado con Google' : '🔴 Desconectado'}
                      </span>
                      {isOAuthAuthenticated ? (
                        <button onClick={handleOAuthLogout} className="btn btn--secondary text-xs border-red-500/30 hover:border-red-500 hover:text-red-400">Cerrar Sesión</button>
                      ) : (
                        <button onClick={handleOAuthLogin} disabled={isAuthenticating} className="btn btn--primary text-xs flex items-center gap-2">
                          {isAuthenticating && <RefreshCw className="w-3 h-3 animate-spin" />}
                          Conectar con Google Drive
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="block text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Drive Root Folder ID</label>
                  <div className="flex gap-2">
                    <input 
                      className="flex-1 input font-mono text-xs bg-black/50 text-gray-200" 
                      type="text" 
                      placeholder="Ej. 1cd3KPuEfgoa9crYLqS00JsuIOks7xafh"
                      value={driveConfig.rootFolderId}
                      onChange={(e) => setDriveConfig(prev => ({ ...prev, rootFolderId: e.target.value }))}
                      onBlur={(e) => handleSaveDriveRoot(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Terminal Logs */}
              {(driveLogs.length > 0 || isDriveSyncing) && (
                <div className="mt-4 pt-4 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[10px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Terminal Sync Activity</h4>
                    {isDriveSyncing && <span className="flex items-center gap-1 text-[10px] text-green-400"><RefreshCw className="w-3 h-3 animate-spin"/> Syncing...</span>}
                  </div>
                  <div 
                    ref={terminalRef}
                    onScroll={handleTerminalScroll}
                    className="bg-black p-3 rounded-lg font-mono text-xs overflow-y-auto custom-scrollbar h-48 border border-white/10 shadow-inner"
                  >
                    {driveLogs.map((log, i) => (
                      <div key={i} className="mb-1 break-words">
                        <span className="text-gray-500 mr-2">[{new Date(log.time).toLocaleTimeString()}]</span>
                        <span className={
                          log.type === 'error' ? 'text-red-400' :
                          log.type === 'warning' ? 'text-yellow-400' :
                          log.type === 'success' ? 'text-green-400' :
                          'text-gray-300'
                        }>{log.msg}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2 pt-4 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
                <button onClick={handleScan} disabled={scanning} className="btn w-full flex items-center justify-center gap-2" style={{ border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                  <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
                  {scanning ? 'Escaneando...' : 'Escanear Workspace Local'}
                </button>
              </div>
              
              {scanResult && scanResult.accounts && scanResult.accounts.length > 0 && (
                <div className="mt-4 p-3 rounded" style={{ backgroundColor: 'oklch(0.7 0.1 80 / 0.1)', border: '1px solid oklch(0.7 0.1 80 / 0.2)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'oklch(0.7 0.1 80)' }}>Workspaces Detectados</h4>
                    <span className="text-[10px] font-bold py-0.5 px-2 rounded-full" style={{ backgroundColor: 'oklch(0.7 0.1 80 / 0.2)', color: 'oklch(0.7 0.1 80)' }}>
                      {scanResult.accounts.length}
                    </span>
                  </div>
                  <ul className="space-y-2 max-h-32 overflow-y-auto pr-1 custom-scrollbar">
                    {scanResult.accounts.map((acc, i) => (
                      <li key={i} className="flex items-center justify-between border-b pb-1 last:border-0 last:pb-0" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
                        <span className="text-xs font-bold">{acc.name}</span>
                        <span className="text-[10px] font-mono" style={{ color: '#a5a5a5' }}>
                          {acc.clouds?.length || 0} clouds
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>



          {/* Security Section */}
          <section className="md:col-span-6 card p-4">
            <div className="flex items-center justify-between border-b pb-2 mb-4" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded flex items-center justify-center" style={{ backgroundColor: 'var(--color-error-bg)' }}>
                  <ShieldAlert className="w-5 h-5" style={{ color: '#ff5252' }} />
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm">Security</h3>
                  <p className="text-[11px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>SSH Keys & Authentication</p>
                </div>
              </div>
            </div>
            
            <div className="p-3 rounded mb-4" style={{ backgroundColor: '#000', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs" style={{ color: '#34ace0' }}>ACTIVE KEY</span>
                <span className="text-[10px] font-mono uppercase" style={{ color: '#a5a5a5' }}>
                  {config?.sshKeys?.publicKeyPath ? 'Configured' : 'Missing'}
                </span>
              </div>
              <code className="block text-[11px] font-mono break-all" style={{ color: '#a5a5a5' }}>
                {config?.sshKeys?.publicKeyPath || 'No SSH key configured. Generate one below.'}
              </code>
            </div>
            
            <button 
              onClick={handleGenerateKey} 
              disabled={generatingKey}
              className="btn w-full flex items-center justify-center gap-2"
              style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
            >
              <Key className={`w-4 h-4 ${generatingKey ? 'animate-spin' : ''}`} />
              {generatingKey ? 'Generando...' : 'Generate New ED25519 SSH Key'}
            </button>
          </section>

          {/* Licensing */}
          <section className="md:col-span-6 card p-4">
            <div className="flex items-center justify-between border-b pb-2 mb-4" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded flex items-center justify-center" style={{ backgroundColor: 'oklch(0.7 0.15 65 / 0.1)' }}>
                  <Award className="w-5 h-5" style={{ color: 'oklch(0.7 0.15 65)' }} />
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm">Licensing</h3>
                  <p className="text-[11px] font-mono uppercase tracking-wider" style={{ color: '#a5a5a5' }}>Enterprise Extensions</p>
                </div>
              </div>
            </div>
            
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between p-3 rounded" style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                <div className="flex items-center gap-3">
                  <FileArchive className="w-5 h-5" style={{ color: '#34ace0' }} />
                  <div>
                    <h4 className="text-sm font-bold">Elementor Pro Zip</h4>
                    <p className="text-[11px]" style={{ color: '#a5a5a5' }}>
                      {epZipPath ? epZipPath.split(/[\/]/).pop() : 'No zip selected'}
                    </p>
                  </div>
                </div>
                <button onClick={handleSelectEpZip} className="text-xs font-mono hover:underline" style={{ color: '#34ace0' }}>UPLOAD</button>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 border rounded flex flex-col gap-1" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
                  <span className="text-[10px] font-mono uppercase" style={{ color: '#a5a5a5' }}>License Status</span>
                  <span className="text-sm font-bold">{epLicenseDisplay ? 'Valid' : 'Missing'}</span>
                </div>
                <div className="p-3 border rounded flex flex-col gap-1" style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}>
                  <span className="text-[10px] font-mono uppercase" style={{ color: '#a5a5a5' }}>License Key</span>
                  <div className="flex gap-2">
                    <input 
                      type="password" 
                      className="input font-mono text-[10px] w-full p-1 h-6" 
                      placeholder="XXXX-XXXX..."
                      value={epLicenseKey}
                      onChange={(e) => setEpLicenseKey(e.target.value)}
                    />
                    <button onClick={handleSaveEpLicense} disabled={savingEp} className="btn btn--ghost p-1 text-[10px] h-6">Save</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
};


export default ConfigPanel;
