import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { MediaType } from '../../shared/types.ts'
import { decodeEntities } from '../catalog/cinemeta.ts'
import { transaction } from '../db.ts'
import { fetchJson } from '../http.ts'
import type { ItemMeta, ItemRef } from '../reco/types.ts'

// Title metadata for the recommender, cached in SQLite (`items`, `catalog_pages`) and filled from
// Cinemeta catalogs, searches and /meta lookups. All upstream calls go through one rate limiter.

const HOUR = 3600_000
const DAY = 24 * HOUR

export const TTL = {
  /** Catalog and genre pages: popularity moves daily. */
  catalog: DAY,
  /** Person searches used for candidate expansion. */
  search: 7 * DAY,
  /** A title fetched on its own. */
  meta: 14 * DAY,
  /** Series episode lists (for "next episode"). */
  detailed: 2 * DAY,
  /** Don't retry a failed lookup for this long. */
  failure: 6 * HOUR,
}

export const MOVIE_GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western']
export const SERIES_GENRES = MOVIE_GENRES

interface CinemetaMeta {
  id?: string
  imdb_id?: string
  type?: string
  name?: string
  releaseInfo?: string
  year?: string | number
  released?: string
  poster?: string
  background?: string
  logo?: string
  description?: string
  runtime?: string
  genres?: string[]
  genre?: string[]
  imdbRating?: string | number
  popularities?: Record<string, number>
  moviedb_id?: number
  cast?: string[]
  director?: string[] | string | null
  writer?: string[] | string | null
  country?: string
  videos?: Array<{ season?: number; episode?: number; number?: number }>
}

const list = (v: string[] | string | null | undefined): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/,\s*/) : []).map(x => decodeEntities(String(x)).trim()).filter(Boolean)

/** Cinemeta meta (catalog entry or full /meta) → ItemMeta. Null for anything without an IMDb id or name. */
export function parseMeta (m: CinemetaMeta, now: number): ItemMeta | null {
  const id = m.imdb_id ?? m.id
  if (!id || !/^tt\d+$/.test(id) || !m.name || (m.type !== 'movie' && m.type !== 'series')) return null
  const ri = String(m.releaseInfo ?? m.year ?? '')
  const ym = /(\d{4})(?:\s*[–-]\s*(\d{4})?)?/.exec(ri)
  const year = ym ? Number(ym[1]) : undefined
  const ongoing = ym ? /[–-]\s*$/.test(ri.trim()) : false
  const yearEnd = m.type === 'series' && ym ? (ym[2] ? Number(ym[2]) : ongoing ? undefined : year) : undefined
  const rating = Number.parseFloat(String(m.imdbRating ?? ''))
  const runtime = Number.parseInt(m.runtime ?? '', 10)
  const popularity = m.popularities?.moviedb
  const episodes = m.videos?.length
    ? m.videos.filter(v => (v.season ?? 0) > 0).map(v => [v.season!, v.episode ?? v.number ?? 0] as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    : undefined
  return {
    id,
    type: m.type,
    name: decodeEntities(m.name),
    year,
    yearEnd,
    released: m.released || undefined,
    poster: m.poster?.replace('/poster/small/', '/poster/medium/'),
    background: m.background?.replace('/background/medium/', '/background/large/'),
    logo: m.logo,
    description: decodeEntities(m.description),
    genres: list(m.genres ?? m.genre),
    cast: list(m.cast),
    directors: list(m.director),
    writers: list(m.writer),
    countries: list(m.country),
    runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : undefined,
    imdbRating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    popularity: typeof popularity === 'number' && popularity > 0 ? popularity : undefined,
    moviedbId: typeof m.moviedb_id === 'number' ? m.moviedb_id : undefined,
    episodes,
    fetchedAt: now,
  }
}

/** At most `concurrency` requests in flight and one start per `intervalMs`. */
export class Limiter {
  private readonly concurrency: number
  private readonly intervalMs: number
  private active = 0
  private last = 0
  private readonly queue: Array<() => void> = []

  constructor (concurrency: number, intervalMs: number) {
    this.concurrency = concurrency
    this.intervalMs = intervalMs
  }

  get pending (): number { return this.queue.length + this.active }

  run<T> (fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active++
        fn().then(resolve, reject).finally(() => { this.active--; this.pump() })
      })
      this.pump()
    })
  }

  private pump (): void {
    if (!this.queue.length || this.active >= this.concurrency) return
    const wait = this.last + this.intervalMs - Date.now()
    if (wait > 0) { setTimeout(() => this.pump(), wait); return }
    this.last = Date.now()
    this.queue.shift()!()
    this.pump()
  }
}

