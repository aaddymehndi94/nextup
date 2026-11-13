// The parts of updating that need no Electron: comparing versions, choosing this computer's installer from a
// GitHub release, and reading the release's SHA256SUMS.txt. (Asset names: desktop/electron-builder.yml.)

/** How this copy was installed, which decides the installer it updates from and whether it can do so itself. */
export type InstallKind = 'deb' | 'appimage' | 'windows' | 'mac'

export interface Release {
  version: string
  url: string
  assets: Array<{ name: string; url: string }>
}

/** Parses GitHub's /releases/latest answer; null for a draft, a prerelease or anything unexpected. */
export function parseRelease (json: unknown): Release | null {
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null
  if (!r || typeof r.tag_name !== 'string' || typeof r.html_url !== 'string' || r.draft || r.prerelease || !Array.isArray(r.assets)) return null
  const version = r.tag_name.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null
  const assets = (r.assets as Array<{ name?: unknown; browser_download_url?: unknown }>)
    .filter(a => typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    .map(a => ({ name: a.name as string, url: a.browser_download_url as string }))
  return { version, url: r.html_url, assets }
}

/**
 * Semantic-version order: -1, 0 or 1. A prerelease sorts before its release (0.5.0-dev.3 < 0.5.0), and
 * electron-builder's deb spelling (0.5.0~dev.3) means the same.
 */
export function compareVersions (a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace('~', '-').split(/-(.*)/s)
    return { core: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) < (y.core[i] ?? 0) ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    if (p === q) continue
    const np = /^\d+$/.test(p)
    const nq = /^\d+$/.test(q)
    if (np && nq) return Number(p) < Number(q) ? -1 : 1
    if (np !== nq) return np ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** The release file this copy updates from. */
export function assetName (kind: InstallKind, arch: string): string {
  switch (kind) {
    case 'deb': return `nexttupp-linux-${arch === 'x64' ? 'amd64' : arch}.deb`
    case 'appimage': return `nexttupp-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`
    case 'windows': return `nexttupp-windows-${arch}.exe`
    case 'mac': return `nexttupp-mac-${arch}.dmg`
  }
}

/** "<sha256>  <name>" lines → name → lowercase hex. */
export function parseSums (text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m) sums.set(m[2].trim(), m[1].toLowerCase())
  }
  return sums
}
