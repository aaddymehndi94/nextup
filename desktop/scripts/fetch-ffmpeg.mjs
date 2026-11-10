// Downloads the pinned ffmpeg/ffprobe build for one platform into desktop/vendor/ffmpeg/<platform>-<arch>/,
// verifying its SHA-256 before anything is extracted. Re-running is a no-op once the binaries are there.
//
//   node scripts/fetch-ffmpeg.mjs                 # this machine's platform
//   node scripts/fetch-ffmpeg.mjs linux-x64       # explicit target: linux-x64, win32-x64, darwin-arm64, darwin-x64
//
// If a download is blocked, put the archive at vendor/downloads/<file name below> yourself (any browser);
// the checksum is still enforced. Sources and the reasons for them: docs/adr/0005-desktop-app.md.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, cpSync, chmodSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
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
// macOS: Martin Riedl's build server (ffmpeg.martin-riedl.de; BtbN has no macOS builds). Static release builds
// signed with his Developer ID, with VideoToolbox (h264_videotoolbox), libx264 and zimg. One zip per program,
// each holding just the binary; every zip's SHA-256 is published next to it (<url>.sha256) and matches the pin.
// 9.0.2 rather than 7.1: the 7.1 pin above is only for NVIDIA's driver floor, and macOS has no NVENC.
// Riedl stops Intel release builds in January 2027, so the x64 pin is likely the last one.
const RIEDL = 'https://ffmpeg.martin-riedl.de/download/macos'
const RIEDL_LICENSE = `FFmpeg 9.0.2, static build from Martin Riedl's FFmpeg Build Server (https://ffmpeg.martin-riedl.de).
Configured with --enable-gpl --enable-version3: these binaries are licensed under the GNU GPL, version 3 or later.
FFmpeg source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
Build scripts and the versions of every bundled library: https://git.martin-riedl.de/ffmpeg/build-script
`
export const FFMPEG_BUILDS = {
  'linux-x64': {
    version: 'n7.1.5-1-g7d0e842004',
    url: `${BTBN}/ffmpeg-n7.1.5-1-g7d0e842004-linux64-gpl-shared-7.1.tar.xz`,
    sha256: 'd1726e0a7b3a31f6cc1f77dbc43c7198e83a1d27d362aa333e6b71df62bbbcf2',
  },
  'win32-x64': {
    version: 'n7.1.5-1-g7d0e842004',
    url: `${BTBN}/ffmpeg-n7.1.5-1-g7d0e842004-win64-gpl-shared-7.1.zip`,
    sha256: '1d0de885a7c8b2aadc3beb25c4bb836dc5b8a8bc82eba2f48e7f3aace7275b71',
  },
  'darwin-arm64': {
    version: '9.0.2',
    license: RIEDL_LICENSE,
    files: {
      ffmpeg: { file: 'riedl-macos-arm64-9.0.2-ffmpeg.zip', url: `${RIEDL}/arm64/1789931890_9.0.2/ffmpeg.zip`, sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924' },
      ffprobe: { file: 'riedl-macos-arm64-9.0.2-ffprobe.zip', url: `${RIEDL}/arm64/1789931890_9.0.2/ffprobe.zip`, sha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6' },
    },
  },
  'darwin-x64': {
    version: '9.0.2',
    license: RIEDL_LICENSE,
    files: {
      ffmpeg: { file: 'riedl-macos-amd64-9.0.2-ffmpeg.zip', url: `${RIEDL}/amd64/1789931006_9.0.2/ffmpeg.zip`, sha256: '7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4' },
      ffprobe: { file: 'riedl-macos-amd64-9.0.2-ffprobe.zip', url: `${RIEDL}/amd64/1789931006_9.0.2/ffprobe.zip`, sha256: '2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd' },
    },
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
const archives = build.files ? Object.values(build.files) : [{ url: build.url, sha256: build.sha256 }]
const pin = archives.map(a => a.sha256).join(' ')
if (existsSync(join(outDir, 'bin', `ffmpeg${exe}`)) && existsSync(stamp) && (await readText(stamp)) === pin) {
  console.log(`ffmpeg ${build.version} for ${target} already in ${outDir}`)
  process.exit(0)
}

const downloads = join(DESKTOP, 'vendor', 'downloads')
mkdirSync(downloads, { recursive: true })
const paths = []
for (const a of archives) paths.push(await fetchVerified(a))

// Extract into a fresh directory, then keep only what the app runs: ffmpeg, ffprobe and their libraries.
const scratch = join(downloads, `extract-${target}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'bin'), { recursive: true })
if (build.files) {
  // Riedl (macOS): one static binary per zip, no libraries.
  Object.keys(build.files).forEach((name, i) => {
    const dir = join(scratch, name)
    mkdirSync(dir)
    extract(paths[i], dir)
    cpSync(join(dir, name), join(outDir, 'bin', name))
    chmodSync(join(outDir, 'bin', name), 0o755)
  })
  await writeFile(join(outDir, 'LICENSE.txt'), build.license)
} else {
  extract(paths[0], scratch)
  const [top] = readdirSync(scratch)
  const src = join(scratch, top)
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
}
rmSync(scratch, { recursive: true, force: true })
await writeFile(stamp, pin)

const size = dirSize(outDir)
console.log(`ffmpeg ${build.version} for ${target} → ${outDir} (${(size / 1048576).toFixed(0)} MiB)`)

/** Downloads an archive into vendor/downloads, unless a verified copy is already there, and checks its SHA-256. */
async function fetchVerified ({ url, sha256: want, file }) {
  const archive = join(downloads, file ?? url.split('/').pop())
  if (!existsSync(archive) || (await sha256(archive)) !== want) {
    console.log(`Downloading ${url}`)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}. Place the file at ${archive} manually.`)
    const tmp = `${archive}.part`
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
    renameSync(tmp, archive)
  }
  const actual = await sha256(archive)
  if (actual !== want) {
    rmSync(archive)
    throw new Error(`Checksum mismatch for ${archive}: expected ${want}, got ${actual}. Deleted.`)
  }
  console.log(`SHA-256 verified: ${actual}  ${url.split('/').slice(-2).join('/')}`)
  return archive
}

/**
 * Unpacks a .tar.xz or .zip. Windows uses its own bsdtar (System32\tar.exe), which reads zips; Git Bash's GNU tar,
 * which can come first on PATH, can't. Elsewhere zips go through unzip.
 */
function extract (archive, dir) {
  const [cmd, args] = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dir]]
    : archive.endsWith('.zip') ? ['unzip', ['-q', '-o', archive, '-d', dir]] : ['tar', ['-xf', archive, '-C', dir]]
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} failed to extract ${archive}${r.error ? `: ${r.error.message}` : ''}`)
}

function sha256 (file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

async function readText (file) {
  return (await readFile(file, 'utf8')).trim()
}

function dirSize (dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : e.isSymbolicLink() ? 0 : statSync(p).size
  }
  return total
}
