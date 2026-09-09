import type { ServerDiagnostics } from './server';

// ── IPC API ──
export interface IpcApi {
  send: (channel: string, data?: unknown) => void;
  receive: (channel: string, func: (...args: any[]) => void) => () => void;
  removeListener: (channel: string, func: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
  invoke: (channel: string, data?: unknown) => Promise<unknown>;
}

// ── Config ──
export interface SshKeyConfig {
  privateKeyPath: string;
  publicKeyPath: string;
}

export interface OriginCloudConfig {
  name: string;
  type: string;
  isLinked: boolean;
  sshCredentials: {
    host: string;
    port: number;
    username: string;
    privateKey?: string;
  };
}

export interface AccountConfig {
  name: string;
  originClouds: OriginCloudConfig[];
}

export interface DestinationServerConfig {
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
}

export interface CloudflareConfig {
  apiToken: string;
  zoneId: string;
}

export interface ConfigData {
  googleDrive?: {
    credentialsPath?: string;
    rootFolderId?: string;
  };
  sshKeys: SshKeyConfig;
  accounts: AccountConfig[];
  destinationServers: DestinationServerConfig[];
  cloudflare: CloudflareConfig;
  elementorPro?: {
    zipPath?: string;
    licenseKey?: string;
  };
  workspaceRoot: string;
}

// ── IPC Invoke results ──
export interface DiagnosticsResult {
  success: boolean;
  stats?: ServerDiagnostics;
  error?: string;
}

export interface LookupHostResult {
  success: boolean;
  ip?: string;
  hostName?: string | null;
  error?: string;
}

export interface CloudflareTokenResult {
  success: boolean;
  token: string;
  obfuscated: string;
  error?: string;
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

export interface BatchResult {
  success: boolean;
  results?: Array<{ domain: string; success: boolean }>;
  error?: string;
}

export interface ProcessedListResult {
  success: boolean;
  dominios?: unknown[];
  error?: string;
}

// ── Log levels ──
export const LOG_LEVEL = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  SUCCESS: 'success',
} as const;

export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

// ── Log entry ──
export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: LogLevel;
}
