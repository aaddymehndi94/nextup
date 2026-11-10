import { useCallback, useEffect, useRef, useState } from 'react'
import type { DismissReason, MediaType, Rating, TitleState } from '../../shared/types.ts'
import { api } from './api.ts'
import { toast } from './toast.ts'

// What this profile has done with one title (rating, My List, dismissal, progress), with optimistic
// updates: the control changes at once, the server's answer replaces it, and a failure rolls back.

export const EMPTY_STATE: TitleState = { rating: 0, inList: false, progress: null, dismissed: null }

export interface TitleActions {
  state: TitleState | null
  /** The first load has finished (or failed: then `state` stays null and the controls stay disabled). */
  ready: boolean
  rate: (value: Rating) => void
  setInList: (inList: boolean) => void
  dismiss: (reason: DismissReason | null) => void
}

export function useTitleState (type: MediaType, id: string, opts: { initial?: TitleState; source?: string } = {}): TitleActions {
  const [state, setState] = useState<TitleState | null>(opts.initial ?? null)
  const [ready, setReady] = useState(!!opts.initial)
  const latest = useRef(state)
  latest.current = state
  // Only the most recent change may apply its answer or roll back, so quick double taps can't fight.
  const seq = useRef(0)

  useEffect(() => {
    if (opts.initial) return
    let live = true
    api.titleState(type, id)
      .then(s => { if (live && seq.current === 0) setState(s) })
      .catch(() => {})
      .finally(() => { if (live) setReady(true) })
    return () => { live = false }
  }, [type, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = useCallback((patch: (s: TitleState) => TitleState, call: () => Promise<TitleState>, failure: string) => {
    const before = latest.current
    const mine = ++seq.current
    setState(patch(before ?? EMPTY_STATE))
    call()
      .then(s => { if (seq.current === mine) setState(s) })
      .catch(err => {
        if (seq.current === mine) setState(before)
        // A deleted profile is handled by the picker; anything else gets a short note.
        if ((err as { status?: number }).status !== 404) toast(`${failure} ${(err as Error).message}`)
      })
  }, [])

  const rate = useCallback((value: Rating) => change(
    s => ({
      ...s,
      rating: value,
      // The server applies the same rules: a dislike leaves My List; any rating overrides "not interested".
      inList: value === -1 ? false : s.inList,
      dismissed: value !== 0 && s.dismissed === 'not_interested' ? null : s.dismissed,
    }),
    () => api.rate(type, id, value, opts.source),
    'Couldn’t save that rating.',
  ), [change, type, id, opts.source])

  const setInList = useCallback((inList: boolean) => change(
    s => ({ ...s, inList }),
    () => (inList ? api.addToList(type, id) : api.removeFromList(type, id)),
    inList ? 'Couldn’t add to My List.' : 'Couldn’t remove from My List.',
  ), [change, type, id])

  const dismiss = useCallback((reason: DismissReason | null) => change(
    s => ({ ...s, dismissed: reason, inList: reason === 'not_interested' ? false : s.inList }),
    () => (reason ? api.dismiss(type, id, reason) : api.undismiss(type, id)),
    'Couldn’t save that.',
  ), [change, type, id])

  return { state, ready, rate, setInList, dismiss }
}
