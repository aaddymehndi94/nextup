import { useEffect, useSyncExternalStore } from 'react'
import type { MediaType, Rating, TitleState } from '../../shared/types.ts'
import { api, getActiveProfile } from './api.ts'
import { toast } from './toast.ts'

// Ratings and My List for every title, so the buttons under each poster show what this profile chose. Loaded once
// per profile. A change shows at once, the server's answer replaces it, and a failure puts it back.

export interface Mark { rating: Rating; inList: boolean }
const NONE: Mark = { rating: 0, inList: false }

let marks = new Map<string, Mark>()
/** The profile `marks` belongs to, and the profile they were last fetched for (undefined: not yet). */
let owner: string | null | undefined
let fetchedFor: string | null | undefined
let loading = false
/** Changed elsewhere (the taste page): fetch again the next time a poster asks. */
let stale = false
let failedAt = 0
/** Per title, the latest change still waiting for the server: only it may apply its answer or roll back. */
const pending = new Map<string, number>()
let seq = 0

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const emit = () => listeners.forEach(fn => fn())

function load () {
  const profile = getActiveProfile()
  if (loading || (fetchedFor === profile && !stale) || Date.now() - failedAt < 30_000) return
  loading = true
  stale = false
  api.marks()
    .then(m => {
      if (getActiveProfile() !== profile) return
      const next = new Map<string, Mark>()
      for (const [id, rating] of Object.entries(m.ratings)) next.set(id, { rating, inList: false })
      for (const id of m.list) next.set(id, { rating: next.get(id)?.rating ?? 0, inList: true })
      // A tap made while this was loading wins over what the server had before it.
      if (owner === profile) for (const id of pending.keys()) { const mark = marks.get(id); if (mark) next.set(id, mark) }
      marks = next
      owner = fetchedFor = profile
      emit()
    })
    .catch(() => { failedAt = Date.now() })
    .finally(() => { loading = false })
}

const current = (id: string): Mark => (owner === getActiveProfile() ? marks.get(id) ?? NONE : NONE)

function put (id: string, mark: Mark) {
  if (owner !== getActiveProfile()) { marks = new Map(); owner = getActiveProfile() }
  marks.set(id, mark)
  emit()
}

/** This profile's rating and My List state for one title; loads them all the first time it's asked. */
export function useMark (id: string): Mark {
  useEffect(load, [])
  return useSyncExternalStore(subscribe, () => current(id))
}

/** Ratings or My List changed somewhere that doesn't report each title here: posters fetch them again. */
export function marksChanged () { stale = true }

/** Keeps the posters in step with a title's own page (its hero buttons load and save the same state). */
export function noteMark (id: string, s: Pick<TitleState, 'rating' | 'inList'>) {
  const was = current(id)
  if (was.rating !== s.rating || was.inList !== s.inList) put(id, { rating: s.rating, inList: s.inList })
}

function change (id: string, next: Mark, call: () => Promise<TitleState>, failure: string) {
  const before = current(id)
  const mine = ++seq
  pending.set(id, mine)
  put(id, next)
  call()
    .then(s => { if (pending.get(id) === mine) { pending.delete(id); noteMark(id, s) } })
    .catch(err => {
      if (pending.get(id) !== mine) return
      pending.delete(id)
      put(id, before)
      if ((err as { status?: number }).status !== 404) toast(`${failure} ${(err as Error).message}`)
    })
}

/** Like (1), dislike (-1) or clear (0). As on the server, a dislike also takes it out of My List. */
export function rateTitle (type: MediaType, id: string, value: Rating, source?: string) {
  const m = current(id)
  change(id, { rating: value, inList: value === -1 ? false : m.inList }, () => api.rate(type, id, value, source), 'Couldn’t save that rating.')
}

export function setTitleInList (type: MediaType, id: string, inList: boolean) {
  change(id, { ...current(id), inList }, () => (inList ? api.addToList(type, id) : api.removeFromList(type, id)),
    inList ? 'Couldn’t add to My List.' : 'Couldn’t remove from My List.')
}
