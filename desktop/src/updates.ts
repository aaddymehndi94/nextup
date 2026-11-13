// Keeps nexttupp up to date from GitHub Releases. It checks 20 s after launch and every 6 hours. It downloads this
// computer's installer in the background and checks it against the release's SHA256SUMS.txt. When the person says
// so, it installs it and restarts:
// - a .deb asks for the computer's password (pkexec shows the system prompt);
// - an AppImage replaces itself;
// - Windows runs the installer silently;
// - on a Mac, which can't install an ad-hoc-signed app by itself, the release page opens.
import { app, Notification, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopUpdate } from '../../shared/desktop.ts'
import { assetName, compareVersions, parseRelease, parseSums, type InstallKind, type Release } from './update-check.ts'

const FEED = process.env.NEXTTUPP_UPDATE_FEED ?? 'https://api.github.com/repos/aaddymehndi94/nextup/releases/latest'
const FIRST_CHECK_MS = Number(process.env.NEXTTUPP_UPDATE_FIRST_MS) || 20_000
const EVERY_MS = 6 * 3600_000
/** A download that receives nothing for this long has stalled (a slow one is fine). */
const STALL_MS = 60_000

export class Updater {
  readonly kind: InstallKind | null = installKind()
  private status: DesktopUpdate | null = null
  private release: Release | null = null
  /** The downloaded, verified installer. */
  private file: string | null = null
  private downloading: Promise<void> | null = null
  private announced: string | null = null
  private notice: Notification | null = null

  constructor (private readonly opts: {
    icon: string
    /** Where installers are downloaded to. */
    dir: string
    publish: (update: DesktopUpdate | null) => void
    onOpen: () => void
    log: (line: string) => void
  }) {}

  /** Installs itself when it can; otherwise the person downloads it from the release page. */
  private get canInstall (): boolean {
    if (this.kind === 'deb') return existsSync('/usr/bin/pkexec')
    return this.kind === 'appimage' || this.kind === 'windows'
  }

  start (): void {
    if (!this.kind) return
    this.cleanOld()
    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    setInterval(() => void this.check(), EVERY_MS).unref()
  }

  current (): DesktopUpdate | null { return this.status }

  async check (): Promise<DesktopUpdate | null> {
    if (!this.kind || this.status?.state === 'installing') return this.status
    try {
      const res = await net.fetch(FEED, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'nexttupp-desktop' }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const release = parseRelease(await res.json())
      if (!release || compareVersions(release.version, app.getVersion()) <= 0) {
        this.release = null
        this.file = null
        this.set(null)
        return null
      }
      if (this.release?.version !== release.version) {
        this.release = release
        this.file = null
        this.set(this.base('available'))
        this.opts.log(`update: nexttupp ${release.version} is out (this is ${app.getVersion()})`)
      }
      if (this.canInstall && !this.file) void this.download()
      else if (!this.canInstall) this.announce()
    } catch (err) {
      this.opts.log(`update: check failed: ${(err as Error).message}`)
    }
    return this.status
  }

  /** Installs the update and restarts (downloading it first if that hasn't finished). */
  async install (): Promise<void> {
    const release = this.release
    if (!release) return
    if (!this.canInstall) { void shell.openExternal(release.url); return }
    if (!this.file) await this.download()
    const file = this.file
    if (!file) return
    this.set(this.base('installing'))
    try {
      if (this.kind === 'deb') {
        await run('pkexec', ['dpkg', '-i', file])
        app.relaunch()
      } else if (this.kind === 'appimage') {
        const target = process.env.APPIMAGE!
        rmSync(`${target}.new`, { force: true })
        await copy(file, `${target}.new`)
        chmodSync(`${target}.new`, 0o755)
        renameSync(`${target}.new`, target)
        app.relaunch({ execPath: target, args: process.argv.slice(1) })
      } else {
        // NSIS one-click: silent, and it starts nexttupp again when done.
        spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      }
      this.opts.log(`update: installed ${release.version}; restarting`)
      app.quit()
    } catch (err) {
      const message = (err as Error).message
      this.opts.log(`update: install failed: ${message}`)
      this.set({ ...this.base('ready'), error: message })
    }
  }

  private base (state: DesktopUpdate['state']): DesktopUpdate {
    const r = this.release!
    return { state, version: r.version, current: app.getVersion(), url: r.url, needsPassword: this.kind === 'deb' || undefined }
  }

  private set (update: DesktopUpdate | null): void {
    this.status = update
    this.opts.publish(update)
  }

  private download (): Promise<void> {
    this.downloading ??= this.fetchInstaller().finally(() => { this.downloading = null })
    return this.downloading
  }

