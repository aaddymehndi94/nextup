// Wraps local test videos in torrents and puts them where a server's engine looks, so sessions open without
// any peer: <data>/torrents/<hash>.torrent and <data>/downloads/<hash>/<file>. Prints { file: infoHash }.
// For a scratch NEXTTUPP_DATA only, before that server starts.
//
//   node scripts/seed-local-torrents.mjs <scratch-data-dir> a.mp4 b.mkv … > hashes.json
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
const createTorrent = (await import('create-torrent')).default
const bencode = (await import('bencode')).default
const [dataDir, ...files] = process.argv.slice(2)
const out = {}
for (const f of files) {
  const buf = await new Promise((resolve, reject) => createTorrent(f, { name: basename(f), announceList: [], private: false }, (err, t) => err ? reject(err) : resolve(t)))
  const info = bencode.decode(buf).info
  const hash = createHash('sha1').update(bencode.encode(info)).digest('hex')
  mkdirSync(join(dataDir, 'torrents'), { recursive: true })
  mkdirSync(join(dataDir, 'downloads', hash), { recursive: true })
  writeFileSync(join(dataDir, 'torrents', `${hash}.torrent`), buf)
  copyFileSync(f, join(dataDir, 'downloads', hash, basename(f)))
  out[basename(f)] = hash
}
console.log(JSON.stringify(out))
