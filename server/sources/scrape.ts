import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import type { SwarmHealth } from '../../shared/types.ts'

// BEP 15 UDP tracker scrape: live seeder/leecher counts for many torrents in one round trip.
// Indexer seed counts are often weeks old; this tells the user what the swarm looks like right now.

const PROTOCOL_ID = 0x41727101980n
const ACTION_CONNECT = 0
const ACTION_SCRAPE = 2
/** BEP 15 caps a scrape at ~74 hashes per packet. */
const MAX_HASHES = 70

export function buildConnectRequest (transactionId: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeBigUInt64BE(PROTOCOL_ID, 0)
  b.writeUInt32BE(ACTION_CONNECT, 8)
  b.writeUInt32BE(transactionId, 12)
  return b
}

export function buildScrapeRequest (connectionId: Buffer, transactionId: number, infoHashes: string[]): Buffer {
  const b = Buffer.alloc(16 + 20 * infoHashes.length)
  connectionId.copy(b, 0)
  b.writeUInt32BE(ACTION_SCRAPE, 8)
  b.writeUInt32BE(transactionId, 12)
  infoHashes.forEach((h, i) => Buffer.from(h, 'hex').copy(b, 16 + i * 20))
  return b
}

export function parseScrapeResponse (msg: Buffer, infoHashes: string[]): Record<string, SwarmHealth> {
  const out: Record<string, SwarmHealth> = {}
  infoHashes.forEach((h, i) => {
    const off = 8 + i * 12
    if (off + 12 > msg.length) return
    out[h] = { seeders: msg.readUInt32BE(off), completed: msg.readUInt32BE(off + 4), leechers: msg.readUInt32BE(off + 8) }
  })
  return out
}

function scrapeTracker (trackerUrl: string, infoHashes: string[], timeoutMs: number): Promise<Record<string, SwarmHealth>> {
  return new Promise((resolve, reject) => {
    const u = new URL(trackerUrl)
    const socket = createSocket('udp4')
    const tid = randomBytes(4).readUInt32BE(0)
    const timer = setTimeout(() => finish(new Error(`timeout ${u.host}`)), timeoutMs)
    let done = false
    function finish (err: Error | null, result?: Record<string, SwarmHealth>) {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      if (err) reject(err); else resolve(result!)
    }
    socket.on('error', err => finish(err))
    socket.on('message', msg => {
      if (msg.length < 8 || msg.readUInt32BE(4) !== tid) return
      const action = msg.readUInt32BE(0)
      if (action === ACTION_CONNECT && msg.length >= 16) {
        socket.send(buildScrapeRequest(msg.subarray(8, 16), tid, infoHashes), Number(u.port), u.hostname)
      } else if (action === ACTION_SCRAPE) {
        finish(null, parseScrapeResponse(msg, infoHashes))
      } else {
        finish(new Error(`tracker error ${u.host}: ${msg.subarray(8).toString()}`))
      }
    })
    socket.send(buildConnectRequest(tid), Number(u.port), u.hostname)
  })
}

const SCRAPE_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
]

/** Asks several trackers in parallel and keeps the highest count seen for each hash. */
export async function scrapeHealth (infoHashes: string[], timeoutMs = 4000): Promise<Record<string, SwarmHealth>> {
  const hashes = [...new Set(infoHashes.map(h => h.toLowerCase()).filter(h => /^[0-9a-f]{40}$/.test(h)))]
  const batches: string[][] = []
  for (let i = 0; i < hashes.length; i += MAX_HASHES) batches.push(hashes.slice(i, i + MAX_HASHES))
  const results = await Promise.allSettled(SCRAPE_TRACKERS.flatMap(t => batches.map(b => scrapeTracker(t, b, timeoutMs))))
  const merged: Record<string, SwarmHealth> = {}
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const [h, v] of Object.entries(r.value)) {
      const prev = merged[h]
      if (!prev || v.seeders > prev.seeders) merged[h] = { ...v, leechers: Math.max(v.leechers, prev?.leechers ?? 0) }
    }
  }
  return merged
}
