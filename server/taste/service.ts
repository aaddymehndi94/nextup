import type { HomeResponse, MediaType, OnboardingResponse, Profile, RecItem, TasteSummary } from '../../shared/types.ts'
import type { CfModel } from '../reco/cf.ts'
import { ContentIndex } from '../reco/content.ts'
import { buildHome, myList, onboardingItems, similarItems } from '../reco/home.ts'
import type { RankInput } from '../reco/rank.ts'
import { COLD_START_POSITIVES, computeSignals, exclusions, type Signal, strength } from '../reco/signals.ts'
import { summarizeTaste } from '../reco/taste.ts'
import type { CfData, ItemRef } from '../reco/types.ts'
import type { TasteStore } from '../store.ts'
import type { ItemCache } from './items.ts'

// The adapter around the pure recommender: reads the store, the item cache and the CF model, hands plain
// data to server/reco/, and does the background work (metadata for signal titles, candidate expansion
// through people searches, CF candidates) that makes the next request better.

/** Rows rotate (because-seeds, exploration, tie-breaks) every this many ms. */
const ROTATION_MS = 6 * 3600_000
const HOME_TTL_MS = 5 * 60_000

type Log = (msg: string) => void

export class RecoService {
  private readonly store: TasteStore
  private readonly items: ItemCache
  private cf: CfModel | null
  private readonly log: Log
  private readonly now: () => number
  private index: ContentIndex | null = null
  private indexVersion = -1
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null
  private lastRebuild = 0
  private cfKnown: Set<string> = new Set()
  private readonly profileVersion = new Map<string, number>()
  private readonly homeCache = new Map<string, { key: string; at: number; value: HomeResponse }>()
  private readonly warming = new Map<string, Promise<void>>()
  private readonly warmAgain = new Set<string>()
  private readonly warmTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor (deps: { store: TasteStore; items: ItemCache; cf: CfModel | null; log?: Log; now?: () => number }) {
    this.store = deps.store
    this.items = deps.items
    this.cf = deps.cf
    this.log = deps.log ?? (() => {})
    this.now = deps.now ?? Date.now
    this.store.onChange(pid => {
      this.profileVersion.set(pid, (this.profileVersion.get(pid) ?? 0) + 1)
      this.scheduleWarm(pid)
    })
    this.items.onChange(() => this.scheduleRebuild())
  }

  setCf (cf: CfModel | null): void {
    this.cf = cf
    this.cfKnown = new Set()
    this.homeCache.clear()
    // Called from a timer, not a request: rebuild now so no request pays for it.
    if (this.index) this.rebuild()
  }

  /**
   * Builds the content index and runs the ranker once, off the request path, so the first home after a
   * restart doesn't pay for the build and a cold JIT. Nothing is cached or recorded as shown.
   */
  prewarm (): void {
    try {
      this.getIndex()
      const profile = this.store.listProfiles()[0]
      if (profile) buildHome(this.input(profile.id))
    } catch (err) {
      this.log(`prewarm: ${(err as Error).message}`)
    }
  }

  get cfAvailable (): boolean { return this.cf !== null }

  // ---- Index -------------------------------------------------------------------------

