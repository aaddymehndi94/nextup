// nexttupp desktop: runs the nexttupp server in an Electron utility process on a localhost port and shows it
// in a window. Decisions and measurements: docs/adr/0005-desktop-app.md.
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell, utilityProcess, type UtilityProcess } from 'electron'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type WriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const ICON = join(__dirname, 'icon.png')
const SERVER_ENTRY = join(__dirname, 'server', 'server.mjs')
const WEB_DIR = join(__dirname, 'web')
/** ffmpeg, ffprobe and the CF model ship outside the asar archive (binaries can't run from inside it). */
const RESOURCES = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'vendor')
const EXE = process.platform === 'win32' ? '.exe' : ''
const FFMPEG_DIR = app.isPackaged ? join(RESOURCES, 'ffmpeg') : join(RESOURCES, 'ffmpeg', `${process.platform}-${process.arch}`)

const userData = app.getPath('userData')
const dataDir = join(userData, 'data')
const settingsFile = join(userData, 'desktop.json')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let server: UtilityProcess | null = null
let serverLog: WriteStream | null = null
let baseUrl = ''
let quitting = false
let downloadTimer: NodeJS.Timeout | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(start).catch(err => fatal(err))
}

async function start (): Promise<void> {
  const t0 = Date.now()
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
  mkdirSync(dataDir, { recursive: true })
  installCfModel()
  const port = await pickPort()
  await startServer(port)
  console.log(`[desktop] server ready on ${baseUrl} in ${Date.now() - t0} ms`)
  createWindow()
}

// ---- Server ------------------------------------------------------------------------------------------------

/**
 * The same port every launch where possible: the web app keeps the chosen profile and player settings in
 * localStorage, which belongs to the origin (host + port), so a new port would forget them.
 */
async function pickPort (): Promise<number> {
  const saved = readSettings().port
  if (typeof saved === 'number' && await portFree(saved)) return saved
  const port = await freePort()
  writeSettings({ ...readSettings(), port })
  return port
}

function portFree (port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

function freePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

async function startServer (port: number): Promise<void> {
  const logDir = app.getPath('logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'server.log')
  if (existsSync(logFile) && statSync(logFile).size > 5 * 1048576) renameSync(logFile, `${logFile}.old`)
  serverLog = createWriteStream(logFile, { flags: 'a' })
  serverLog.write(`\n---- ${new Date().toISOString()} nexttupp ${app.getVersion()} ----\n`)

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    NEXTTUPP_DATA: dataDir,
    NEXTTUPP_WEB_DIR: WEB_DIR,
    NEXTTUPP_FFMPEG: join(FFMPEG_DIR, 'bin', `ffmpeg${EXE}`),
    NEXTTUPP_FFPROBE: join(FFMPEG_DIR, 'bin', `ffprobe${EXE}`),
  }
  // The Linux ffmpeg build's own RPATH is unusable, so point the loader at its libraries (only libav*, which
  // Electron doesn't use). ffmpeg inherits this from the server. Windows finds the DLLs next to the .exe.
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = [join(FFMPEG_DIR, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  server = utilityProcess.fork(SERVER_ENTRY, [], { env, stdio: 'pipe', serviceName: 'nexttupp server' })
  server.stdout?.on('data', d => { serverLog?.write(d); if (!app.isPackaged) process.stdout.write(d) })
  server.stderr?.on('data', d => { serverLog?.write(d); if (!app.isPackaged) process.stderr.write(d) })
  const exited = new Promise<number>(resolve => server!.once('exit', resolve))
  server.once('exit', code => {
    serverLog?.write(`[desktop] server exited with code ${code}\n`)
    server = null
    if (!quitting) fatal(new Error(`The nexttupp server stopped unexpectedly (code ${code}). See ${logFile}`))
  })

  baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ok = await Promise.race([
      fetch(`${baseUrl}/api/health`).then(r => r.ok, () => false),
      exited.then(() => { throw new Error(`The nexttupp server failed to start. See ${logFile}`) }),
    ])
    if (ok) return
    await sleep(100)
  }
  throw new Error(`The nexttupp server did not answer within 60 s. See ${logFile}`)
}

/** Asks the server to shut down (it stops ffmpeg, closes torrents and the database), then makes sure. */
async function stopServer (): Promise<void> {
  const proc = server
  if (!proc) return
  const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()))
  proc.postMessage({ type: 'shutdown' })
  const clean = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)])
  if (!clean) {
    serverLog?.write('[desktop] server did not exit within 8 s; killing it\n')
    proc.kill()
    await Promise.race([exited, sleep(2000)])
  }
}

