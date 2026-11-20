export type InstanceKind = 'client' | 'server';
export type InstanceStatus = 'ready' | 'incomplete' | 'unknown';

export interface InstanceStats {
  mods: number;
  saves: number;
  screenshots: number;
  resourcePacks: number;
  shaderPacks: number;
}

export interface LauncherInstance {
  id: string;
  name: string;
  /** Directory containing versions, libraries and assets. */
  path: string;
  /** Directory containing this instance's mods, saves, logs and config. */
  gameDirectory: string;
  minecraftVersion: string;
  loader: string;
  loaderVersion: string;
  kind: InstanceKind;
  status: InstanceStatus;
  issues: string[];
  stats: InstanceStats;
  versionId?: string;
  requiredJavaMajor?: number;
  lastPlayed?: string;
  source: 'minecraft' | 'prism' | 'server' | 'folder';
  serverArgumentsFile?: string;
  serverJar?: string;
  /** Configured server worlds live beside server.properties rather than in saves/. */
  worldDirectories?: string[];
}

export interface JavaInstallation {
  id: string;
  path: string;
  version: string;
  major: number;
  vendor: string;
  architecture: string;
  source: string;
}

export interface LauncherSettings {
  roots: string[];
  javaPath: string;
  memoryMb: number;
  playerName: string;
  closeOnLaunch: boolean;
}

export interface LauncherSnapshot {
  instances: LauncherInstance[];
  java: JavaInstallation[];
  settings: LauncherSettings;
  scannedAt: string;
  warnings?: string[];
}

export interface InstanceScanResult {
  instances: LauncherInstance[];
  warnings: string[];
}

export interface InstanceRemovalPreview {
  token: string;
  name: string;
  path: string;
  action: 'delete' | 'remove';
  blocked: boolean;
  reason?: string;
  warning: string;
}

export interface InstanceLog {
  found: boolean;
  path: string;
  content: string;
  updatedAt?: string;
  truncated: boolean;
  redacted: boolean;
}

export interface LaunchPlan {
  instanceId: string;
  executable: string;
  args: string[];
  cwd: string;
  displayCommand: string;
  warnings: string[];
  kind: InstanceKind;
}

export interface LaunchEvent {
  instanceId: string;
  type: 'starting' | 'started' | 'stdout' | 'stderr' | 'exit' | 'error';
  message: string;
  timestamp: string;
  pid?: number;
  exitCode?: number | null;
}

export interface RuntimeInfo {
  appVersion: string;
  platform: string;
  totalMemoryMb: number;
  workspaceRoot: string;
}

export type ResourceKind = 'mods' | 'saves' | 'screenshots' | 'resourcepacks' | 'shaderpacks';
export type FolderTarget = ResourceKind | 'root' | 'logs';

export interface ResourceEntry {
  name: string;
  size: number;
  directory: boolean;
  modifiedAt: string;
  previewUrl?: string;
}

export interface TaskProgress {
  id: string;
  label: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  message: string;
  completed?: number;
  total?: number;
}

