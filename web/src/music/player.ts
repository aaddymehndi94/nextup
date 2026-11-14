import { useSyncExternalStore } from 'react'
import type { MusicCastMode, MusicCastStatus, MusicRadioRequest, MusicTrack } from '../../../shared/music.ts'
import { artSize } from '../../../shared/music.ts'
import type { DesktopNowPlaying } from '../../../shared/desktop.ts'
import { getActiveProfile } from '../api.ts'
import { desktop } from '../desktop.ts'
import { isPrivate } from '../private.ts'
import { toast } from '../toast.ts'
import { audioUrl, musicApi } from './api.ts'

// The music player: one <audio> element for the whole app (it outlives pages and profile switches), a queue,
// and the phone's lock-screen controls (Media Session). Songs come from the computer, which fetches each one
// the first time it's played; the next two are asked for ahead so they start at once. When the queue runs
// low it keeps going with a radio from what's playing. While a TV plays the music, this is its remote.

export interface PlayerState {
  queue: MusicTrack[]
  index: number
  /** Where the queue came from: "Your daily mix", "Kesariya radio". */
  from: string
  playing: boolean
  /** Waiting for the computer (fetching the song) or the network. */
  buffering: boolean
  time: number
  duration: number
  /** Likes known so far, by song id. */
  ratings: Record<string, 1 | -1 | 0>
  /** A TV is playing (this page is its remote). */
  cast: MusicCastStatus | null
  /** The full-screen player is open, and what it shows. */
  open: boolean
  view: 'art' | 'lyrics' | 'queue'
}

const KEY = 'nexttupp:music:v1'
function makeAudio (): HTMLAudioElement {
  const el = new Audio()
  el.preload = 'auto'
  // Only nexttupp's own "Play on a TV": a browser-made cast belongs to this tab and ends when the phone sleeps.
  el.disableRemotePlayback = true
  return el
}
/** The element playing the current song. Songs alternate between two, so one can fade out as the next fades in. */
let audio = typeof Audio === 'function' ? makeAudio() : (null as unknown as HTMLAudioElement)
let spare = typeof Audio === 'function' ? makeAudio() : (null as unknown as HTMLAudioElement)

// ---- Fades ----

const FADE_KEY = 'nexttupp:music:crossfade'
/** Seconds the end of one song overlaps the start of the next (0: off). */
export const CROSSFADE_CHOICES = [0, 3, 6, 10] as const
let crossfade = (() => { try { const v = Number(localStorage.getItem(FADE_KEY) ?? 6); return CROSSFADE_CHOICES.includes(v as 0) ? v : 6 } catch { return 6 } })()
/** iOS ignores an element's volume, so overlapping there would just play two songs at once: no fades. */
const canFade = (() => { if (!audio) return false; audio.volume = 0.5; const ok = audio.volume === 0.5; audio.volume = 1; return ok })()
/**
 * Fades, and handing a song over to the other element, only while the page is on screen. With the phone locked
 * or the browser in the background, Chrome on Android lets the element that's playing go on to the next song,
 * but a second element starting (or one waiting on a fade timer at volume 0) kills the music.
 */
const fades = () => canFade && !document.hidden
const fadeListeners = new Set<() => void>()
export const useCrossfade = (): number => useSyncExternalStore(fn => { fadeListeners.add(fn); return () => { fadeListeners.delete(fn) } }, () => (canFade ? crossfade : -1))
export function setCrossfade (seconds: number) {
  crossfade = seconds
  try { localStorage.setItem(FADE_KEY, String(seconds)) } catch { /* storage blocked */ }
  fadeListeners.forEach(fn => fn())
}

const ramps = new Map<HTMLAudioElement, { id: number; finish: () => void }>()
/** Abandons a fade where it is (its promise never settles, so what was to follow it doesn't happen). */
function stopRamp (el: HTMLAudioElement) {
  const r = ramps.get(el)
  if (r) { clearInterval(r.id); ramps.delete(el) }
}
/**
 * Moves an element's volume to `to` over `sec` (equal-power curve, so a crossfade doesn't dip). Timed by the clock,
 * not by frames, so it finishes on time in a background tab too.
 */
