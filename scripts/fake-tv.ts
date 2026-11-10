// A fake Chromecast for testing, so no real TV is ever driven: Cast v2 over TLS on <host>:<port>, the Default
// Media Receiver's replies, and a log of every command (one JSON line each) so a script can fetch the URLs
// the "TV" was given. It plays nothing.
//
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=fake-tv -keyout tv-key.pem -out tv-cert.pem
//   node scripts/fake-tv.ts <lan-ip> 18009 tv-key.pem tv-cert.pem tv.log
//   NEXTTUPP_CAST_DEVICES='Fake TV@<lan-ip>:18009' … npm start
//
// Bind it to the LAN address: cast URLs are only handed to (and served to) the TV's address.
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer, type TLSSocket } from 'node:tls'
import { decodeMessage, encodeFrame, NS, readFrames } from '../server/cast/protocol.ts'

const [host, port, key, cert, log] = process.argv.slice(2)
let app: { sessionId: string; transportId: string } | null = null
let media: { mediaSessionId: number; playerState: string; currentTime: number } | null = null
const volume = { level: 0.5, muted: false }

const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket: TLSSocket) => {
  let buf: Buffer = Buffer.alloc(0)
  socket.on('error', () => {})
  socket.on('data', chunk => {
    buf = readFrames(Buffer.concat([buf, chunk as Buffer]), body => {
      const m = decodeMessage(body)
      const d = m.data ?? {}
      const id = typeof d.requestId === 'number' ? d.requestId : 0
      const reply = (ns: string, data: unknown) => socket.write(encodeFrame({ source: m.destination, destination: m.source, namespace: ns, payload: JSON.stringify(data) }))
      const receiverStatus = () => ({ type: 'RECEIVER_STATUS', requestId: id, status: { volume, applications: app ? [{ appId: 'CC1AD845', ...app }] : [] } })
      const mediaStatus = () => ({ type: 'MEDIA_STATUS', requestId: id, status: media ? [{ ...media, volume }] : [] })
      if (m.namespace === NS.heartbeat && d.type === 'PING') return reply(NS.heartbeat, { type: 'PONG' })
      if (m.namespace === NS.receiver) {
        if (d.type === 'LAUNCH') app = { sessionId: 'S1', transportId: 'web-1' }
        if (d.type === 'STOP') { app = null; media = null }
        if (d.type === 'SET_VOLUME') Object.assign(volume, d.volume)
        appendFileSync(log, JSON.stringify({ type: d.type, volume: d.volume }) + '\n')
        return reply(NS.receiver, receiverStatus())
      }
      if (m.namespace === NS.media) {
        if (d.type === 'LOAD') {
          media = { mediaSessionId: (media?.mediaSessionId ?? 0) + 1, playerState: 'PLAYING', currentTime: Number(d.currentTime) || 0 }
          appendFileSync(log, JSON.stringify({ type: 'LOAD', media: d.media, currentTime: d.currentTime, activeTrackIds: d.activeTrackIds }) + '\n')
        } else if (media) {
          if (d.type === 'PLAY') media.playerState = 'PLAYING'
          if (d.type === 'PAUSE') media.playerState = 'PAUSED'
          if (d.type === 'SEEK') media.currentTime = Number(d.currentTime)
          if (d.type !== 'GET_STATUS') appendFileSync(log, JSON.stringify({ type: d.type, currentTime: d.currentTime }) + '\n')
        }
        return reply(NS.media, mediaStatus())
      }
    })
  })
})
server.listen(Number(port), host, () => console.log(`fake TV on ${host}:${port}`))
