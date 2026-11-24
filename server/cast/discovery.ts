import { isIPv4 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import makeMdns from 'multicast-dns'

// Finds Chromecasts and Google/Android TVs on the home network over mDNS (`_googlecast._tcp.local`), over IPv4 and
// IPv6 both: some Wi-Fi drops IPv4 multicast on its way to a computer, and some TVs (a Sony Google TV) answer only
// over IPv6, naming a host with no IPv4 address. Casting works in IPv4, so a TV found that way is asked for its IPv4
// address on its setup port; otherwise this only listens and asks. The sockets open when someone looks for TVs and
// close again after a minute without asking.

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

/** What `multicast-dns` is given: one IPv4 socket for the computer, one IPv6 socket per interface. */
export type MdnsSocket = { type: 'udp4' } | { type: 'udp6'; ip: string; interface: string }

const SERVICE = '_googlecast._tcp.local'
const MDNS_IPV6 = 'ff02::fb'
const FORGET_MS = 10 * 60_000
const IDLE_CLOSE_MS = 60_000
/** TXT `ca` bit for a screen; Nest speakers and speaker groups don't have it. */
const VIDEO_OUT = 1
const SETUP_PORT = 8008

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

function hasNoScreen (txt: Record<string, string>): boolean {
  return /^\d+$/.test(txt.ca ?? '') && (Number(txt.ca) & VIDEO_OUT) === 0
}

/**
 * Where to ask over IPv6: interfaces that also have IPv4, so the home network's and not a container's virtual
 * link. Named the way `dgram` wants a scope: by name, or by number on Windows.
 */
export function ipv6Interfaces (ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = []
  for (const [name, addrs = []] of Object.entries(ifaces)) {
    const linkLocal = addrs.find(a => a.family === 'IPv6' && !a.internal && /^fe80:/i.test(a.address))
    if (!linkLocal || !addrs.some(a => a.family === 'IPv4' && !a.internal)) continue
    out.push(`::%${process.platform === 'win32' ? linkLocal.scopeid : name}`)
  }
  return out
}

/** A Cast device's IPv4 address, from its setup page (`ip_address`); null when it doesn't say. */
export async function ipv4FromSetupInfo (ipv6: string, port = SETUP_PORT): Promise<string | null> {
  try {
    const res = await fetch(`http://[${ipv6}]:${port}/setup/eureka_info?params=net`, { signal: AbortSignal.timeout(2000) })
    const ip = ((await res.json()) as { ip_address?: unknown }).ip_address
    return typeof ip === 'string' && isIPv4(ip) ? ip : null
  } catch {
    return null
  }
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
  private readonly factory: (socket: MdnsSocket) => Mdns
  private readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  private readonly ipv4Of: (ipv6: string) => Promise<string | null>
  private readonly log: (msg: string) => void
  private sockets: Mdns[] = []
  private idle?: NodeJS.Timeout
  private readonly logged = new Set<string>()
  private readonly devices = new Map<string, CastDevice>()
  private readonly srv = new Map<string, { port: number; target: string }>()
  private readonly txt = new Map<string, Record<string, string>>()
  private readonly addr = new Map<string, string>()
  /** Routable IPv6 addresses by host, for a TV that gives no IPv4 one. */
  private readonly addr6 = new Map<string, Set<string>>()
  /** IPv6 addresses already asked for their IPv4 one, since the sockets opened. */
  private readonly lookups = new Set<string>()

  constructor (opts: {
    staticDevices?: CastDevice[] | null
    mdns?: (socket: MdnsSocket) => Mdns
    interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
    ipv4Of?: (ipv6: string) => Promise<string | null>
    log?: (msg: string) => void
  } = {}) {
    this.staticDevices = opts.staticDevices ?? null
    this.factory = opts.mdns ?? (s => makeMdns(s) as unknown as Mdns)
    this.interfaces = opts.interfaces ?? networkInterfaces
    this.ipv4Of = opts.ipv4Of ?? (ipv6 => ipv4FromSetupInfo(ipv6))
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
    const ask = () => this.query([{ name: SERVICE, type: 'PTR' }])
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
    for (const s of this.sockets) s.destroy()
    this.sockets = []
    this.lookups.clear()
    this.logged.clear()
  }

  private open (): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    this.idle.unref()
    if (this.sockets.length) return
    const wanted: MdnsSocket[] = [{ type: 'udp4' }, ...ipv6Interfaces(this.interfaces()).map(i => ({ type: 'udp6' as const, ip: MDNS_IPV6, interface: i }))]
    for (const want of wanted) {
      try {
        const mdns = this.factory(want)
        mdns.on('response', p => this.onResponse(p))
        mdns.on('error', err => this.warn(err))
        mdns.on('warning', err => this.warn(err))
        this.sockets.push(mdns)
      } catch (err) {
        this.warn(err as Error)
      }
    }
  }

  /** Once per message while open: `multicast-dns` retries a failed membership every 5 seconds. */
  private warn (err: Error): void {
    if (this.logged.has(err.message)) return
    this.logged.add(err.message)
    this.log(`cast discovery: ${err.message}`)
  }

  private query (questions: Array<{ name: string; type: string }>): void {
    for (const s of this.sockets) s.query({ questions })
  }

  /** Asks a host known only by IPv6 for its IPv4 address, then takes another look at what's known. */
  private lookUp (target: string): void {
    for (const ipv6 of this.addr6.get(target) ?? []) {
      if (this.lookups.has(ipv6)) continue
      this.lookups.add(ipv6)
      void this.ipv4Of(ipv6).then(ipv4 => {
        if (!ipv4 || this.addr.has(target)) return
        this.addr.set(target, ipv4)
        this.onResponse({})
      }, () => {})
    }
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
      // A link-local address needs an interface to reach; a routable one doesn't.
      else if (r.type === 'AAAA' && typeof r.data === 'string' && !/^fe80:/i.test(r.data)) {
        const host = r.name.toLowerCase()
        this.addr6.set(host, (this.addr6.get(host) ?? new Set()).add(r.data))
      }
    }
    // A target's address can arrive after the SRV that names it.
    for (const [name, s] of this.srv) {
      const target = s.target.toLowerCase()
      if (this.addr.has(target) || this.addr6.has(target)) instances.add(name)
    }
    const ask: Array<{ name: string; type: string }> = []
    for (const name of instances) {
      const s = this.srv.get(name)
      const t = this.txt.get(name)
      if (t && hasNoScreen(t)) continue
      if (!s) ask.push({ name, type: 'SRV' })
      if (!t) ask.push({ name, type: 'TXT' })
      const host = s ? this.addr.get(s.target.toLowerCase()) : undefined
      if (s && !host) {
        ask.push({ name: s.target, type: 'A' })
        this.lookUp(s.target.toLowerCase())
      }
      if (!s || !t || !host) continue
      const id = t.id || name
      this.devices.set(id, { id, name: t.fn || name.split('.')[0], model: t.md || 'Cast device', host, port: s.port, lastSeen: Date.now() })
    }
    if (ask.length) this.query(ask)
  }
}
