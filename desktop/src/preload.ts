// The page's only way to the desktop app: the "Now playing" notification and updates (shared/desktop.ts).
// Sandboxed preload: just messages, no Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge, DesktopMusicAction, DesktopNowPlaying, DesktopUpdate } from '../../shared/desktop.ts'

function listen<T> (channel: string, fn: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => fn(value)
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.off(channel, handler) }
}

const bridge: DesktopBridge = {
  nowPlaying: (info: DesktopNowPlaying | null) => ipcRenderer.send('now-playing', info),
  onMusicAction: (fn: (action: DesktopMusicAction, id: string) => void) =>
    listen<{ action: DesktopMusicAction; id: string }>('music-action', m => fn(m.action, m.id)),
  onUpdate: (fn: (update: DesktopUpdate | null) => void) => {
    const off = listen('update', fn)
    void ipcRenderer.invoke('update-status').then(fn, () => {})
    return off
  },
  installUpdate: () => ipcRenderer.send('update-install'),
  checkForUpdate: () => ipcRenderer.invoke('update-check') as Promise<DesktopUpdate | null>,
}

contextBridge.exposeInMainWorld('nexttuppDesktop', bridge)