function ramp (el: HTMLAudioElement, to: number, sec: number): Promise<void> {
  stopRamp(el)
  const from = el.volume
  if (!fades() || sec <= 0) { el.volume = to; return Promise.resolve() }
  const start = Date.now()
  return new Promise(resolve => {
    const finish = () => { stopRamp(el); el.volume = to; resolve() }
    const id = window.setInterval(() => {
      const k = Math.min(1, (Date.now() - start) / (sec * 1000))
      if (k >= 1) { finish(); return }
      // Rising: sin; falling: 1 - cos (so the outgoing volume follows cos). sin² + cos² = 1 keeps the loudness even.
      const curve = to > from ? Math.sin(k * Math.PI / 2) : 1 - Math.cos(k * Math.PI / 2)
      el.volume = Math.max(0, Math.min(1, from + (to - from) * curve))
    }, 40)
    ramps.set(el, { id, finish })
  })
}

/** Lets the outgoing element fade away, then frees it. */
function fadeAway (el: HTMLAudioElement, sec: number) {
  if (el.paused || !el.src) { el.pause(); el.removeAttribute('src'); el.load(); return }
  void ramp(el, 0, sec).then(() => {
    if (el === audio) return
    el.pause()
    el.removeAttribute('src')
    el.load()
    el.volume = 1
  })
}

const urlOf = (id: string) => new URL(audioUrl(id), location.href).href

/** Stops the other element too (a song still fading out, or the next one getting ready). */
function silenceSpare () {
  stopRamp(spare)
  spare.pause()
  if (spare.src) { spare.removeAttribute('src'); spare.load() }
  spare.volume = 1
}

let state: PlayerState = {
  queue: [], index: -1, from: '', playing: false, buffering: false, time: 0, duration: 0, ratings: {}, cast: null, open: false, view: 'art',
}
/** What to continue with when the queue runs low (a radio from a song, an artist, words or their taste). */
let context: MusicRadioRequest | null = null
let continuing = false
/** Seconds actually heard of the current song (not where it is: seeking doesn't count). */
let heard = 0
let lastTick = 0
let failures = 0
let resumeAt = 0
let castPoll: number | undefined
/** When the last TV status arrived, to move the clock on between polls. */
let castAt = 0
/** What the desktop app was last told is playing. */
let toDesktop = ''

const listeners = new Set<() => void>()
function set (patch: Partial<PlayerState>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
  if ('queue' in patch || 'index' in patch) save()
}

export const usePlayer = (): PlayerState => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => state)
export const playerState = () => state

/** Where the song is right now, smoothly (between the element's or the TV's updates). */
export function liveTime (): number {
  if (state.cast?.active) return state.time + (state.cast.state === 'playing' ? (Date.now() - castAt) / 1000 : 0)
  return audio?.src ? audio.currentTime : state.time
}
export const current = (): MusicTrack | undefined => state.queue[state.index]

// ---- Saved between visits (this browser only) ----

function save () {
  try {
    localStorage.setItem(KEY, JSON.stringify({ queue: state.queue.slice(0, 300), index: state.index, from: state.from, context, time: audio?.currentTime ?? 0 }))
  } catch { /* storage full or blocked */ }
}

function restore () {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { queue: MusicTrack[]; index: number; from: string; context: MusicRadioRequest | null; time: number } | null
    if (!s?.queue?.length || s.index < 0 || s.index >= s.queue.length) return
    context = s.context
    resumeAt = s.time || 0
    state = { ...state, queue: s.queue, index: s.index, from: s.from, time: resumeAt, duration: s.queue[s.index].duration }
  } catch { /* nothing saved */ }
}
if (audio) restore()

// ---- Listens ----

function report (how: 'ended' | 'skipped' | 'left') {
  const t = current()
  if (!t || heard < 1 || isPrivate()) { heard = 0; return }
  const played = heard
  heard = 0
  if (how === 'left') {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const profile = getActiveProfile()
    if (profile) headers['x-nexttupp-profile'] = profile
    try { fetch('/api/music/listen', { method: 'POST', headers, body: JSON.stringify({ trackId: t.id, played, how }), keepalive: true }).catch(() => {}) } catch { /* ignore */ }
    return
  }
  musicApi.listen(t.id, played, how).catch(() => {})
}

// ---- Playing ----

function mediaSession (t: MusicTrack | undefined) {
  if (!('mediaSession' in navigator)) return
  if (!t) { navigator.mediaSession.metadata = null; return }
  const art = t.album?.cover ?? t.artist.picture
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.credit ?? t.artist.name,
    album: t.album?.title ?? state.from,
    artwork: art ? [256, 512, 1000].map(px => ({ src: artSize(art, px)!, sizes: `${px}x${px}`, type: 'image/jpeg' })) : [],
  })
}

