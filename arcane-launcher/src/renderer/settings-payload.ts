import type { LauncherSettings } from '../shared/contracts'

/** IPC accepts plain values; Vue reactive proxies cannot cross a context bridge. */
export function toSettingsPayload(settings: LauncherSettings): LauncherSettings {
  return {
    roots: [...settings.roots],
    javaPath: settings.javaPath,
    memoryMb: Number(settings.memoryMb),
    closeOnLaunch: Boolean(settings.closeOnLaunch),
  }
}