/**
 * The collaborative-filtering model ships as a resource when the build included one; the server loads it
 * from <data>/reco/cf.bin. Copied (not linked) so it also works on Windows, and only when it changed.
 */
function installCfModel (): void {
  const bundled = join(RESOURCES, 'reco', 'cf.bin')
  if (!existsSync(bundled)) return
  const dest = join(dataDir, 'reco', 'cf.bin')
  const st = statSync(bundled)
  const stamp = `${st.size}:${st.mtimeMs}`
  const stampFile = `${dest}.bundled`
  if (existsSync(dest) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return
  mkdirSync(join(dataDir, 'reco'), { recursive: true })
  copyFileSync(bundled, `${dest}.tmp`)
  renameSync(`${dest}.tmp`, dest)
  writeFileSync(stampFile, stamp)
}

// ---- Window -----------------------------------------------------------------------------------------------

function createWindow (): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: 'nexttupp',
    icon: ICON,
    backgroundColor: '#0b0b0f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  })
  win.once('ready-to-show', () => win?.show())
  // Anything that isn't our own app opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(baseUrl)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(baseUrl)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  win.on('close', e => {
    if (quitting) return
    if (activeDownloads > 0 || process.platform === 'darwin') {
      // Keep downloading in the background; the tray (or the dock on macOS) brings the window back.
      e.preventDefault()
      win?.hide()
      if (process.platform !== 'darwin') showTray(true)
    }
  })
  win.on('closed', () => { win = null })
  void win.loadURL(baseUrl)
  watchDownloads()
}

function showWindow (): void {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---- Downloads and tray ------------------------------------------------------------------------------------

let activeDownloads = 0
let notified = false

/** Polls the library so closing the window mid-download keeps the app (and the download) alive in the tray. */
function watchDownloads (): void {
  if (downloadTimer) return
  const poll = async () => {
    try {
      const lib = await fetch(`${baseUrl}/api/library`).then(r => r.json()) as Array<{ stats: { progress: number } | null }>
      activeDownloads = lib.filter(e => e.stats && e.stats.progress < 1).length
    } catch { /* server busy or stopping */ }
    if (tray) tray.setToolTip(activeDownloads ? `nexttupp: downloading ${activeDownloads} title${activeDownloads > 1 ? 's' : ''}` : 'nexttupp')
    // Hidden in the tray and nothing left to download: finish quitting.
    if (activeDownloads === 0 && win && !win.isVisible() && tray && process.platform !== 'darwin') app.quit()
  }
  void poll()
  downloadTimer = setInterval(poll, 15_000)
}

function showTray (announce: boolean): void {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }))
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open nexttupp', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]))
    tray.on('click', showWindow)
  }
  if (announce && !notified && Notification.isSupported()) {
    notified = true
    new Notification({ title: 'nexttupp', body: 'Still downloading. nexttupp quits by itself when the downloads finish.', icon: ICON }).show()
  }
}

// ---- Lifecycle ----------------------------------------------------------------------------------------------

app.on('activate', () => showWindow())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', e => {
  if (quitting && !server) return
  e.preventDefault()
  if (quitting) return
  quitting = true
  if (downloadTimer) clearInterval(downloadTimer)
  void stopServer().finally(() => {
    serverLog?.end()
    tray?.destroy()
    app.exit(0)
  })
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit())

function fatal (err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error('[desktop]', message)
  serverLog?.write(`[desktop] fatal: ${message}\n`)
  const { dialog } = require('electron') as typeof import('electron')
  if (app.isReady()) dialog.showErrorBox('nexttupp could not start', message)
  quitting = true
  void stopServer().finally(() => app.exit(1))
}

function readSettings (): { port?: number } {
  try { return JSON.parse(readFileSync(settingsFile, 'utf8')) } catch { return {} }
}

function writeSettings (s: { port?: number }): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(settingsFile, JSON.stringify(s, null, 2))
}

function sleep (ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