function positionState () {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
  const d = audio.duration
  if (!Number.isFinite(d) || d <= 0) return
  try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: audio.playbackRate || 1 }) } catch { /* bad values */ }
}

/** Starts song `index` (from `at` seconds). */
function load (index: number, at = 0, autoplay = true, fade = 0) {
  const t = state.queue[index]
  if (!t) return
  heard = 0
  set({ index, time: at, duration: t.duration, buffering: autoplay, playing: autoplay && !state.cast?.active })
  mediaSession(t)
  if (state.cast?.active) return
  // On screen, a song that's playing hands over to the other element: it fades out (briefly for a skip) as this
  // one starts. The other element may already hold this song, ready near the end of the last one: then it starts
  // at once. Off screen, the same element plays the next song (see `fades`).
  const outgoing = audio
  const playing = !outgoing.paused && !!outgoing.src
  const ready = spare.src === urlOf(t.id)
  if (autoplay && fades() && (playing || ready)) {
    audio = spare
    spare = outgoing
    if (playing) fadeAway(outgoing, fade || 0.35)
    else { outgoing.removeAttribute('src'); outgoing.load() }
  } else {
    silenceSpare()
  }
  if (audio.src !== urlOf(t.id)) audio.src = audioUrl(t.id)
  if (at > 0 || audio.currentTime > 0) audio.currentTime = at
  stopRamp(audio)
  audio.volume = autoplay && fades() ? 0 : 1
  if (autoplay) {
    audio.play()
      .then(() => ramp(audio, 1, fade || 0.25))
      .catch(err => { audio.volume = 1; if ((err as Error).name === 'NotAllowedError') set({ playing: false, buffering: false }) })
  }
  // The next two get ready on the computer while this one plays.
  const next = state.queue.slice(index + 1, index + 3).map(x => x.id)
  if (next.length) musicApi.prefetch(next).catch(() => {})
  if (!(t.id in state.ratings)) musicApi.track(t.id).then(r => set({ ratings: { ...state.ratings, [t.id]: r.rating } })).catch(() => {})
  void keepGoing()
}

/** Plays a list from `index`. `then`: what to continue with when it runs out (default: a radio from its last song). */
export function playList (tracks: MusicTrack[], index = 0, from = '', then?: MusicRadioRequest | null) {
  if (!tracks.length) return
  if (current()) report('skipped')
  context = then === undefined ? null : then
  failures = 0
  set({ queue: tracks.slice(0, 500), from })
  if (state.cast?.active) {
    musicApi.castStart({ deviceId: state.cast.device!.id, queue: state.queue.map(t => t.id), index, t: 0, mode: state.cast.mode ?? 'audio' }).then(followCast).catch(err => toast(err.message))
    set({ index })
    return
  }
  load(index)
}

/** A radio from a song, an artist or words, played at once. */
export async function playRadio (req: MusicRadioRequest, fallbackTitle = 'Radio') {
  try {
    const r = await musicApi.radio(req)
    if (!r.tracks.length) { toast('Nothing to play for that yet.'); return }
    playList(r.tracks, 0, r.title || fallbackTitle, { ...req, exclude: undefined })
  } catch (err) {
    toast((err as Error).message)
  }
}

/** Adds more when three or fewer songs are left. */
async function keepGoing () {
  if (continuing || state.queue.length - state.index > 3) return
  const last = state.queue.at(-1)
  if (!last) return
  continuing = true
  try {
    const req = context ?? { track: last.id }
    const r = await musicApi.radio({ ...req, exclude: state.queue.map(t => t.id).slice(-400) })
    const have = new Set(state.queue.map(t => t.id))
    const more = r.tracks.filter(t => !have.has(t.id))
    if (more.length) {
      if (!context) context = req
      set({ queue: [...state.queue, ...more].slice(-500) })
      if (state.cast?.active) musicApi.castQueue(state.queue.map(t => t.id)).then(followCast).catch(() => {})
    }
  } catch { /* try again on the next song */ } finally {
    continuing = false
  }
}