  /** Items arrive in bursts while warming; rebuild once they settle, and at most every 5 s. */
  private scheduleRebuild (): void {
    if (this.rebuildTimer) return
    const wait = Math.max(2000, this.lastRebuild + 5000 - Date.now())
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      this.rebuild()
    }, wait)
    this.rebuildTimer.unref?.()
  }

  private rebuild (): ContentIndex {
    const began = performance.now()
    this.lastRebuild = Date.now()
    this.indexVersion = this.items.version
    this.index = new ContentIndex(this.items.all())
    if (this.cf) {
      const cf = this.cf
      this.cfKnown = new Set(this.index.items.filter(it => it.type === 'movie' && safe(() => cf.has(it.id), false)).map(it => it.id))
    }
    this.log(`content index: ${this.index.size} titles, ${this.index.featureCount} features, ${Math.round(performance.now() - began)} ms`)
    return this.index
  }

  /** The content index. Requests use the last one built; a newer one is built off the request path. */
  getIndex (): ContentIndex {
    if (!this.index || this.indexVersion === -1) return this.rebuild()
    if (this.indexVersion !== this.items.version) this.scheduleRebuild()
    return this.index
  }

  // ---- Inputs ------------------------------------------------------------------------

  private cfData (signals: Signal[]): CfData | null {
    const cf = this.cf
    if (!cf) return null
    // As evaluated offline (ADR 0002): explicit likes at 1, dislikes at -0.5. Merely watched or finished films
    // cost recall when counted as likes, so they only stand in while there are fewer than 3 explicit likes.
    const known = signals.filter(s => s.type === 'movie' && Math.abs(s.weight) >= 0.1 && safe(() => cf.has(s.id), false))
    const liked = known.filter(s => s.explicit && s.weight > 0)
    const seeds = (liked.length >= 3 ? known.filter(s => s.explicit) : known)
      .map(s => ({ id: s.id, weight: s.weight > 0 ? (s.explicit ? 1 : Math.min(1, s.weight)) : -0.5 }))
    if (!seeds.some(s => s.weight > 0)) return null
    const scores = safe(() => cf.score(seeds, 400), [])
    const neighbors = new Map(seeds.filter(s => s.weight >= 0.3).slice(0, 10).map(s => [s.id, safe(() => cf.neighbors(s.id, 60), [])]))
    return { scores, known: this.cfKnown, neighbors }
  }

  private input (profileId: string): RankInput & { signals: Signal[]; snapshot: ReturnType<TasteStore['snapshot']> } {
    const now = this.now()
    const snapshot = this.store.snapshot(profileId)
    const signals = computeSignals(snapshot, now)
    return {
      index: this.getIndex(),
      signals,
      snapshot,
      exclude: exclusions(snapshot),
      prefs: snapshot.prefs,
      cf: this.cfData(signals),
      impressions: this.store.impressions(profileId),
      confidence: strength(signals).confidence,
      now,
      seed: Math.floor(now / ROTATION_MS),
    }
  }

  // ---- Public ------------------------------------------------------------------------

  /** The home screen, or with `type` the Films or Series tab. */
  home (profile: Profile, type?: MediaType): HomeResponse {
    const now = this.now()
    const index = this.getIndex()
    const key = `${this.indexVersion}:${this.profileVersion.get(profile.id) ?? 0}:${Math.floor(now / ROTATION_MS)}`
    const cacheKey = type ? `${profile.id}:${type}` : profile.id
    const hit = this.homeCache.get(cacheKey)
    if (hit && hit.key === key && now - hit.at < HOME_TTL_MS) return { ...hit.value, warming: this.isWarming(profile.id) }
    if (!this.warming.has(profile.id) && !hit) this.scheduleWarm(profile.id, 0)
    const out = buildHome(this.input(profile.id), type)
    this.store.recordImpressions(profile.id, out.shown)
    const value: HomeResponse = { profile, coldStart: out.coldStart, warming: this.isWarming(profile.id) || index.size < 500, rows: out.rows }
    this.homeCache.set(cacheKey, { key, at: now, value })
    return value
  }

  async similar (profile: Profile, ref: ItemRef, k = 20): Promise<RecItem[]> {
    await withTimeout(this.items.ensure([ref]), 4000)
    const it = this.items.lookup(ref.id)
    if (it) await withTimeout(this.expand([it.id]), 2500)
    // A title opened for the first time may not be in the index yet.
    if (it && this.getIndex().indexOf(ref.id) === undefined) this.rebuild()
    const input = this.input(profile.id)
    const cf = this.cf
    const neighbors = cf && ref.type === 'movie' ? safe(() => cf.neighbors(ref.id, 80), []) : null
    if (neighbors?.length) void this.items.ensure(neighbors.slice(0, 40).map(n => ({ id: n.id, type: 'movie' as const })))
    return similarItems(input, ref.id, neighbors, k)
  }

  onboarding (profile: Profile): OnboardingResponse {
    const input = this.input(profile.id)
    return {
      items: onboardingItems(input.index, input.snapshot, input.now, input.seed, 24),
      rated: input.snapshot.ratings.length,
      positives: strength(input.signals).positives,
      target: COLD_START_POSITIVES,
    }
  }

  taste (profile: Profile): TasteSummary {
    const input = this.input(profile.id)
    const core = summarizeTaste(input.index, input.signals, input.prefs)
    const cf = this.cf
    const covered = cf ? input.signals.filter(s => s.type === 'movie' && safe(() => cf.has(s.id), false)).length : 0
    return { profile, ...core, cf: { available: cf !== null, covered } }
  }

  /** Titles in My List with metadata (the cached part; the rest fills in on the next call). */
  myList (profile: Profile): RecItem[] {
    return myList(this.getIndex(), this.store.snapshot(profile.id))
  }

  isWarming (profileId: string): boolean {
    return this.warming.has(profileId) || this.warmTimers.has(profileId) || this.items.isCrawling || this.rebuildTimer !== null
  }

  /** Background work after a profile changes; debounced so a burst of ratings warms once. */
  scheduleWarm (profileId: string, delayMs = 1200): void {
    if (this.warming.has(profileId)) { this.warmAgain.add(profileId); return }
    const prev = this.warmTimers.get(profileId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.warmTimers.delete(profileId)
      const job = this.warm(profileId)
        .catch(err => this.log(`warm ${profileId}: ${(err as Error).message}`))
        .finally(() => {
          this.warming.delete(profileId)
          this.profileVersion.set(profileId, (this.profileVersion.get(profileId) ?? 0) + 1)
          if (this.warmAgain.delete(profileId)) this.scheduleWarm(profileId)
        })
      this.warming.set(profileId, job)
    }, delayMs)
    t.unref?.()
    this.warmTimers.set(profileId, t)
  }

  /** Metadata for everything the profile touched, people-search expansion around its likes, and CF candidates. */
  async warm (profileId: string): Promise<void> {
    const snap = this.store.snapshot(profileId)
    const refs: ItemRef[] = [...snap.ratings, ...snap.list, ...snap.progress, ...snap.dismissals].map(r => ({ id: r.id, type: r.type }))
    await this.items.ensure(refs)
    const watchingSeries = [...new Map(snap.progress.filter(p => p.type === 'series').map(p => [p.id, { id: p.id, type: p.type }])).values()]
    await this.items.ensure(watchingSeries, { detailed: true })
    const signals = computeSignals(snap, this.now())
    const liked = signals.filter(s => s.weight >= 0.3).slice(0, 12).map(s => s.id)
    await this.expand(liked)
    const cf = this.cfData(signals)
    if (cf) {
      const ids = [...cf.scores.slice(0, 150).map(s => s.id), ...[...cf.neighbors.values()].flatMap(n => n.slice(0, 30).map(x => x.id))]
      await this.items.ensure(ids.map(id => ({ id, type: 'movie' as const })))
    }
  }

  /** Content neighbours beyond the catalogs: other work by the directors, writers and leads of these titles. */
  private async expand (ids: string[]): Promise<void> {
    const queries = new Map<string, ItemRef['type']>()
    for (const id of ids) {
      const it = this.items.lookup(id)
      if (!it) continue
      for (const d of it.directors.slice(0, 2)) queries.set(d, 'movie')
      if (it.type === 'series') for (const w of it.writers.slice(0, 1)) queries.set(w, 'series')
      for (const a of it.cast.slice(0, 1)) if (!queries.has(a)) queries.set(a, it.type)
    }
    await Promise.all([...queries].map(async ([q, type]) => {
      const refs = await this.items.search(type, q).catch(() => [])
      await this.items.ensure(refs.slice(0, 12))
    }))
  }
}

function safe<T> (fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

async function withTimeout (p: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p.catch(() => {}), new Promise<void>(resolve => { t = setTimeout(resolve, ms) })])
  clearTimeout(t)
}
