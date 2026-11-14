import makeMdns from 'multicast-dns'

// Finds Chromecasts and Google/Android TVs on the home network over mDNS (`_googlecast._tcp.local`). Only
// listens and asks; it never connects to a device. The socket opens when someone looks for TVs and
// closes again after a minute without asking.

export interface CastDevice {
  /** The device's own id (TXT `id`), stable across restarts. */
  id: string
  /** What its owner called it (TXT `fn`): "Living Room TV". */
  name: string
  /** TXT `md`: "Chromecast", "Google TV Streamer", "BRAVIA 4K VH2"… */
  model: string
  host: string
  port: number
  lastSeen: number
}

const SERVICE = '_googlecast._tcp.local'
const FORGET_MS = 10 * 60_000
const IDLE_CLOSE_MS = 60_000

interface Answer { name: string; type: string; data: unknown }
interface Packet { answers?: Answer[]; additionals?: Answer[] }
export interface Mdns {
  on (event: 'response', fn: (packet: Packet) => void): void
  on (event: 'error' | 'warning', fn: (err: Error) => void): void
  query (q: { questions: Array<{ name: string; type: string }> }): void
  destroy (): void
}

function txtRecord (data: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const b of Array.isArray(data) ? data : [data]) {
    const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? '')
    const i = s.indexOf('=')
    if (i > 0) out[s.slice(0, i).toLowerCase()] = s.slice(i + 1)
  }
  return out
}

/** `Name@host:port,…` from NEXTTUPP_CAST_DEVICES: a fixed list instead of mDNS (tests, a fake receiver). */
export function parseStaticDevices (spec: string | undefined): CastDevice[] | null {
  if (!spec) return null
  return spec.split(',').map(s => s.trim()).filter(Boolean).map((s, i) => {
    const m = /^(.+)@([^:@]+):(\d{1,5})$/.exec(s)
    if (!m) throw new Error(`NEXTTUPP_CAST_DEVICES: expected Name@host:port, got "${s}"`)
    return { id: `static-${i}`, name: m[1], model: 'Test receiver', host: m[2], port: Number(m[3]), lastSeen: Date.now() }
  })
}

export class CastDiscovery {
  private readonly staticDevices: CastDevice[] | null
  private readonly factory: () => Mdns
  private readonly log: (msg: string) => void
  private mdns: Mdns | null = null
  private idle?: NodeJS.Timeout
  private readonly devices = new Map<string, CastDevice>()
  private readonly srv = new Map<string, { port: number; target: string }>()
  private readonly txt = new Map<string, Record<string, string>>()
  private readonly addr = new Map<string, string>()

  constructor (opts: { staticDevices?: CastDevice[] | null; mdns?: () => Mdns; log?: (msg: string) => void } = {}) {
    this.staticDevices = opts.staticDevices ?? null
    this.factory = opts.mdns ?? (() => makeMdns() as unknown as Mdns)
    this.log = opts.log ?? (() => {})
  }

  /**
   * Asks the network and returns what answered within `waitMs`, plus anything seen in the last 10 minutes. Asks
   * twice, a second apart: multicast is easily lost on Wi-Fi, and a TV that missed the first question (or whose
   * answer was lost) answers the second.
   */
  async browse (waitMs = 2500): Promise<CastDevice[]> {
    if (this.staticDevices) return this.staticDevices
    this.open()
    const ask = () => this.mdns?.query({ questions: [{ name: SERVICE, type: 'PTR' }] })
    ask()
    const again = setTimeout(ask, Math.min(1000, waitMs / 2))
    await new Promise(resolve => setTimeout(resolve, waitMs))
    clearTimeout(again)
    return this.list()
  }

  list (): CastDevice[] {
    if (this.staticDevices) return this.staticDevices
    const now = Date.now()
    for (const [id, d] of this.devices) if (now - d.lastSeen > FORGET_MS) this.devices.delete(id)
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get (id: string): CastDevice | undefined {
    return this.list().find(d => d.id === id)
  }

  close (): void {
    clearTimeout(this.idle)
    this.mdns?.destroy()
    this.mdns = null
  }

  private open (): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    this.idle.unref()
    if (this.mdns) return
    const mdns = this.factory()
    mdns.on('response', p => this.onResponse(p))
    mdns.on('error', err => this.log(`cast discovery: ${err.message}`))
    mdns.on('warning', err => this.log(`cast discovery: ${err.message}`))
    this.mdns = mdns
  }

  /** Records arrive in any order and across packets; a device is known once its SRV, TXT and address are. */
  onResponse (packet: Packet): void {
    const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])]
    const instances = new Set<string>()
    for (const r of records) {
      if (r.type === 'PTR' && r.name.toLowerCase() === SERVICE && typeof r.data === 'string') instances.add(r.data)
      else if (r.type === 'SRV' && r.name.toLowerCase().endsWith(`.${SERVICE}`)) {
        const d = r.data as { port: number; target: string }
        this.srv.set(r.name, { port: d.port, target: d.target })
        instances.add(r.name)
      } else if (r.type === 'TXT' && r.name.toLowerCase().endsWith(`.${SERVICE}`)) {
        this.txt.set(r.name, txtRecord(r.data))
        instances.add(r.name)
      } else if (r.type === 'A' && typeof r.data === 'string') this.addr.set(r.name.toLowerCase(), r.data)
    }
    // A target's address can arrive after the SRV that names it.
    for (const [name, s] of this.srv) if (this.addr.has(s.target.toLowerCase())) instances.add(name)
    const ask: Array<{ name: string; type: string }> = []
    for (const name of instances) {
      const s = this.srv.get(name)
      const t = this.txt.get(name)
      if (!s) ask.push({ name, type: 'SRV' })
      if (!t) ask.push({ name, type: 'TXT' })
      const host = s ? this.addr.get(s.target.toLowerCase()) : undefined
      if (s && !host) ask.push({ name: s.target, type: 'A' })
      if (!s || !t || !host) continue
      const id = t.id || name
      this.devices.set(id, { id, name: t.fn || name.split('.')[0], model: t.md || 'Cast device', host, port: s.port, lastSeen: Date.now() })
    }
    if (ask.length && this.mdns) this.mdns.query({ questions: ask })
  }
}