type Row = Record<string, string | number | null>
const arr = (v: unknown): string[] => (typeof v === 'string' ? JSON.parse(v) as string[] : [])
const opt = <T>(v: unknown, f: (x: unknown) => T): T | undefined => (v === null || v === undefined ? undefined : f(v))

export interface ItemCacheOptions {
  baseUrl: string
  now?: () => number
  /** Injected in tests. */
  fetch?: (url: string) => Promise<unknown>
  concurrency?: number
  intervalMs?: number
}

export interface SearchHit extends ItemRef { name?: string; year?: number }

export class ItemCache {
  private readonly db: DatabaseSync
  private readonly baseUrl: string
  private readonly now: () => number
  private readonly get: (url: string) => Promise<unknown>
  private readonly limiter: Limiter
  private readonly items = new Map<string, ItemMeta>()
  private readonly detailedAt = new Map<string, number>()
  private readonly failed = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly listeners: Array<() => void> = []
  private readonly stmts = new Map<string, StatementSync>()
  private crawling: Promise<void> | null = null
  /** Names and years from search results (which aren't stored as titles), by id. */
  private readonly searchNames = new Map<string, { name: string; year?: number }>()
  /** Bumped whenever titles are added or changed. */
  version = 0

  constructor (db: DatabaseSync, opts: ItemCacheOptions) {
    this.db = db
    this.baseUrl = opts.baseUrl
    this.now = opts.now ?? Date.now
    this.get = opts.fetch ?? (url => fetchJson(url, { timeoutMs: 15_000 }))
    this.limiter = new Limiter(opts.concurrency ?? 4, opts.intervalMs ?? 150)
    for (const r of db.prepare('SELECT * FROM items').all() as Row[]) {
      const it = this.fromRow(r)
      this.items.set(it.id, it)
      if (Number(r.detailed) === 1) this.detailedAt.set(it.id, it.fetchedAt)
    }
  }

