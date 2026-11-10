// Packages build/ into installers with electron-builder. Its downloads (the Electron runtime zip, AppImage and
// deb tooling) are cached under vendor/cache/, never in the user's home directory.
//   node scripts/dist.mjs --linux | --win | --mac [--x64 | --arm64]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DESKTOP = resolve(import.meta.dirname, '..')
const cache = join(DESKTOP, 'vendor', 'cache')
const env = {
  ...process.env,
  ELECTRON_CACHE: join(cache, 'electron'),
  electron_config_cache: join(cache, 'electron'),
  ELECTRON_BUILDER_CACHE: join(cache, 'electron-builder'),
}
// The electron package has no install script: it fetches (and checksum-verifies) its runtime on demand. The
// config packages node_modules/electron/dist (electronDist), so make sure it is there.
if (!existsSync(join(DESKTOP, 'node_modules', 'electron', 'dist'))) {
  const r = spawnSync(process.execPath, [join(DESKTOP, 'node_modules', 'electron', 'install.js')], { cwd: DESKTOP, env, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const cli = join(DESKTOP, 'node_modules', 'electron-builder', 'cli.js')
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2), '--publish', 'never'], { cwd: DESKTOP, env, stdio: 'inherit' })
process.exit(r.status ?? 1)