export interface AppBridge {
  inspectModpack(): Promise<ModpackPreview | null>;
  inspectDroppedModpack(file: File): Promise<ModpackPreview>;
  installModpack(previewId: string, name: string): Promise<ModpackInstallResult>;
  listModpackJobs(): Promise<ModpackJob[]>;
  resumeModpack(jobId: string): Promise<ModpackInstallResult>;
  cancelModpack(jobId: string): Promise<void>;
  dismissModpack(jobId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  onModpackJobRemoved(callback: (jobId: string) => void): () => void;
  catalogMinecraftVersions(): Promise<CatalogMinecraftVersion[]>;
  searchCatalog(query: CatalogSearchQuery): Promise<CatalogSearchResult>;
  catalogVersions(projectId: string, filter: CatalogVersionFilter): Promise<CatalogVersion[]>;
  /** Save one verified project file through a native save dialog, without installing it. */
  saveCatalogFile(ticket: string): Promise<string | null>;
  downloadCatalogPack(ticket: string): Promise<ModpackPreview>;
  installCatalogMod(ticket: string, instanceId: string): Promise<LauncherSnapshot>;
  onModpackJob(callback: (job: ModpackJob) => void): () => void;
  onModpackInstalled(callback: (result: ModpackInstallResult) => void): () => void;
  account(): Promise<AccountState>;
  configureAccount(clientId: string): Promise<AccountState>;
  beginMicrosoftLogin(): Promise<AccountState>;
  cancelMicrosoftLogin(): Promise<AccountState>;
  openMicrosoftLogin(): Promise<void>;
  refreshAccount(): Promise<AccountState>;
  logoutAccount(): Promise<AccountState>;
  importPreviewSkin(): Promise<AccountState | null>;
  onAccountChanged(callback: (state: AccountState) => void): () => void;
  snapshot(): Promise<LauncherSnapshot>;
  runtime(): Promise<RuntimeInfo>;
  importDirectory(): Promise<LauncherSnapshot | null>;
  prepareInstanceRemoval(instanceId: string): Promise<InstanceRemovalPreview>;
  confirmInstanceRemoval(token: string): Promise<LauncherSnapshot>;
  saveSettings(patch: Partial<LauncherSettings>): Promise<LauncherSnapshot>;
  chooseJava(): Promise<string | null>;
  readLog(instanceId: string): Promise<InstanceLog>;
  prepareLaunch(instanceId: string): Promise<LaunchPlan>;
  launch(instanceId: string): Promise<{ pid?: number }>;
  stop(instanceId: string): Promise<void>;
  openFolder(instanceId: string, target: FolderTarget): Promise<void>;
  resources(instanceId: string, kind: ResourceKind): Promise<ResourceEntry[]>;
  exportDiagnostics(instanceId: string): Promise<string | null>;
  backup(instanceId: string): Promise<string>;
  installVanilla(versionId: string, name: string): Promise<LauncherSnapshot>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  onLaunchEvent(callback: (event: LaunchEvent) => void): () => void;
  onTaskProgress(callback: (event: TaskProgress) => void): () => void;
}

export interface PlayerProfile {
  id: string;
  name: string;
  skinDataUrl?: string;
  capeDataUrl?: string;
  model: 'default' | 'slim';
}

export interface AccountState {
  status?: 'signed-out' | 'authorizing' | 'refreshing' | 'connected' | 'offline' | 'reauthentication-required';
  stage?: string;
  configured: boolean;
  clientId: string;
  profile: PlayerProfile | null;
  localSkin?: string;
  busy: boolean;
  notice?: string;
  device?: { code: string; verificationUri: string; expiresAt: number };
}

export interface ModpackPreview {
  id: string;
  existingJobId?: string;
  name: string;
  archiveName: string;
  format: 'modrinth';
  version: string;
  minecraftVersion: string;
  loader: string;
  loaderVersion?: string;
  requiredJavaMajor: number;
  javaAvailable: boolean;
  fileCount: number;
  modCount: number;
  downloadBytes: number;
  overrideBytes: number;
  warnings: string[];
}

export interface ModpackProgressStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'complete' | 'error' | 'cancelled' | 'skipped';
  /** Measured completion within this step; absent when its work cannot be counted. */
  percent?: number;
  completedFiles?: number;
  totalFiles?: number;
  completedBytes?: number;
  totalBytes?: number;
}

export interface ModpackProgress {
  steps: ModpackProgressStep[];
  activeStep?: string;
  /** Real received network bytes in this run, including retries; excludes reused files and ZIP extraction. */
  transferredBytes: number;
  bytesPerSecond?: number;
  /** The following counts describe the current step, not the entire installation. */
  completedFiles?: number;
  totalFiles?: number;
  completedBytes?: number;
  totalBytes?: number;
  currentFile?: string;
  elapsedMs: number;
}

export interface ModpackJob {
  id: string;
  name: string;
  status: 'running' | 'cancelled' | 'error' | 'complete';
  phase: 'vanilla' | 'loader' | 'files' | 'complete';
  message: string;
  completed: number;
  total: number;
  minecraftVersion: string;
  loader: string;
  updatedAt: string;
  progress?: ModpackProgress;
  archiveName?: string;
  loaderVersion?: string;
  requiredJavaMajor?: number;
}

export interface ModpackInstallResult {
  snapshot: LauncherSnapshot;
  instanceId: string;
}

export interface CatalogMinecraftVersion {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  releaseTime: string;
}
export interface CatalogSearchQuery {
  type: 'mod' | 'modpack';
  query: string;
  minecraftVersion?: string;
  loader?: string;
  offset?: number;
}
export interface CatalogVersionFilter {
  type: 'mod' | 'modpack';
  minecraftVersion?: string;
  loader?: string;
}
export interface CatalogProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl?: string;
  type: 'mod' | 'modpack';
}
export interface CatalogSearchResult { hits: CatalogProject[]; total: number; offset: number; limit: number }
export interface CatalogFile { ticket: string; filename: string; size: number; primary: boolean }
export interface CatalogVersion {
  id: string;
  projectId: string;
  name: string;
  versionNumber: string;
  versionType: 'release' | 'beta' | 'alpha';
  publishedAt: string;
  minecraftVersions: string[];
  loaders: string[];
  files: CatalogFile[];
  requiredDependencies: number;
}
