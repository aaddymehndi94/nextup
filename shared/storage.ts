// What's saved on the computer that runs nexttupp, for the Storage page (server/storage.ts).

export interface DiskSpace { total: number; free: number }

export interface StoredDownload {
  /** Library id: `${infoHash}-${fileIdx}` */
  id: string
  title: string
  type: 'movie' | 'series'
  imdbId: string
  bytes: number
  paused?: boolean
}

export interface StoredStream {
  infoHash: string
  title: string
  bytes: number
  /** When it was last played (0: unknown). */
  playedAt: number
  /** When it's deleted on its own if nobody plays it again (0: unknown). */
  deletesAt: number
  /** Playing now, here or on a TV: it can't be deleted yet. */
  inUse: boolean
}

export interface StorageReport {
  folder: {
    /** Where new downloads go. */
    path: string
    isDefault: boolean
    /** Earlier folders that still hold downloads. */
    older: string[]
    /** Only on the computer itself; a phone can't choose the computer's folders. */
    canChange: boolean
  }
  /** The disk the download folder is on. */
  disk: DiskSpace | null
  /** The disk nexttupp's own data (music, trailers) is on, when that's another one. */
  dataDisk: DiskSpace | null
  downloads: { bytes: number; items: StoredDownload[] }
  streamed: { bytes: number; items: StoredStream[] }
  music: { bytes: number; songs: number }
  trailers: { bytes: number; count: number }
  /** nexttupp itself: profiles, the recommendation model, helpers. Not removable here. */
  app: { bytes: number }
}
