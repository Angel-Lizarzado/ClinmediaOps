import { useState, useEffect, useCallback } from 'react';
import { useConfig } from '../contexts/ConfigContext';

// ── Const IPC channels ──
export const IPC_CHANNEL = {
  // Config
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_SAVED: 'config:saved',
  // SSH
  SSH_INJECT_KEY: 'ssh:inject-key',
  SSH_TEST_CONNECTION: 'server:test-connection',
  SSH_GENERATE_KEY: 'ssh:generate-key',
  // Server
  SERVER_DIAGNOSTICS: 'server:diagnostics',
  SERVER_MAINTENANCE: 'server:maintenance',
  SERVER_MAINTENANCE_COMPLETED: 'server:maintenance-completed',
  SERVER_TAIL_LOG: 'server:tail-log',
  SERVER_EXEC_COMMAND: 'server:exec-command',
  // Cloudflare
  CLOUDFLARE_SYNC_DOMAINS: 'cloudflare:sync-domains',
  CLOUDFLARE_GET_ZONES: 'cloudflare:get-zones',
  CONFIG_GET_CLOUDFLARE_TOKEN: 'config:get-cloudflare-token',
  CONFIG_SET_CLOUDFLARE_TOKEN: 'config:set-cloudflare-token',
  // Sync DNS
  SYNCDNS_RUN_BATCH: 'syncdns:run-batch',
  SYNCDNS_LOAD_CSV: 'syncdns:load-csv',
  // Plesk
  PLESK_INSTALL_SSL: 'plesk:install-ssl',
  // Extraction
  GET_EXTRACTION_STATUS: 'get-extraction-status',
  EXTRACTION_CHECK_STATUS: 'extraction:check-status',
  EXTRACTION_RUN_BATCH: 'extraction:run-batch',
  // Deployment
  DEPLOYMENT_GET_PROCESSED_LIST: 'deployment:get-processed-list',
  DEPLOYMENT_RUN_BATCH: 'deployment:run-batch',
  DEPLOYMENT_CHECK_STATUS: 'deployment:check-status',
  // Module
  MODULE_EXECUTE: 'module:execute',
  MODULE_COMPLETED: 'module:completed',
  MODULE_ERROR: 'module:error',
  // Workspace
  WORKSPACE_SCAN: 'workspace:scan',
  WORKSPACE_CREATE_ACCOUNT_FOLDER: 'workspace:create-account-folder',
  WORKSPACE_CREATE_CLOUD_FOLDER: 'workspace:create-cloud-folder',
  // Progress
  PROGRESS_SUBSCRIBE: 'progress:subscribe',
  PROGRESS_UNSUBSCRIBE: 'progress:unsubscribe',
  PROGRESS_UPDATE: 'progress:update',
  CONFIG_UPDATED: 'config:updated',
  // Utils
  UTILS_LOOKUP_HOST: 'utils:lookup-host',
  // Logs
  LOG_BATCH: 'log:batch',
} as const;

export type IpcChannel = (typeof IPC_CHANNEL)[keyof typeof IPC_CHANNEL];

// ── Types ──
export interface IpcApi {
  send: (channel: IpcChannel, data?: unknown) => void;
  receive: (channel: IpcChannel, func: (...args: unknown[]) => void) => void;
  removeListener: (channel: IpcChannel, func: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: IpcChannel) => void;
  invoke: (channel: IpcChannel, data?: unknown) => Promise<unknown>;
}

export interface ProgressEvent {
  module: string;
  domain: string;
  progress: number;
  message: string;
  timestamp: string;
  taskId?: string;
}

export interface InjectKeyResult {
  success: boolean;
  error?: string;
}

export interface IpcInvokeResult<T = unknown> {
  success: boolean;
  error?: string;
  [key: string]: T | boolean | string | undefined;
}

export interface ServerCommandResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface LogResult {
  success: boolean;
  log?: string;
  error?: string;
}

export interface LookupResult {
  success: boolean;
  ip?: string;
  hostName?: string | null;
  error?: string;
}

export interface DiagnosticsResult {
  success: boolean;
  stats?: ServerDiagnostics;
  error?: string;
}

export interface ServerDiagnostics {
  ram: { used: number; total: number; percent: number };
  disk: { used: number; total: number; percent: number };
  cpu: { load: number; cores: number };
  uptime: string;
}

export interface ModuleExecutionOptions {
  moduleId: 'extraction' | 'deployment';
  domain: string;
  options: {
    accountName?: string;
    cloudName?: string;
    serverName?: string;
    sourceAccount?: string;
    sourceCloud?: string;
    deploymentOptions?: Record<string, unknown>;
  };
}