export function toggle () {
  if (state.cast?.active) { castControl({ action: state.cast.state === 'playing' ? 'pause' : 'play' }); return }
  const t = current()
  if (!t) return
  if (!audio.src) { load(state.index, resumeAt); resumeAt = 0; return }
  const el = audio
  if (el.paused) {
    el.volume = fades() ? 0 : 1
    el.play().then(() => ramp(el, 1, 0.3)).catch(() => { el.volume = 1 })
  } else {
    void ramp(el, 0, 0.2).then(() => { if (el === audio) { el.pause(); el.volume = 1 } })
  }
}

/** Play or pause from the system's media controls (lock screen, notification, headphones). */
function playFromSystem (play: boolean) {
  if (state.cast?.active) {
    if ((state.cast.state === 'playing') !== play) castControl({ action: play ? 'play' : 'pause', why: 'system' })
    return
  }
  if (play === !audio.paused && audio.src) return
  toggle()
}

export function pause () { if (!state.cast?.active && !audio.paused) audio.pause() }

export function next () {
  if (state.cast?.active) { castControl({ action: 'next' }); return }
  if (state.index + 1 >= state.queue.length) { void keepGoing(); return }
  report('skipped')
  load(state.index + 1)
}

export function prev () {
  if (state.cast?.active) { castControl({ action: 'prev' }); return }
  if (audio.currentTime > 5 || state.index === 0) { seek(0); return }
  report('skipped')
  load(state.index - 1)
}

export function jump (index: number) {
  if (state.cast?.active) { castControl({ action: 'jump', index }); return }
  if (index === state.index) return
  report('skipped')
  load(index)
}

export function seek (t: number) {
  if (state.cast?.active) { castControl({ action: 'seek', t }); set({ time: t }); return }
  if (!audio.src) { resumeAt = t; set({ time: t }); return }
  audio.currentTime = Math.max(0, Math.min(t, (audio.duration || state.duration) - 0.5))
  set({ time: audio.currentTime })
}

/** Plays this song after the current one. */
export function playNext (t: MusicTrack) {
  if (!current()) { playList([t], 0, t.title); return }
  const q = state.queue.filter((x, i) => x.id !== t.id || i === state.index)
  const at = q.findIndex(x => x.id === current()!.id)
  q.splice(at + 1, 0, t)
  set({ queue: q, index: at })
  if (state.cast?.active) musicApi.castQueue(q.map(x => x.id), at).then(followCast).catch(() => {})
  toast(`“${t.title}” plays next`)
}

export function addToQueue (t: MusicTrack) {
  if (!current()) { playList([t], 0, t.title); return }
  if (state.queue.some(x => x.id === t.id)) { toast('Already in the queue'); return }
  set({ queue: [...state.queue, t] })
  if (state.cast?.active) musicApi.castQueue(state.queue.map(x => x.id)).then(followCast).catch(() => {})
  toast(`Added “${t.title}” to the queue`)
}

export function removeAt (index: number) {
  if (index === state.index) return
  const q = state.queue.filter((_, i) => i !== index)
  const at = index < state.index ? state.index - 1 : state.index
  set({ queue: q, index: at })
  if (state.cast?.active) musicApi.castQueue(q.map(x => x.id), at).then(followCast).catch(() => {})
}

export function stopAndClear () {
  report('skipped')
  silenceSpare()
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  context = null
  set({ queue: [], index: -1, from: '', playing: false, buffering: false, time: 0, open: false })
  mediaSession(undefined)
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'
  save()
}

/**
 * Closes the player: the music stops (on the TV too), the bar goes, and with no song loaded the phone's
 * lock-screen notification goes as well. Undo brings the queue back, paused where it was.
 */
export function closeMusic () {
  if (!current()) return
  const was = { queue: state.queue, index: state.index, from: state.from, context, time: state.cast?.active ? state.time : audio.src ? audio.currentTime : resumeAt }
  if (state.cast?.active) {
    // Not through followCast: that would put the TV's queue back.
    window.clearInterval(castPoll)
    castPoll = undefined
    set({ cast: null })
    musicApi.castStop().catch(() => {})
  }
  stopAndClear()
  toast('Music closed.', {
    label: 'Undo',
    run: () => {
      context = was.context
      resumeAt = was.time
      set({ queue: was.queue, index: was.index, from: was.from, time: was.time })
      mediaSession(current())
      save()
    },
  })
}

export async function rate (t: MusicTrack, rating: 1 | -1 | 0) {
  const before = state.ratings[t.id] ?? 0
  set({ ratings: { ...state.ratings, [t.id]: rating } })
  try {
    await musicApi.rate('track', t.id, rating)
    if (rating === -1 && current()?.id === t.id) { toast('Got it. You won’t hear it again.'); next() }
  } catch (err) {
    set({ ratings: { ...state.ratings, [t.id]: before } })
    toast((err as Error).message)
  }
}

