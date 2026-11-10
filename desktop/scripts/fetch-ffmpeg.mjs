// Downloads the pinned ffmpeg/ffprobe build for one platform into desktop/vendor/ffmpeg/<platform>-<arch>/,
// verifying its SHA-256 before anything is extracted. Re-running is a no-op once the binaries are there.
//
//   node scripts/fetch-ffmpeg.mjs                 # this machine's platform
//   node scripts/fetch-ffmpeg.mjs linux-x64       # explicit target
//
// If a download is blocked, put the archive at vendor/downloads/<file name below> yourself (any browser);
// the checksum is still enforced. Sources and the reasons for them: docs/adr/0005-desktop-app.md.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, cpSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DESKTOP = join(import.meta.dirname, '..')

// BtbN's FFmpeg-Builds (github.com/BtbN/FFmpeg-Builds, now FFmpeg-Builds/FFmpeg-Builds; linked from
// ffmpeg.org/download.html): GPL builds with NVENC, VAAPI, QSV (libvpl), AMF and zimg. The month-end autobuild
// releases are kept long-term, so these URLs stay valid. "shared" = ffmpeg and ffprobe share one set of
// libraries instead of each embedding them, which halves the size.
// FFmpeg 7.1, not 9.0: BtbN builds 9.x against NVENC SDK 13.1 (needs NVIDIA driver ≥ 610; this laptop has 595)
// and 8.x against 13.0 (≥ 570). 7.1 uses SDK 11.1, which works with drivers from 470 on. See docs/adr/0005.
const BTBN = 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34'
export const FFMPEG_BUILDS = {
  'linux-x64': {
    version: 'n7.1.5-1-g7d0e842004',
    url: `${BTBN}/ffmpeg-n7.1.5-1-g7d0e842004-linux64-gpl-shared-7.1.tar.xz`,
    sha256: 'd1726e0a7b3a31f6cc1f77dbc43c7198e83a1d27d362aa333e6b71df62bbbcf2',
  },
  // Pinned but not built or tested here (no Windows machine).
  'win32-x64': {
    version: 'n7.1.5-1-g7d0e842004',
    url: `${BTBN}/ffmpeg-n7.1.5-1-g7d0e842004-win64-gpl-shared-7.1.zip`,
    sha256: '1d0de885a7c8b2aadc3beb25c4bb836dc5b8a8bc82eba2f48e7f3aace7275b71',
  },
}

const target = process.argv[2] ?? `${process.platform}-${process.arch}`
const build = FFMPEG_BUILDS[target]
if (!build) {
  console.error(`No pinned ffmpeg build for ${target}. Known: ${Object.keys(FFMPEG_BUILDS).join(', ')}`)
  process.exit(1)
}

const outDir = join(DESKTOP, 'vendor', 'ffmpeg', target)
const exe = target.startsWith('win32') ? '.exe' : ''
const stamp = join(outDir, '.sha256')
if (existsSync(join(outDir, 'bin', `ffmpeg${exe}`)) && existsSync(stamp) && (await readText(stamp)) === build.sha256) {
  console.log(`ffmpeg ${build.version} for ${target} already in ${outDir}`)
  process.exit(0)
}

const downloads = join(DESKTOP, 'vendor', 'downloads')
mkdirSync(downloads, { recursive: true })
const archive = join(downloads, build.url.split('/').pop())

if (!existsSync(archive) || (await sha256(archive)) !== build.sha256) {
  console.log(`Downloading ${build.url}`)
  const res = await fetch(build.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}. Place the file at ${archive} manually.`)
  const tmp = `${archive}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  renameSync(tmp, archive)
}
const actual = await sha256(archive)
if (actual !== build.sha256) {
  rmSync(archive)
  throw new Error(`Checksum mismatch for ${archive}: expected ${build.sha256}, got ${actual}. Deleted.`)
}
console.log(`SHA-256 verified: ${actual}`)

// Extract into a fresh directory, then keep only what the app runs: ffmpeg, ffprobe and their libraries.
const scratch = join(downloads, `extract-${target}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
const tar = spawnSync('tar', ['-xf', archive, '-C', scratch], { stdio: 'inherit' })
if (tar.status !== 0) throw new Error('tar failed to extract the archive')
const [top] = readdirSync(scratch)
const src = join(scratch, top)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'bin'), { recursive: true })
for (const name of [`ffmpeg${exe}`, `ffprobe${exe}`]) cpSync(join(src, 'bin', name), join(outDir, 'bin', name))
if (exe) {
  // Windows shared builds keep their DLLs next to the executables.
  for (const f of readdirSync(join(src, 'bin'))) if (f.endsWith('.dll')) cpSync(join(src, 'bin', f), join(outDir, 'bin', f))
} else {
  // Linux shared builds find their libraries through RPATH $ORIGIN/../lib, by soname (libavcodec.so.63).
  // Keep each library once under its soname, with no symlinks, so packaging can't duplicate them.
  mkdirSync(join(outDir, 'lib'), { recursive: true })
  for (const f of readdirSync(join(src, 'lib'), { withFileTypes: true })) {
    const m = f.name.match(/^(.+\.so\.\d+)\.\d+\.\d+$/)
    if (f.isFile() && m) cpSync(join(src, 'lib', f.name), join(outDir, 'lib', m[1]))
  }
  for (const name of ['ffmpeg', 'ffprobe']) chmodSync(join(outDir, 'bin', name), 0o755)
}
cpSync(join(src, 'LICENSE.txt'), join(outDir, 'LICENSE.txt'))
rmSync(scratch, { recursive: true, force: true })
await import('node:fs/promises').then(fs => fs.writeFile(stamp, build.sha256))

const size = dirSize(outDir)
console.log(`ffmpeg ${build.version} for ${target} → ${outDir} (${(size / 1048576).toFixed(0)} MiB)`)

function sha256 (file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

async function readText (file) {
  return (await import('node:fs/promises')).readFile(file, 'utf8').then(s => s.trim())
}

function dirSize (dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : e.isSymbolicLink() ? 0 : statSync(p).size
  }
  return total
}