export interface CloudflareZoneInfo {
  domain: string;
  zoneName: string | null;
  zoneStatus: string;
  aRecord: { ip: string; proxied: boolean; ttl: number } | null;
  cnameRecord: { target: string; proxied: boolean } | null;
  error?: string;
  lastCloudflareSync?: string;
}

export interface CloudflareTokenResult {
  success: boolean;
  token: string;
  obfuscated: string;
  error?: string;
}

export interface BatchResult {
  success: boolean;
  results?: Array<{ domain: string; success: boolean }>;
  error?: string;
  successCount?: number;
  errors?: number;
}

export interface CsvLoadResult {
  success: boolean;
  canceled?: boolean;
  count?: number;
  dates?: Record<string, string>;
  error?: string;
}

export interface ProcessedListResult {
  success: boolean;
  dominios?: unknown[];
  error?: string;
}

export interface ExtractionStatusResult {
  isRunning: boolean;
  currentDomain: string;
  currentProgress: number;
  currentMessage: string;
}

export interface SshCredentials {
  host: string;
  port: number;
  username: string;
  privateKey?: string;
}

// ── Config data type ──
export interface ConfigData {
  googleDrive?: {
    credentialsPath?: string;
    rootFolderId?: string;
  };
  sshKeys: {
    privateKeyPath: string;
    publicKeyPath: string;
  };
  accounts: Array<{
    name: string;
    originClouds: Array<{
      name: string;
      type: string;
      isLinked: boolean;
      sshCredentials: {
        host: string;
        port: number;
        username: string;
        privateKey?: string;
      };
    }>;
  }>;
  destinationServers: Array<{
    name: string;
    type: string;
    isLinked: boolean;
    sshCredentials: {
      host: string;
      port: number;
      username: string;
      privateKey?: string;
    };
    pleskCliPath?: string;
  }>;
  cloudflare: {
    apiToken: string;
    zoneId: string;
  };
  elementorPro?: {
    zipPath?: string;
    licenseKey?: string;
  };
  workspaceRoot: string;
}

// ── Guard helpers ──
function isSuccessResult(data: unknown): data is { success: boolean; [key: string]: unknown } {
  return typeof data === 'object' && data !== null && 'success' in data;
}

function requireApi(): IpcApi {
  if (!window.api) {
    throw new Error(
      'IPC no disponible: la API de Electron no está disponible. Verifique que la aplicación se ejecute en el entorno nativo.',
    );
  }
  return window.api;
}

function isProgressEvent(data: unknown): data is ProgressEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    'module' in data &&
    'domain' in data &&
    'progress' in data &&
    'message' in data
  );
}