export const openPlayer = (view?: PlayerState['view']) => {
  if (!state.open) history.pushState({ ...history.state, nowPlaying: true }, '')
  set({ open: true, ...(view ? { view } : {}) })
}
export const closePlayer = () => {
  if (state.open && history.state?.nowPlaying) history.back()
  else set({ open: false })
}
export const setView = (view: PlayerState['view']) => set({ view })
if (typeof window !== 'undefined') window.addEventListener('popstate', () => { if (state.open && !history.state?.nowPlaying) set({ open: false }) })

// ---- The <audio> element ----

/** Near the end of a song: get the next one ready on the spare element, then overlap them. */
function nearEnd (el: HTMLAudioElement) {
  const left = el.duration - el.currentTime
  if (!Number.isFinite(left) || state.cast?.active || el.paused) return
  const t = current()
  const n = state.queue[state.index + 1]
  if (!t || !n || !fades()) return
  // Ready the next song a little before it's needed, so it starts without a gap.
  if (left < crossfade + 10 && !spare.src) { spare.src = audioUrl(n.id); spare.load() }
  // Album tracks run into each other as recorded; very short songs don't overlap.
  const sameAlbum = !!t.album?.id && t.album.id === n.album?.id
  if (!canFade || crossfade <= 0 || sameAlbum || el.duration < 45 || left > crossfade) return
  // Only when the next song can play right away; otherwise this one simply ends.
  if (spare.src !== urlOf(n.id) || spare.readyState < 3) return
  report('ended')
  load(state.index + 1, 0, true, crossfade)
}

function wire (el: HTMLAudioElement) {
  const mine = (fn: () => void) => () => { if (el === audio) fn() }
  el.addEventListener('playing', mine(() => { failures = 0; set({ playing: true, buffering: false }); positionState() }))
  el.addEventListener('pause', mine(() => { set({ playing: false }); save(); positionState() }))
  el.addEventListener('waiting', mine(() => set({ buffering: true })))
  el.addEventListener('canplay', mine(() => set({ buffering: false })))
  el.addEventListener('loadedmetadata', mine(() => { if (Number.isFinite(el.duration)) set({ duration: el.duration }); positionState() }))
  el.addEventListener('seeked', mine(positionState))
  el.addEventListener('timeupdate', mine(() => {
    const now = el.currentTime
    const d = now - lastTick
    if (!el.paused && d > 0 && d < 2) heard += d
    lastTick = now
    if (Math.abs(now - state.time) >= 0.25) set({ time: now })
    nearEnd(el)
  }))
  el.addEventListener('ended', mine(() => {
    report('ended')
    if (state.index + 1 < state.queue.length) load(state.index + 1)
    else { set({ playing: false }); void keepGoing().then(() => { if (state.index + 1 < state.queue.length) load(state.index + 1) }) }
  }))
  el.addEventListener('error', mine(() => onError()))
}

function onError () {
  const t = current()
  if (!t || !audio.src) return
  set({ playing: false, buffering: false })
  // The <audio> element can't read why; ask once (a one-byte range, so nothing big comes back).
  fetch(audioUrl(t.id), { headers: { range: 'bytes=0-0' } }).then(r => (r.ok ? null : r.json().catch(() => null))).then((b: { error?: string } | null) => {
    const why = b?.error ?? 'It didn’t load.'
    if (/set up music/i.test(why)) { toast(why); return }
    failures++
    toast(`Couldn’t play “${t.title}”. ${why}${failures < 3 && state.index + 1 < state.queue.length ? ' Playing the next song.' : ''}`)
    if (failures < 3 && state.index + 1 < state.queue.length) setTimeout(() => { if (current()?.id === t.id) load(state.index + 1) }, 1200)
  }).catch(() => toast(`Couldn’t play “${t.title}”. Is nexttupp running on your computer?`))
}

