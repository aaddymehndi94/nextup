import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { addressFacing, defaultDeviceName, defaultRouteAddress, isLoopback, type LanAddress, lanAddresses, platformOf, type Platform } from './net.ts'
import { type LanClient, LanStore } from './store.ts'

// "Watch on phones and TVs at home". The main server only ever listens on 127.0.0.1. While this is on (and
// the computer is signed in), or while something is being cast to a TV, a second listener answers on each
// home-network address, on the same port, and hands requests to the same app. Every request that arrives
// there must carry a phone's cookie (see gate.ts); a TV gets a tokenised /cast/ URL instead.

export interface DeviceInfo { id: string; name: string; platform: Platform; lan: boolean; lanUrls: string[] }

export interface LanOptions {
  dataDir: string
  port: number
  /** The main listener's host. If it already covers every interface (HOST=0.0.0.0), no second listener. */
  host: string
  signedIn: () => boolean
  log?: (msg: string) => void
  /** For tests: the addresses to bind instead of the machine's. */
  addresses?: () => Promise<LanAddress[]>
}

export class LanService {
  readonly store: LanStore
  readonly port: number
  private readonly opts: LanOptions
  private readonly log: (msg: string) => void
  private handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null
  private servers = new Map<string, Server>()
  private bound: LanAddress[] = []
  private castHolds = 0
  private refreshing: Promise<void> = Promise.resolve()
  private timer?: NodeJS.Timeout

  constructor (opts: LanOptions) {
    this.opts = opts
    this.port = opts.port
    this.store = new LanStore(opts.dataDir)
    this.log = opts.log ?? (() => {})
  }

  /** The main listener already answers on every interface: the gate still applies, but no second listener. */
  get sharedListener (): boolean { return !isLoopback(this.opts.host) && this.opts.host !== 'localhost' }

  /** Phones may connect: signed in, and the setting is on (it is unless turned off). */
  phonesEnabled (): boolean { return this.opts.signedIn() && this.store.enabled !== false }

  name (): string { return this.store.name ?? defaultDeviceName() }

  /** Starts serving `handler` (Fastify's router) on the home network as the settings say, and keeps it current. */
  start (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
    this.handler = handler
    clearInterval(this.timer)
    // Addresses change (DHCP, another Wi-Fi): look again every minute.
    this.timer = setInterval(() => { void this.refresh() }, 60_000)
    this.timer.unref()
    return this.refresh()
  }

  stop (): void {
    clearInterval(this.timer)
    this.handler = null
    for (const s of this.servers.values()) s.close()
    this.servers.clear()
    this.bound = []
  }

  /** Keeps a listener up while a cast runs, whatever the phone setting. Returns the release function. */
  holdForCast (): () => void {
    this.castHolds++
    void this.refresh()
    let released = false
    return () => {
      if (released) return
      released = true
      this.castHolds--
      void this.refresh()
    }
  }

  get listening (): boolean { return this.bound.length > 0 || (this.sharedListener && this.handler !== null) }

  /** Where phones reach this computer, default route first. */
  async addresses (): Promise<LanAddress[]> {
    if (this.opts.addresses) return this.opts.addresses()
    return lanAddresses(await defaultRouteAddress())
  }

  /** http://<address>:<port> for the bound addresses (at most 4), as registered with the cloud. */
  urls (): string[] {
    const list = this.sharedListener ? this.lastSeen : this.bound
    return list.slice(0, 4).map(a => `http://${a.address}:${this.port}`)
  }

  private lastSeen: LanAddress[] = []

  /** The address a device at `peer` (a TV) should use to reach us. */
  async addressFor (peer: string): Promise<string | null> {
    const list = this.bound.length ? this.bound : await this.addresses()
    return addressFacing(peer, list)?.address ?? null
  }

  deviceInfo (): DeviceInfo {
    const lan = this.phonesEnabled()
    return { id: this.store.deviceId, name: this.name(), platform: platformOf(), lan, lanUrls: lan ? this.urls() : [] }
  }

  clients (): LanClient[] { return this.store.clients() }

  /** Re-reads the settings and the machine's addresses, then binds or unbinds to match. Serialised. */
  refresh (): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.apply()).catch(err => this.log(`lan: ${(err as Error).message}`))
    return this.refreshing
  }

  private async apply (): Promise<void> {
    const want = this.handler !== null && (this.phonesEnabled() || this.castHolds > 0)
    const addrs = want ? await this.addresses() : []
    this.lastSeen = addrs
    if (this.sharedListener) return
    const wanted = new Set(addrs.map(a => a.address))
    for (const [address, server] of this.servers) {
      if (wanted.has(address)) continue
      server.close()
      server.closeAllConnections?.()
      this.servers.delete(address)
      this.log(`lan: stopped listening on ${address}:${this.port}`)
    }
    for (const a of addrs) {
      if (this.servers.has(a.address)) continue
      const server = createServer({ keepAliveTimeout: 72_000 }, (req, res) => {
        if (this.handler) this.handler(req, res)
        else { res.statusCode = 503; res.end() }
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(this.port, a.address, () => { server.off('error', reject); resolve() })
        })
        server.on('error', err => this.log(`lan: ${a.address}: ${err.message}`))
        this.servers.set(a.address, server)
        this.log(`lan: listening on http://${a.address}:${this.port} (${a.iface})`)
      } catch (err) {
        this.log(`lan: can’t listen on ${a.address}:${this.port}: ${(err as Error).message}`)
      }
    }
    this.bound = addrs.filter(a => this.servers.has(a.address))
  }
}