// ── Hook ──
export const useIpc = () => {
  const { config } = useConfig();
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const getApi = useCallback((): IpcApi => {
    return requireApi();
  }, []);

  // ── Config ──
  const loadConfig = useCallback(async (): Promise<ConfigData | null> => {
    try {
      const api = getApi();
      const configData = await api.invoke(IPC_CHANNEL.CONFIG_GET);
      if (!configData) {
        console.warn('Configuración vacía');
        return null;
      }
      return configData as ConfigData;
    } catch (error) {
      console.error('Error al cargar configuración:', error);
      return null;
    }
  }, [getApi]);

  const saveConfig = useCallback(
    async (newConfig: Partial<ConfigData>): Promise<void> => {
      const api = getApi();
      await api.send(IPC_CHANNEL.CONFIG_SAVE, newConfig);
      return new Promise<void>((resolve) => {
        const handler = () => {
          api.removeListener(IPC_CHANNEL.CONFIG_SAVED, handler);
          resolve();
        };
        api.receive(IPC_CHANNEL.CONFIG_SAVED, handler);
      });
    },
    [getApi],
  );

  // ── SSH ──
  const injectSshKey = useCallback(
    async (accountName: string, targetName: string, targetType: 'server' | 'cloud'): Promise<InjectKeyResult> => {
      const api = getApi();
      const serverType = targetType === 'cloud' ? 'origin' : 'destination';
      const result = await api.invoke(IPC_CHANNEL.SSH_INJECT_KEY, {
        serverType,
        serverId: targetName,
        accountName,
      });

      if (!isSuccessResult(result)) {
        throw new Error('Respuesta inválida del backend');
      }

      if (result.success) {
        await loadConfig();
        return result as unknown as InjectKeyResult;
      }
      throw new Error((result.error as string) || 'Inyección de llave SSH falló');
    },
    [getApi, loadConfig],
  );

  const injectKeyWithCredentials = useCallback(
    async (
      sshCredentials: { host: string; port: number; username: string },
      password: string,
    ): Promise<InjectKeyResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.SSH_INJECT_KEY, {
          host: sshCredentials.host,
          port: sshCredentials.port,
          username: sshCredentials.username,
          password,
        });
        return result as InjectKeyResult;
      } catch (error) {
        console.error('Error al inyectar llave SSH:', error);
        return { success: false, error: 'Error al inyectar llave SSH' };
      }
    },
    [getApi],
  );

  const testConnection = useCallback(
    async (sshCredentials: SshCredentials): Promise<{ success: boolean; connected: boolean; error?: string }> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.SSH_TEST_CONNECTION, sshCredentials);
        return result as { success: boolean; connected: boolean; error?: string };
      } catch (error) {
        console.error('Error al probar conexión:', error);
        return { success: false, connected: false, error: 'Error al probar conexión' };
      }
    },
    [getApi],
  );

  // 🔥 HOTFIX v1.6.0: Generate ED25519 SSH key
  const generateSshKey = useCallback(async (): Promise<{ success: boolean; publicKey?: string; path?: string; error?: string }> => {
    try {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.SSH_GENERATE_KEY);
      if (result && (result as Record<string, unknown>).success) {
        await loadConfig(); // refrescar config para que detecte la nueva llave
      }
      return result as { success: boolean; publicKey?: string; path?: string; error?: string };
    } catch (error) {
      console.error('Error al generar llave SSH:', error);
      return { success: false, error: 'Error al generar llave SSH' };
    }
  }, [getApi, loadConfig]);

  // ── Server diagnostics ──
  const runServerDiagnostics = useCallback(
    async (_accountName: string, serverName: string): Promise<ServerDiagnostics> => {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.SERVER_DIAGNOSTICS, {
        serverType: 'destination',
        serverId: serverName,
        accountName: _accountName,
      });

      if (!isSuccessResult(result)) {
        throw new Error('Respuesta inválida del backend');
      }

      if (result.success) {
        return result.stats as ServerDiagnostics;
      }
      throw new Error((result.error as string) || 'Diagnóstico falló');
    },
    [getApi],
  );

  // ── Maintenance ──
  const performMaintenance = useCallback(
    async (
      _accountName: string,
      serverName: string,
      action: 'clear-cache' | 'restart' | 'shutdown',
    ): Promise<void> => {
      const api = getApi();
      await api.send(IPC_CHANNEL.SERVER_MAINTENANCE, {
        serverType: 'destination',
        serverId: serverName,
        accountName: _accountName,
        action,
      });

      return new Promise<void>((resolve, reject) => {
        const handler = (data: unknown) => {
          api.removeListener(IPC_CHANNEL.SERVER_MAINTENANCE_COMPLETED, handler);
          if (isSuccessResult(data) && data.success) {
            resolve();
          } else {
            const errorMsg = isSuccessResult(data) ? String(data.error || '') : 'Acción de mantenimiento falló';
            reject(new Error(errorMsg));
          }
        };
        api.receive(IPC_CHANNEL.SERVER_MAINTENANCE_COMPLETED, handler);
      });
    },
    [getApi],
  );

  // ── Cloudflare ──
  const syncCloudflareDns = useCallback(
    (domains: string[], pleskIp: string, accountName?: string, cloudName?: string): void => {
      const api = getApi();
      api.send('cloudflare:sync-domains' as any, {
        domains,
        pleskIp,
        accountName,
        cloudName,
      });
      // No await — resultados via sync:domain-progress + state:update
    },
    [getApi],
  );

  const getCloudflareZones = useCallback(
    async (domains: string[], accountName?: string, cloudName?: string): Promise<unknown> => {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.CLOUDFLARE_GET_ZONES, {
        domains,
        accountName,
        cloudName,
      });
      return result;
    },
    [getApi],
  );

  const runSyncDnsBatch = useCallback(
    async (accountName: string, cloudName: string, domains: string[]): Promise<BatchResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.SYNCDNS_RUN_BATCH as IpcChannel, {
          accountName,
          cloudName,
          domains,
        });
        return result as BatchResult;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        console.error('Error al ejecutar sincronización DNS masiva:', error);
        return { success: false, error: message };
      }
    },
    [getApi],
  );

  const loadCsvDates = useCallback(
    async (): Promise<CsvLoadResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.SYNCDNS_LOAD_CSV as IpcChannel);
        return result as CsvLoadResult;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        console.error('Error al cargar CSV:', error);
        return { success: false, error: message };
      }
    },
    [getApi],
  );

  const getCloudflareToken = useCallback(async (): Promise<CloudflareTokenResult> => {
    try {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.CONFIG_GET_CLOUDFLARE_TOKEN);
      return result as CloudflareTokenResult;
    } catch (error) {
      console.error('Error al obtener token Cloudflare:', error);
      return { success: false, token: '', obfuscated: '', error: 'Error al obtener token Cloudflare' };
    }
  }, [getApi]);

  const setCloudflareToken = useCallback(
    async (token: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.CONFIG_SET_CLOUDFLARE_TOKEN, { token });
        return result as { success: boolean; error?: string };
      } catch (error) {
        console.error('Error al guardar token Cloudflare:', error);
        return { success: false, error: 'Error al guardar token Cloudflare' };
      }
    },
    [getApi],
  );

  // ── Plesk SSL ──
  const installBulkSsl = useCallback(
    (
      accountName: string,
      serverName: string,
      domains: string[],
      options?: { email?: string; webroot?: string },
    ): void => {
      const api = getApi();
      api.send('plesk:install-ssl' as any, {
        accountName,
        serverName,
        domains,
        options: options || {},
      });
      // No await — resultados via sync:domain-progress + state:update
    },
    [getApi],
  );

  // ── Extraction ──
  const getExtractionStatus = useCallback(async (): Promise<ExtractionStatusResult> => {
    try {
      const api = getApi();
      const status = await api.invoke(IPC_CHANNEL.GET_EXTRACTION_STATUS);
      return status as ExtractionStatusResult;
    } catch (error) {
      console.error('Error al obtener estado de extracción:', error);
      return { isRunning: false, currentDomain: '', currentProgress: 0, currentMessage: '' };
    }
  }, [getApi]);

  const checkExtractionStatus = useCallback(
    async (accountName: string, cloudName: string, domain: string): Promise<unknown> => {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.EXTRACTION_CHECK_STATUS, {
        accountName,
        cloudName,
        domain,
      });
      return result;
    },
    [getApi],
  );

  const runExtractionBatch = useCallback(
    async (
      accountName: string,
      cloudName: string,
      domains: string[],
    ): Promise<BatchResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.EXTRACTION_RUN_BATCH, {
          accountName,
          cloudName,
          domains,
        });
        return result as BatchResult;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        console.error('Error al ejecutar extracción masiva:', error);
        return { success: false, error: message };
      }
    },
    [getApi],
  );

  // ── Deployment ──
  const getDominiosProcesados = useCallback(
    async (accountName: string, cloudName: string): Promise<ProcessedListResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.DEPLOYMENT_GET_PROCESSED_LIST, {
          accountName,
          cloudName,
        });
        return result as ProcessedListResult;
      } catch (error) {
        console.error('Error al obtener dominios procesados:', error);
        return { success: false, error: 'Error al obtener dominios procesados' };
      }
    },
    [getApi],
  );

  const runDeploymentBatch = useCallback(
    async (
      accountName: string,
      serverName: string,
      sourceAccount: string,
      sourceCloud: string,
      manualList: string[],
      forceClean: boolean = false,
    ): Promise<BatchResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.DEPLOYMENT_RUN_BATCH, {
          accountName,
          serverName,
          sourceAccount,
          sourceCloud,
          manualList,
          forceClean,
        });
        return result as BatchResult;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        console.error('Error al ejecutar despliegue masivo:', error);
        return { success: false, error: message };
      }
    },
    [getApi],
  );

  const checkDeploymentStatus = useCallback(
    async (accountName: string, serverName: string, domain: string): Promise<unknown> => {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.DEPLOYMENT_CHECK_STATUS, {
        accountName,
        serverName,
        domain,
      });
      return result;
    },
    [getApi],
  );

  // ── Module execution (extraction/deployment) ──
  const executeModule = useCallback(
    async (
      moduleId: 'extraction' | 'deployment',
      domain: string,
      options: Record<string, unknown>,
    ): Promise<{ success: boolean; result?: Record<string, unknown>; error?: string }> => {
      const api = getApi();
      await api.send(IPC_CHANNEL.MODULE_EXECUTE, { moduleId, domain, options });

      return new Promise((resolve, reject) => {
        const completedHandler = (data: unknown) => {
          cleanup();
          if (isSuccessResult(data) && data.success) {
            resolve(data as { success: boolean; result?: Record<string, unknown>; error?: string });
          } else {
            const errMsg =
              data && typeof data === 'object' && 'error' in data
                ? String(data.error)
                : 'Ejecución del módulo falló';
            reject(new Error(errMsg));
          }
        };
        const errorHandler = (data: unknown) => {
          cleanup();
          const errMsg =
            data && typeof data === 'object' && 'error' in data
              ? String((data as { error: string }).error)
              : 'Ejecución del módulo falló';
          reject(new Error(errMsg));
        };
        const cleanup = () => {
          api.removeListener(IPC_CHANNEL.MODULE_COMPLETED, completedHandler);
          api.removeListener(IPC_CHANNEL.MODULE_ERROR, errorHandler);
        };
        api.receive(IPC_CHANNEL.MODULE_COMPLETED, completedHandler);
        api.receive(IPC_CHANNEL.MODULE_ERROR, errorHandler);
      });
    },
    [getApi],
  );

  // ── Workspace ──
  const scanWorkspace = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const api = getApi();
      console.log('[IPC] Invocando workspace:scan...');
      const result = await api.invoke(IPC_CHANNEL.WORKSPACE_SCAN);
      console.log('[IPC] workspace:scan respondió:', result);
      return result as { success: boolean; error?: string };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error('Error desconocido');
      console.error('[IPC] workspace:scan falló:', error.message, error);
      return { success: false, error: error.message };
    }
  }, [getApi]);

  const createAccountFolder = useCallback(
    async (accountName: string): Promise<unknown> => {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.WORKSPACE_CREATE_ACCOUNT_FOLDER, { accountName });
      return result;
    },
    [getApi],
  );

  const createCloudFolder = useCallback(
    async (accountName: string, cloudName: string): Promise<unknown> => {
      const api = getApi();
      const result = await api.invoke(IPC_CHANNEL.WORKSPACE_CREATE_CLOUD_FOLDER, {
        accountName,
        cloudName,
      });
      return result;
    },
    [getApi],
  );

  // ── Logs and commands ──
  const tailServerLog = useCallback(
    async (serverName: string): Promise<LogResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.SERVER_TAIL_LOG, { serverName });
        return result as LogResult;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        return { success: false, error: message };
      }
    },
    [getApi],
  );

  const execServerCommand = useCallback(
    async (serverName: string, command: string): Promise<ServerCommandResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.SERVER_EXEC_COMMAND, { serverName, command });
        return result as ServerCommandResult;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        return { success: false, error: message };
      }
    },
    [getApi],
  );

  const lookupHost = useCallback(
    async (domain: string): Promise<LookupResult> => {
      try {
        const api = getApi();
        const result = await api.invoke(IPC_CHANNEL.UTILS_LOOKUP_HOST, { domain });
        return result as LookupResult;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        return { success: false, error: message };
      }
    },
    [getApi],
  );

  // ── Subscription ──
  useEffect(() => {
    let api: IpcApi | null = null;
    try {
      api = requireApi();
    } catch {
      console.warn('IPC no disponible: la aplicación no está en un entorno Electron.');
      return;
    }

    setIsConnected(true);
    api.send(IPC_CHANNEL.PROGRESS_SUBSCRIBE);

    const handleProgressUpdate = (event: unknown) => {
      if (isProgressEvent(event)) {
        setProgressEvents((prev) => [event, ...prev.slice(0, 99)]);
      }
    };

    api.receive(IPC_CHANNEL.PROGRESS_UPDATE, handleProgressUpdate);

    return () => {
      if (api) {
        api.removeListener(IPC_CHANNEL.PROGRESS_UPDATE, handleProgressUpdate);
        api.send(IPC_CHANNEL.PROGRESS_UNSUBSCRIBE);
      }
    };
  }, []);

  // ── Return ──
  return {
    config,
    progressEvents,
    isConnected,
    loadConfig,
    saveConfig,
    injectSshKey,
    injectKeyWithCredentials,
    runServerDiagnostics,
    performMaintenance,
    executeModule,
    runExtractionBatch,
    runDeploymentBatch,
    getDominiosProcesados,
    testConnection,
    generateSshKey,
    runSyncDnsBatch,
    syncCloudflareDns,
    getCloudflareZones,
    getCloudflareToken,
    setCloudflareToken,
    installBulkSsl,
    getExtractionStatus,
    checkExtractionStatus,
    checkDeploymentStatus,
    createAccountFolder,
    createCloudFolder,
    scanWorkspace,
    lookupHost,
    tailServerLog,
    execServerCommand,
    loadCsvDates,
  } as const;
};