if (audio) {
  wire(audio)
  wire(spare)
  window.addEventListener('pagehide', () => { save(); if (!audio.paused) report('left') })
  // Going off screen mid-fade: finish it now, not on timers the browser may slow down or stop.
  document.addEventListener('visibilitychange', () => { if (document.hidden) [...ramps.values()].forEach(r => r.finish()) })

  if ('mediaSession' in navigator) {
    const on = (action: MediaSessionAction, fn: MediaSessionActionHandler) => { try { navigator.mediaSession.setActionHandler(action, fn) } catch { /* not supported */ } }
    // The lock screen's buttons say what they mean; a toggle could undo a pause that already happened on the TV.
    on('play', () => playFromSystem(true))
    on('pause', () => playFromSystem(false))
    on('nexttrack', () => next())
    on('previoustrack', () => prev())
    on('seekto', d => { if (typeof d.seekTime === 'number') seek(d.seekTime) })
    on('seekbackward', d => seek(audio.currentTime - (d.seekOffset ?? 10)))
    on('seekforward', d => seek(audio.currentTime + (d.seekOffset ?? 10)))
    on('stop', () => closeMusic())
  }
  mediaSession(current())

  if (desktop) {
    listeners.add(syncDesktop)
    desktop.onMusicAction((action, id) => {
      const t = state.queue.find(x => x.id === id)
      if (t) void rate(t, action === 'like' ? 1 : 0)
    })
    syncDesktop()
  }
}

/** Tells the desktop app what's playing, for its "Now playing" notification with Like (only when that changes). */
function syncDesktop () {
  const t = current()
  const info: DesktopNowPlaying | null = t
    ? {
        id: t.id,
        title: t.title,
        artist: t.credit ?? t.artist.name,
        album: t.album?.title,
        cover: artSize(t.album?.cover ?? t.artist.picture, 250),
        liked: state.ratings[t.id] === 1,
        playing: state.playing,
      }
    : null
  const key = JSON.stringify(info)
  if (key === toDesktop) return
  toDesktop = key
  desktop?.nowPlaying(info)
}

// ---- Casting: the TV plays, this page follows ----

function followCast (c: MusicCastStatus) {
  if (!c.active) {
    const was = state.cast
    window.clearInterval(castPoll)
    castPoll = undefined
    const at = c.index ?? state.index
    set({ cast: null, ...(c.queue?.length ? { queue: c.queue, index: Math.min(at, c.queue.length - 1) } : {}), time: c.position ?? state.time, playing: false })
    if (was?.active && c.error) toast(c.error)
    resumeAt = c.position ?? 0
    audio.removeAttribute('src')
    return
  }
  castAt = Date.now()
  const patch: Partial<PlayerState> = { cast: c, time: c.position ?? 0, duration: c.duration || state.duration, playing: c.state === 'playing', buffering: c.state === 'loading' || c.state === 'buffering' }
  if (c.queue?.length) {
    // The TV's queue is the queue now; keep songs added here that the TV hasn't heard about yet.
    const tvIds = c.queue.map(t => t.id).join()
    if (tvIds !== state.queue.map(t => t.id).slice(0, c.queue.length).join()) patch.queue = c.queue
    patch.index = c.index ?? 0
    if (patch.index !== state.index) mediaSession(c.queue[patch.index])
  }
  set(patch)
  if (patch.index !== undefined && state.queue.length - patch.index <= 3) void keepGoing()
  if (castPoll === undefined) castPoll = window.setInterval(() => { musicApi.cast().then(followCast).catch(() => {}) }, 2000)
}

function castControl (b: { action: string; t?: number; index?: number; mode?: MusicCastMode; level?: number; muted?: boolean; why?: string }) {
  musicApi.castControl(b).then(followCast).catch(err => toast((err as Error).message))
}

export async function castTo (deviceId: string, mode: MusicCastMode) {
  const t = current()
  if (!t) return
  const at = audio.src ? audio.currentTime : resumeAt
  report('skipped')
  silenceSpare()
  audio.pause()
  audio.volume = 1
  set({ buffering: true })
  try {
    followCast(await musicApi.castStart({ deviceId, queue: state.queue.map(x => x.id), index: state.index, t: at, mode }))
  } catch (err) {
    set({ buffering: false })
    toast((err as Error).message)
  }
}

export const castMode = (mode: MusicCastMode) => castControl({ action: 'mode', mode })
export const castVolume = (level: number) => castControl({ action: 'volume', level })

export async function stopCasting () {
  try { followCast({ ...(await musicApi.castStop()), active: false }) } catch (err) { toast((err as Error).message) }
}

/** On load: if a TV is already playing music, be its remote. */
export function joinCast () {
  musicApi.cast().then(c => { if (c.active) followCast(c) }).catch(() => {})
}
