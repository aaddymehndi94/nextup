// Builds everything the desktop app runs into desktop/build/:
//   web/            the web app (vite, from ../web; never touches the root dist/)
//   server/server.mjs  the nexttupp server and its dependencies, one ES module (esbuild)
//   main.cjs        the Electron main process
//   preload.cjs     the page's bridge to it (Now playing notification, updates)
//   icon.png        window and tray icon
// Installers come from electron-builder afterwards (scripts/dist.mjs). Needs `npm install` at the repo root.
//
// CF_BIN=/path/to/cf.bin node scripts/build.mjs   also ships the collaborative-filtering model.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DESKTOP = resolve(import.meta.dirname, '..')
const ROOT = resolve(DESKTOP, '..')
const OUT = join(DESKTOP, 'build')
const t0 = Date.now()

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'server'), { recursive: true })

// 1. Web app. vite.config.ts has root: 'web', so outDir is relative to web/.
const vite = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', '../desktop/build/web', '--emptyOutDir'], { cwd: ROOT, stdio: 'inherit' })
if (vite.status !== 0) process.exit(vite.status ?? 1)

// 2. Server: TypeScript and every dependency in one file, so the app ships no node_modules.
const stubs = {
  // WebRTC (libdatachannel) and uTP are native and unused: the engine is TCP-only.
  'webrtc-polyfill': join(DESKTOP, 'src', 'webrtc-stub.ts'),
  'utp-native': join(DESKTOP, 'src', 'webrtc-stub.ts'),
}
await build({
  entryPoints: [join(DESKTOP, 'src', 'server-entry.ts')],
  outfile: join(OUT, 'server', 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  alias: stubs,
  // Optional native speed-ups, each loaded inside a try/catch with a pure-JS fallback.
  external: ['bufferutil', 'utf-8-validate', 'fs-native-extensions', 'node-datachannel'],
  // CommonJS dependencies call require() for Node built-ins; give the ES module a real one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  nodePaths: [join(ROOT, 'node_modules')],
  legalComments: 'linked',
  logLevel: 'warning',
})

// 3. Main process.
await build({
  entryPoints: [join(DESKTOP, 'src', 'main.ts')],
  outfile: join(OUT, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
})

// The page's preload (sandboxed: one file, only `electron` from outside).
await build({
  entryPoints: [join(DESKTOP, 'src', 'preload.ts')],
  outfile: join(OUT, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
})

// 4. Icon (the brand icon from the web app) for the window and tray; electron-builder uses resources/icon.png.
copyFileSync(join(ROOT, 'web', 'public', 'icon-512.png'), join(OUT, 'icon.png'))
mkdirSync(join(DESKTOP, 'resources'), { recursive: true })
copyFileSync(join(ROOT, 'web', 'public', 'icon-512.png'), join(DESKTOP, 'resources', 'icon.png'))

// 5. Optional CF model → vendor/reco/cf.bin, which electron-builder ships as a resource when present.
if (process.env.CF_BIN) {
  mkdirSync(join(DESKTOP, 'vendor', 'reco'), { recursive: true })
  copyFileSync(process.env.CF_BIN, join(DESKTOP, 'vendor', 'reco', 'cf.bin'))
  console.log(`CF model staged (${(statSync(process.env.CF_BIN).size / 1048576).toFixed(1)} MiB)`)
}

const kb = f => `${(statSync(join(OUT, f)).size / 1024).toFixed(0)} KiB`
console.log(`desktop build in ${((Date.now() - t0) / 1000).toFixed(1)} s: server.mjs ${kb('server/server.mjs')}, main.cjs ${kb('main.cjs')}`)
