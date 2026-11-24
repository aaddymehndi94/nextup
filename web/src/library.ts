import type { LibraryItem } from './api.ts'

const progress = (it: LibraryItem) => it.stats?.progress ?? it.progress ?? 0

/**
 * The viewer's download of this episode or film (by stream id), the most complete when there are several; none
 * while it's still waiting for its torrent's details. Play on a title's page plays it instead of streaming anew.
 */
export function downloadOf (items: LibraryItem[], streamId: string): LibraryItem | null {
  return items.filter(it => it.streamId === streamId && !it.pending)
    .reduce<LibraryItem | null>((best, it) => (best && progress(best) >= progress(it) ? best : it), null)
}
