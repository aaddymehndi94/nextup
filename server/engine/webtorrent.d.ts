// Minimal typings for the parts of webtorrent v3 we use. The package ships none.
declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events'

  export interface TorrentFile {
    name: string
    path: string
    length: number
    offset: number
    downloaded: number
    progress: number
    _startPiece: number
    _endPiece: number
    select(priority?: number): void
    deselect(): void
    [Symbol.asyncIterator](opts?: { start?: number; end?: number }): AsyncIterableIterator<Uint8Array>
  }

  export interface Torrent extends EventEmitter {
    infoHash: string
    name: string
    files: TorrentFile[]
    pieceLength: number
    pieces: unknown[]
    ready: boolean
    done: boolean
    numPeers: number
    downloadSpeed: number
    uploadSpeed: number
    torrentFile?: Uint8Array
    bitfield: { get(index: number): boolean }
    destroyed: boolean
  }

  export interface AddOptions {
    path?: string
    deselect?: boolean
    announce?: string[]
    strategy?: 'sequential' | 'rarest'
    skipVerify?: boolean
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: { utp?: boolean; maxConns?: number; dht?: boolean; lsd?: boolean; webSeeds?: boolean; torrentPort?: number })
    torrents: Torrent[]
    add(torrentId: string | Uint8Array, opts?: AddOptions, onTorrent?: (t: Torrent) => void): Torrent
    get(torrentId: string): Promise<Torrent | null>
    /** The promise settles before the files are closed; the callback once they are. */
    remove(torrentId: string | Torrent, opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): Promise<void>
    destroy(cb?: (err?: Error) => void): void
    /** Bytes per second, or -1 for no limit. */
    throttleUpload(rate: number): boolean | void
  }
}
