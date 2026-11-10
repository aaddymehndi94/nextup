// Packages build/ into installers with electron-builder. Its downloads (the Electron runtime zip, AppImage and
// deb tooling) are cached under vendor/cache/, never in the user's home directory.
//   node scripts/dist.mjs --linux | --win
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const DESKTOP = resolve(import.meta.dirname, '..')
const cache = join(DESKTOP, 'vendor', 'cache')
const env = {
  ...process.env,
  ELECTRON_CACHE: join(cache, 'electron'),
  electron_config_cache: join(cache, 'electron'),
  ELECTRON_BUILDER_CACHE: join(cache, 'electron-builder'),
}
const cli = join(DESKTOP, 'node_modules', 'electron-builder', 'cli.js')
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2), '--publish', 'never'], { cwd: DESKTOP, env, stdio: 'inherit' })
process.exit(r.status ?? 1)