  private q (sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s) }
    return s
  }

  private fromRow (r: Row): ItemMeta {
    return {
      id: String(r.id),
      type: r.type as MediaType,
      name: String(r.name),
      year: opt(r.year, Number),
      yearEnd: opt(r.year_end, Number),
      released: opt(r.released, String),
      poster: opt(r.poster, String),
      background: opt(r.background, String),
      logo: opt(r.logo, String),
      description: opt(r.description, String),
      genres: arr(r.genres),
      cast: arr(r.actors),
      directors: arr(r.directors),
      writers: arr(r.writers),
      countries: arr(r.countries),
      runtime: opt(r.runtime, Number),
      imdbRating: opt(r.imdb_rating, Number),
      popularity: opt(r.popularity, Number),
      moviedbId: opt(r.moviedb_id, Number),
      episodes: opt(r.episodes, v => JSON.parse(String(v)) as Array<[number, number]>),
      fetchedAt: Number(r.fetched_at),
    }
  }

  onChange (fn: () => void): void { this.listeners.push(fn) }

  /** Upstream requests queued or running. */
  get busy (): number { return this.limiter.pending }

  get size (): number { return this.items.size }
  all (): ItemMeta[] { return [...this.items.values()] }
  lookup (id: string): ItemMeta | undefined { return this.items.get(id) }

  /** Stores parsed titles; keeps a previously fetched episode list when a catalog entry (without one) arrives. */
  private save (metas: ItemMeta[], detailed: boolean): void {
    if (!metas.length) return
    const stmt = this.q(`INSERT INTO items (id, type, name, year, year_end, released, poster, background, logo, description, genres, actors,
                           directors, writers, countries, runtime, imdb_rating, popularity, moviedb_id, episodes, detailed, fetched_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (id) DO UPDATE SET type = excluded.type, name = excluded.name, year = excluded.year,
                           year_end = excluded.year_end, released = excluded.released, poster = excluded.poster,
                           background = excluded.background, logo = excluded.logo, description = excluded.description,
                           genres = excluded.genres, actors = excluded.actors, directors = excluded.directors, writers = excluded.writers,
                           countries = excluded.countries, runtime = excluded.runtime, imdb_rating = excluded.imdb_rating,
                           popularity = excluded.popularity, moviedb_id = COALESCE(excluded.moviedb_id, items.moviedb_id), episodes = COALESCE(excluded.episodes, items.episodes),
                           detailed = MAX(items.detailed, excluded.detailed), fetched_at = excluded.fetched_at`)
    transaction(this.db, () => {
      for (const m of metas) {
        const prev = this.items.get(m.id)
        const merged = { ...m, episodes: m.episodes ?? prev?.episodes }
        stmt.run(m.id, m.type, m.name, m.year ?? null, m.yearEnd ?? null, m.released ?? null, m.poster ?? null, m.background ?? null,
          m.logo ?? null, m.description ?? null, JSON.stringify(m.genres), JSON.stringify(m.cast), JSON.stringify(m.directors),
          JSON.stringify(m.writers), JSON.stringify(m.countries), m.runtime ?? null, m.imdbRating ?? null, m.popularity ?? null, m.moviedbId ?? null,
          merged.episodes ? JSON.stringify(merged.episodes) : null, detailed ? 1 : 0, m.fetchedAt)
        this.items.set(m.id, merged)
        if (detailed) this.detailedAt.set(m.id, m.fetchedAt)
      }
    })
    this.version++
    for (const fn of this.listeners) fn()
  }

  /** Adds titles that arrived from elsewhere (e.g. a title page's metadata). */
  put (metas: ItemMeta[]): void { this.save(metas, false) }

  private needs (ref: ItemRef, detailed: boolean): boolean {
    const now = this.now()
    const f = this.failed.get(ref.id)
    if (f && now - f < TTL.failure) return false
    if (detailed) return now - (this.detailedAt.get(ref.id) ?? 0) > TTL.detailed
    const it = this.items.get(ref.id)
    return !it || now - it.fetchedAt > TTL.meta
  }

  /** Fetches titles that are missing or stale. `detailed` also wants the series episode list. */
  async ensure (refs: ItemRef[], opts: { detailed?: boolean } = {}): Promise<void> {
    const detailed = opts.detailed ?? false
    const jobs: Array<Promise<void>> = []
    const seen = new Set<string>()
    for (const ref of refs) {
      if (seen.has(ref.id) || !this.needs(ref, detailed)) continue
      seen.add(ref.id)
      const key = `${ref.id}:${detailed}`
      let job = this.inflight.get(key)
      if (!job) {
        job = this.limiter.run(() => this.get(`${this.baseUrl}/meta/${ref.type}/${ref.id}.json`))
          .then(body => {
            const meta = parseMeta((body as { meta?: CinemetaMeta })?.meta ?? {}, this.now())
            if (meta) this.save([meta], true)
            else this.failed.set(ref.id, this.now())
          })
          .catch(() => { this.failed.set(ref.id, this.now()) })
          .finally(() => this.inflight.delete(key))
        this.inflight.set(key, job)
      }
      jobs.push(job)
    }
    await Promise.all(jobs)
  }

  private cachedPage (key: string, ttl: number): string[] | null {
    const r = this.q('SELECT ids, fetched_at FROM catalog_pages WHERE key = ?').get(key) as Row | undefined
    if (!r || this.now() - Number(r.fetched_at) > ttl) return null
    return JSON.parse(String(r.ids)) as string[]
  }

  private savePage (key: string, ids: string[]): void {
    this.q('INSERT INTO catalog_pages (key, ids, fetched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET ids = excluded.ids, fetched_at = excluded.fetched_at')
      .run(key, JSON.stringify(ids), this.now())
  }

  /** One page of a Cinemeta catalog (50 titles, full metadata). Cached for TTL.catalog. */
  async catalogPage (type: MediaType, catalog: string, opts: { genre?: string; skip?: number } = {}): Promise<string[]> {
    const extra = [opts.genre ? `genre=${encodeURIComponent(opts.genre)}` : '', opts.skip ? `skip=${opts.skip}` : ''].filter(Boolean).join('&')
    const key = `catalog:${type}:${catalog}:${extra}`
    const cached = this.cachedPage(key, TTL.catalog)
    if (cached) return cached
    const body = await this.limiter.run(() => this.get(`${this.baseUrl}/catalog/${type}/${catalog}${extra ? `/${extra}` : ''}.json`)) as { metas?: CinemetaMeta[] }
    const metas = (body?.metas ?? []).map(m => parseMeta({ ...m, type: m.type ?? type }, this.now())).filter((m): m is ItemMeta => m !== null)
    this.save(metas, false)
    const ids = metas.map(m => m.id)
    this.savePage(key, ids)
    return ids
  }

  /** Titles matching a search (Cinemeta matches names of people too), with name and year when known. Call ensure() for metadata. */
  async search (type: MediaType, query: string): Promise<SearchHit[]> {
    const key = `search:${type}:${query.toLowerCase()}`
    const cached = this.cachedPage(key, TTL.search)
    if (cached) return cached.map(id => this.hit(id, type))
    const body = await this.limiter.run(() => this.get(`${this.baseUrl}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`)) as { metas?: CinemetaMeta[] }
    // Search results are thin (no genres or people), so they aren't stored as titles; their names and years are
    // kept in memory so a caller can tell which result it wants before fetching it (AI suggestions, server/ai).
    if (this.searchNames.size > 5000) this.searchNames.clear()
    for (const m of body?.metas ?? []) {
      const id = m.imdb_id ?? m.id ?? ''
      const year = Number(/\d{4}/.exec(String(m.releaseInfo ?? m.year ?? ''))?.[0]) || undefined
      if (/^tt\d+$/.test(id) && m.name) this.searchNames.set(id, { name: decodeEntities(m.name), year })
    }
    const ids = (body?.metas ?? []).map(m => m.imdb_id ?? m.id ?? '').filter(id => /^tt\d+$/.test(id))
    this.savePage(key, ids)
    return ids.map(id => this.hit(id, type))
  }

  private hit (id: string, type: MediaType): SearchHit {
    const it = this.items.get(id)
    const named = it ? { name: it.name, year: it.year } : this.searchNames.get(id)
    return named ? { id, type, ...named } : { id, type }
  }

  /** Pages to crawl for the candidate pool, shallow pages of every catalog first. */
  static crawlPlan (): Array<{ type: MediaType; catalog: string; genre?: string; skip?: number }> {
    const plan: Array<{ type: MediaType; catalog: string; genre?: string; skip?: number; depth: number }> = []
    const pages = (type: MediaType, catalog: string, genre: string | undefined, n: number) => {
      for (let d = 0; d < n; d++) plan.push({ type, catalog, genre, skip: d * 50, depth: d })
    }
    pages('movie', 'top', undefined, 10)
    pages('series', 'top', undefined, 6)
    for (const g of MOVIE_GENRES) pages('movie', 'top', g, ['Drama', 'Comedy', 'Romance', 'Thriller', 'Action', 'Crime'].includes(g) ? 6 : 4)
    for (const g of SERIES_GENRES) pages('series', 'top', g, 2)
    pages('movie', 'imdbRating', undefined, 2)
    pages('series', 'imdbRating', undefined, 2)
    return plan.sort((a, b) => a.depth - b.depth).map(({ depth: _d, ...p }) => p)
  }

  /** Fills the candidate pool from Cinemeta catalogs. Pages within TTL are skipped, so restarts are cheap. */
  crawl (log: (msg: string) => void = () => {}): Promise<void> {
    if (this.crawling) return this.crawling
    this.crawling = (async () => {
      const began = this.now()
      const before = this.items.size
      let failed = 0
      await Promise.all(ItemCache.crawlPlan().map(p => this.catalogPage(p.type, p.catalog, p).catch(() => { failed++ })))
      log(`catalog crawl: ${this.items.size} titles (+${this.items.size - before}), ${failed} pages failed, ${Math.round((this.now() - began) / 1000)} s`)
    })().finally(() => { this.crawling = null })
    return this.crawling
  }

  get isCrawling (): boolean { return this.crawling !== null }
}
