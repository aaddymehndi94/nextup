import { createSocket } from 'node:dgram'
import { existsSync, readdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'

// Addresses on the home network, and what counts as a request from this computer itself.

export interface LanAddress { address: string; netmask: string; iface: string }

const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/
/**
 * Container, VM, VPN and hotspot interfaces: not where a phone or TV on the Wi-Fi would find us. Linux and macOS
 * names first, then Windows' adapter names ("Local Area Connection* 10" is Windows' own hotspot and Wi-Fi Direct).
 */
const VIRTUAL = new RegExp('^(' + [
  'docker', 'br-', 'veth', 'virbr', 'vmnet', 'vboxnet', 'lxc', 'lxd', 'cni', 'flannel', 'podman', 'tun', 'tap', 'utun', 'zt', 'tailscale', 'wg', 'ham',
  'vEthernet', 'VirtualBox', 'VMware', 'Hyper-V', 'Local Area Connection\\*', 'Bluetooth', 'Npcap',
  'NordLynx', 'NordVPN', 'CloudflareWARP', 'WARP', 'OpenVPN', 'WireGuard', 'ProtonVPN', 'Proton', 'Mullvad', 'ExpressVPN', 'Surfshark',
  'Windscribe', 'ZeroTier', 'Radmin', 'Hamachi',
].join('|') + ')', 'i')
/** A /32 is a point-to-point link (how VPNs hand out addresses): nothing else on it, so no phone either. */
const POINT_TO_POINT = '255.255.255.255'

export const isPrivateV4 = (ip: string): boolean => PRIVATE_V4.test(ip)

/** The socket's peer is this computer. */
export function isLoopback (addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(addr)
}

/**
 * DNS-rebinding protection: a request from this computer must name it as localhost, 127.0.0.1 or [::1]
 * (with any port). A web page whose own hostname was re-pointed at 127.0.0.1 sends its own name instead.
 */
export function isLoopbackHost (host: string | undefined): boolean {
  if (!host) return false
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(host)
}

/** The local IPv4 address the OS would use to reach the internet (no packet is sent), or null offline. */
export function defaultRouteAddress (): Promise<string | null> {
  return new Promise(resolve => {
    const s = createSocket('udp4')
    const done = (v: string | null) => { try { s.close() } catch { /* closed */ } resolve(v) }
    s.once('error', () => done(null))
    try {
      s.connect(53, '1.1.1.1', () => {
        try { done(s.address().address) } catch { done(null) }
      })
    } catch { done(null) }
  })
}

/** VPN adapters by name, and what to call them. Mesh networks (Tailscale, ZeroTier, Hamachi) leave home alone. */
const VPNS: Array<[RegExp, string]> = [
  [/^(NordLynx|NordVPN)/i, 'NordVPN'], [/^(CloudflareWARP|WARP)/i, 'Cloudflare WARP'], [/^OpenVPN/i, 'OpenVPN'],
  [/^(WireGuard|wg)/i, 'WireGuard'], [/^Proton/i, 'Proton VPN'], [/^Mullvad/i, 'Mullvad'], [/^ExpressVPN/i, 'ExpressVPN'],
  [/^Surfshark/i, 'Surfshark'], [/^Windscribe/i, 'Windscribe'], [/^(tun|utun|ppp|ipsec)/i, 'a VPN'],
]
const MESH = /^(tailscale|zt|ZeroTier|ham|Hamachi|Radmin)/i

/**
 * The VPN that's on, if any: most block the home network, so phones can't reach this computer while it is. A known
 * VPN adapter with an IPv4 address, or the internet through an address on a point-to-point link.
 */
export function activeVpn (defaultAddr: string | null, ifaces = networkInterfaces()): string | null {
  for (const [iface, list] of Object.entries(ifaces)) {
    if (MESH.test(iface)) continue
    const v4 = (list ?? []).filter(a => a.family === 'IPv4' && !a.internal)
    if (!v4.length) continue
    const known = VPNS.find(([re]) => re.test(iface))
    if (known) return known[1]
    if (!VIRTUAL.test(iface) && v4.some(a => a.address === defaultAddr && a.netmask === POINT_TO_POINT)) return 'a VPN'
  }
  return null
}

/** Private IPv4 addresses of real network interfaces, the default route's first. */
export function lanAddresses (preferred: string | null, ifaces = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = []
  for (const [iface, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(iface)) continue
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateV4(a.address) || a.netmask === POINT_TO_POINT) continue
      out.push({ address: a.address, netmask: a.netmask, iface })
    }
  }
  return out.sort((a, b) => Number(b.address === preferred) - Number(a.address === preferred))
}

const toInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0

/** Of `addresses`, the one on the same subnet as `peer` (a TV, say), else the first. */
export function addressFacing (peer: string, addresses: LanAddress[]): LanAddress | null {
  const p = toInt(peer.replace(/^::ffff:/i, ''))
  return addresses.find(a => ((toInt(a.address) ^ p) & toInt(a.netmask)) === 0) ?? addresses[0] ?? null
}

export type Platform = 'linux' | 'mac' | 'windows' | 'other'

export function platformOf (p: string = process.platform): Platform {
  return p === 'linux' ? 'linux' : p === 'darwin' ? 'mac' : p === 'win32' ? 'windows' : 'other'
}

/** "Laptop (Linux)", "Computer (Windows)", "Mac". Never the hostname, which often holds a person's name. */
export function defaultDeviceName (p: string = process.platform, hasBattery = batteryPresent(p)): string {
  if (p === 'darwin') return 'Mac'
  const os = p === 'linux' ? 'Linux' : p === 'win32' ? 'Windows' : 'computer'
  if (os === 'computer') return 'Computer'
  return `${hasBattery ? 'Laptop' : 'Computer'} (${os})`
}

function batteryPresent (p: string): boolean {
  if (p !== 'linux') return false
  try {
    return existsSync('/sys/class/power_supply') && readdirSync('/sys/class/power_supply').some(n => /^BAT/i.test(n))
  } catch { return false }
}

/** A short, human label for a phone or TV from its User-Agent: "Android phone · Chrome", "iPhone · Safari". */
export function clientLabel (ua: string | undefined): string {
  const s = ua ?? ''
  const device = /CrKey|SMART-TV|SmartTV|Android TV|AFT[A-Z]|BRAVIA|Tizen|Web0S|webOS/i.test(s) ? 'TV'
    : /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android phone' : 'Android tablet')
    : /CrOS/.test(s) ? 'Chromebook'
    : /Macintosh/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows PC'
    : /Linux/.test(s) ? 'Linux computer'
    : 'Device'
  const browser = /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /EdgA?\//.test(s) ? 'Edge'
    : /Firefox|FxiOS/.test(s) ? 'Firefox'
    : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : ''
  return browser ? `${device} · ${browser}` : device
}