  private async fetchInstaller (): Promise<void> {
    const release = this.release!
    const name = assetName(this.kind!, process.arch)
    const asset = release.assets.find(a => a.name === name)
    const sums = release.assets.find(a => a.name === 'SHA256SUMS.txt')
    try {
      if (!asset || !sums) throw new Error(`the release has no ${asset ? 'checksums' : name}`)
      this.set({ ...this.base('downloading'), progress: 0 })
      const sumsRes = await net.fetch(sums.url, { signal: AbortSignal.timeout(30_000) })
      if (!sumsRes.ok) throw new Error(`couldn’t get the checksums (${sumsRes.status})`)
      const expected = parseSums(await sumsRes.text()).get(name)
      if (!expected) throw new Error(`the checksums don’t list ${name}`)
      const dir = join(this.opts.dir, release.version)
      const dest = join(dir, name)
      mkdirSync(dir, { recursive: true })
      if (!existsSync(dest) || await sha256(dest) !== expected) {
        const got = await this.fetchTo(asset.url, `${dest}.part`, release.version)
        if (got !== expected) { rmSync(`${dest}.part`, { force: true }); throw new Error('the download was damaged (checksum mismatch)') }
        renameSync(`${dest}.part`, dest)
      }
      if (this.release !== release) return
      this.file = dest
      this.set(this.base('ready'))
      this.opts.log(`update: ${name} ${release.version} downloaded and verified`)
      this.announce()
    } catch (err) {
      const message = (err as Error).message
      this.opts.log(`update: download failed: ${message}`)
      if (this.release === release) this.set({ ...this.base('failed'), error: message })
    }
  }

  /** Streams `url` to `path`, reporting progress; resolves with the file's SHA-256. */
  private async fetchTo (url: string, path: string, version: string): Promise<string> {
    const abort = new AbortController()
    let stall = setTimeout(() => abort.abort(), STALL_MS)
    const res = await net.fetch(url, { signal: abort.signal })
    if (!res.ok || !res.body) { clearTimeout(stall); throw new Error(`the download failed (${res.status})`) }
    const total = Number(res.headers.get('content-length')) || 0
    const hash = createHash('sha256')
    const out = createWriteStream(path)
    const reader = res.body.getReader()
    let got = 0
    let shown = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        clearTimeout(stall)
        stall = setTimeout(() => abort.abort(), STALL_MS)
        hash.update(value)
        got += value.length
        if (!out.write(value)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
        const progress = total ? got / total : 0
        if (progress - shown >= 0.01 && this.release?.version === version) {
          shown = progress
          this.set({ ...this.base('downloading'), progress })
        }
      }
    } catch (err) {
      throw abort.signal.aborted ? new Error('the download stalled; it will try again later') : err
    } finally {
      clearTimeout(stall)
      await new Promise(resolve => out.end(resolve))
    }
    return hash.digest('hex')
  }

  /** A system notification, once per version: shown even when the window is closed to the tray. */
  private announce (): void {
    const r = this.release
    if (!r || this.announced === r.version || !Notification.isSupported()) return
    this.announced = r.version
    const n = new Notification({
      title: `nexttupp ${r.version} is ready`,
      body: this.canInstall ? 'Restart nexttupp to update. It takes a few seconds.' : 'Download it from the release page.',
      icon: this.opts.icon,
      actions: [{ type: 'button', text: this.canInstall ? 'Restart now' : 'Download' }],
    })
    n.on('action', () => void this.install())
    n.on('click', () => this.opts.onOpen())
    this.notice = n // kept referenced, or its button stops working
    n.show()
  }

  /** Installers of this version or older are done with. */
  private cleanOld (): void {
    try {
      for (const v of readdirSync(this.opts.dir)) if (compareVersions(v, app.getVersion()) <= 0) rmSync(join(this.opts.dir, v), { recursive: true, force: true })
    } catch { /* nothing downloaded yet */ }
  }
}

function installKind (): InstallKind | null {
  const forced = process.env.NEXTTUPP_UPDATE_KIND as InstallKind | undefined
  if (forced) return forced
  if (!app.isPackaged) return null
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  if (process.platform !== 'linux') return null
  if (process.env.APPIMAGE) return 'appimage'
  // The .deb installs to /opt/nexttupp; anything else (a hand-unpacked copy) updates by hand.
  return process.execPath.startsWith('/opt/') ? 'deb' : null
}

function run (cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err = (err + d).slice(-400) })
    p.on('error', reject)
    p.on('exit', code => {
      if (code === 0) return resolve()
      // pkexec: 126 = the password prompt was dismissed, 127 = not allowed.
      reject(new Error(code === 126 || code === 127 ? 'Installing was cancelled.' : `The installer stopped (${code}). ${err.trim()}`.trim()))
    })
  })
}

function sha256 (path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

function copy (from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    createReadStream(from).on('error', reject).pipe(createWriteStream(to)).on('error', reject).on('finish', () => resolve())
  })
}
