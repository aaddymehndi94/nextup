import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AiConnection, AiModel, AiPicks, AiPicksResponse, AiProvider, AiSearchResponse, AiStatus, MediaType, Profile, RecItem, RecReason,
} from '../../shared/types.ts'
import { HttpError } from '../http.ts'
import { rawFeatures } from '../reco/content.ts'
import { isRecommendable, toRecItem } from '../reco/rank.ts'
import { exclusions } from '../reco/signals.ts'
import type { ItemMeta } from '../reco/types.ts'
import type { TasteStore } from '../store.ts'
import type { ItemCache } from '../taste/items.ts'
import type { RecoService } from '../taste/service.ts'
import { type ChatgptAuth, type ChatgptSession, newHostId } from './chatgpt.ts'
import { automatic, costOf } from './models.ts'
import { type HistoryEntry, parseSuggestions, PICKS_SYSTEM, picksPrompt, SEARCH_SYSTEM, searchPrompt, SUGGESTIONS_SCHEMA, type TasteText, titleLine } from './prompts.ts'
import { AiError, type Ask, type Credential, type ProviderApi } from './providers.ts'
import { normTitle, resolveAll } from './resolve.ts'

// AI picks and AI search, on request only. Nothing here runs on a timer or as a side effect of browsing:
// a model is asked only when the viewer presses "Get AI picks", "Refresh" or "Ask AI", and every answer is
// saved (ai_results), so showing it again costs nothing. Credentials stay in ai.json on this computer
// (owner-only file mode), are never sent to the browser and are never synced. See docs/adr/0009.

const MODELS_TTL_MS = 12 * 3600_000
/** An empty list (a provider hiccup, or a list it sent in a shape not yet understood) is asked for again sooner. */
const EMPTY_MODELS_TTL_MS = 60_000
const SEARCH_TTL_MS = 14 * 24 * 3600_000
const DEFAULT_DAILY_LIMIT = 50
/** Typical tokens per request, for estimates until this computer has its own averages. */
const TYPICAL: Record<'picks' | 'search', { input: number; output: number }> = { picks: { input: 2500, output: 5000 }, search: { input: 1200, output: 2500 } }
/** When both are connected, Automatic prefers a ChatGPT plan (already paid for) over per-request billing. */
const PREFERENCE: AiProvider[] = ['chatgpt', 'anthropic', 'openai']
const LABELS: Record<AiProvider, string> = { chatgpt: 'ChatGPT', anthropic: 'Claude', openai: 'OpenAI' }

interface KeyEntry { key: string; at: number; problem?: string }
interface AiFile {
  hostId: string
  choice: string | null
  dailyLimit: number
  anthropic?: KeyEntry
  openai?: KeyEntry
  chatgpt?: ChatgptSession & { problem?: string }
  /** The last ChatGPT registration, so signing in again reuses it. */
  chatgptLast?: { clientId: string; email: string }
  models?: Partial<Record<AiProvider, { at: number; list: AiModel[] }>>
}

/** What is saved per suggestion: ids and words only; posters and ratings come from the item cache when shown. */
interface Saved { id: string; type: MediaType; why: string; seed?: RecReason['seed'] }

export interface AiDeps {
  db: DatabaseSync
  dataDir: string
  items: ItemCache
  reco: RecoService
  store: TasteStore
  providers: ProviderApi
  chatgpt: ChatgptAuth
  log?: (msg: string) => void
  now?: () => number
}

export class AiService {
  private readonly d: AiDeps
  private readonly file: string
  private readonly now: () => number
  private state: AiFile
  private readonly inflight = new Map<string, Promise<unknown>>()
  private refreshing: Promise<ChatgptSession> | null = null
  private loadingModels = new Set<AiProvider>()
  /** A ChatGPT sign-in is being finished (tokens, then models): still "signing in" to the settings page. */
  private connecting = false

  constructor (deps: AiDeps) {
    this.d = deps
    this.now = deps.now ?? Date.now
    this.file = join(deps.dataDir, 'ai.json')
    this.state = this.read()
  }

  // ---- Credentials file ----

  private read (): AiFile {
    const fresh: AiFile = { hostId: newHostId(), choice: null, dailyLimit: DEFAULT_DAILY_LIMIT }
    if (!existsSync(this.file)) return fresh
    try { return { ...fresh, ...JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AiFile> } } catch { return fresh }
  }

  /** Atomic, owner-only (0600): the file holds API keys and tokens. */
  private write (): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, this.file)
  }

  // ---- Status and settings ----

  private connected (): AiProvider[] {
    return PREFERENCE.filter(p => Boolean(this.state[p]))
  }

  private connection (p: AiProvider): AiConnection | null {
    if (p === 'chatgpt') {
      const s = this.state.chatgpt
      return s ? { provider: p, label: s.email || 'ChatGPT account', connectedAt: s.connectedAt, problem: s.problem } : null
    }
    const k = this.state[p]
    return k ? { provider: p, label: `Key ending ${k.key.slice(-4)}`, connectedAt: k.at, problem: k.problem } : null
  }

  /** Models of every connected provider (from the last listing; a stale list refreshes in the background). */
  models (): AiModel[] {
    const out: AiModel[] = []
    for (const p of this.connected()) {
      const m = this.state.models?.[p]
      if (!m || this.now() - m.at > (m.list.length ? MODELS_TTL_MS : EMPTY_MODELS_TTL_MS)) void this.loadModels(p).catch(() => {})
      out.push(...(m?.list ?? []))
    }
    return out
  }

  private async loadModels (p: AiProvider): Promise<AiModel[]> {
    if (this.loadingModels.has(p)) return this.state.models?.[p]?.list ?? []
    this.loadingModels.add(p)
    try {
      const list = await this.d.providers.models(await this.credential(p))
      this.state.models = { ...this.state.models, [p]: { at: this.now(), list } }
      this.write()
      return list
    } finally { this.loadingModels.delete(p) }
  }

  /** The model a request uses now: the person's choice if it's still offered, else Automatic. */
  active (): { model: AiModel; auto: boolean } | null {
    const models = this.models()
    const chosen = this.state.choice ? models.find(m => m.id === this.state.choice) : undefined
    if (chosen) return { model: chosen, auto: false }
    for (const p of this.connected()) {
      const m = automatic(models.filter(x => x.provider === p))
      if (m) return { model: m, auto: true }
    }
    return null
  }

  status (local: boolean): AiStatus {
    const active = this.active()
    const today = this.usageSince(startOfDay(this.now()))
    const month = this.usageSince(startOfMonth(this.now()))
    return {
      local,
      connections: this.connected().map(p => this.connection(p)!),
      models: this.models(),
      choice: this.state.choice,
      active,
      dailyLimit: this.state.dailyLimit,
      estimate: active ? { picks: this.estimate(active.model, 'picks'), search: this.estimate(active.model, 'search') } : null,
      usage: { today: today.requests, month },
      signingIn: this.d.chatgpt.signingIn || this.connecting,
    }
  }

  settings (s: { choice?: string | null; dailyLimit?: number }): void {
    if (s.choice !== undefined) this.state.choice = s.choice
    if (s.dailyLimit !== undefined) this.state.dailyLimit = s.dailyLimit
    this.write()
  }

  /** Checks the key by listing the provider's models (free), then saves it. */
  async connectKey (provider: 'anthropic' | 'openai', key: string): Promise<void> {
    let list: AiModel[]
    try {
      list = await this.d.providers.models({ provider, secret: key })
    } catch (err) {
      throw new HttpError(400, err instanceof AiError ? err.message : `Couldn’t check the key: ${(err as Error).message}`)
    }
    this.state[provider] = { key, at: this.now() }
    this.state.models = { ...this.state.models, [provider]: { at: this.now(), list } }
    this.write()
    this.d.log?.(`ai: ${LABELS[provider]} connected (${list.length} models)`)
  }

  chatgptSignIn (redirectUri: string): string {
    const last = this.state.chatgpt ?? this.state.chatgptLast
    return this.d.chatgpt.start(redirectUri, this.state.hostId, last ? { clientId: last.clientId, email: last.email, idToken: this.state.chatgpt?.idToken } : null)
  }

  async chatgptCallback (query: Record<string, string | undefined>): Promise<void> {
    // The page polls while signing in; it must not see a gap between the sign-in ending and the connection
    // (with its models) being saved, or it stops looking and shows the Sign in button again.
    this.connecting = true
    try {
      const s = await this.d.chatgpt.finish(query)
      this.state.chatgpt = s
      this.state.chatgptLast = { clientId: s.clientId, email: s.email }
      this.write()
      this.d.log?.('ai: ChatGPT connected')
      const list = await this.loadModels('chatgpt').catch(err => { this.d.log?.(`ai: ChatGPT models: ${(err as Error).message}`); return [] })
      if (!list.length) this.d.log?.('ai: ChatGPT sent no usable models')
    } finally { this.connecting = false }
  }

  async disconnect (p: AiProvider): Promise<{ revoked?: boolean }> {
    let revoked: boolean | undefined
    if (p === 'chatgpt' && this.state.chatgpt) revoked = await this.d.chatgpt.revoke(this.state.chatgpt)
    delete this.state[p]
    if (this.state.models) delete this.state.models[p]
    if (this.state.choice && !this.models().some(m => m.id === this.state.choice)) this.state.choice = null
    this.write()
    return { revoked }
  }

  // ---- Asking ----

  private async credential (p: AiProvider): Promise<Credential> {
    if (p !== 'chatgpt') {
      const k = this.state[p]
      if (!k) throw new HttpError(409, `${LABELS[p]} isn’t connected.`)
      return { provider: p, secret: k.key }
    }
    let s = this.state.chatgpt
    if (!s) throw new HttpError(409, 'ChatGPT isn’t connected.')
    if (this.d.chatgpt.needsRefresh(s)) {
      // One refresh at a time: the refresh token rotates, so a second concurrent one would use a spent token.
      this.refreshing ??= this.d.chatgpt.refresh(s).finally(() => { this.refreshing = null })
      s = await this.refreshing
      this.state.chatgpt = { ...s, problem: undefined }
      this.write()
    }
    return { provider: p, secret: s.accessToken }
  }

  private flag (p: AiProvider, problem: string | undefined): void {
    const entry = this.state[p]
    if (!entry || entry.problem === problem) return
    entry.problem = problem
    this.write()
  }

  /** One model request, within the daily limit, logged for the usage line. */
  private async ask (kind: 'picks' | 'search', q: Ask): Promise<{ text: string; model: AiModel }> {
    const active = this.active()
    if (!active) {
      if (this.connected().length) {
        // Connected but the model list hasn't loaded yet (first run after connecting failed to list them).
        for (const p of this.connected()) await this.loadModels(p).catch(() => {})
      }
    }
    const use = this.active()
    if (!use) throw new HttpError(409, 'Connect ChatGPT, Claude or OpenAI in AI settings first.')
    const limit = this.state.dailyLimit
    if (limit > 0 && this.usageSince(startOfDay(this.now())).requests >= limit) {
      throw new HttpError(429, `That’s today’s ${limit} AI requests, the limit set in AI settings. It resets at midnight.`)
    }
    const { model } = use
    try {
      const ans = await this.d.providers.ask(await this.credential(model.provider), model.id, q)
      this.d.db.prepare('INSERT INTO ai_usage (at, provider, model, kind, input_tokens, output_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(this.now(), model.provider, model.id, kind, ans.inputTokens, ans.outputTokens, model.provider === 'chatgpt' ? 0 : costOf(model.id, ans.inputTokens, ans.outputTokens))
      this.flag(model.provider, undefined)
      return { text: ans.text, model }
    } catch (err) {
      if (err instanceof AiError) {
        if (err.kind === 'auth' || err.kind === 'credit' || err.kind === 'limit') this.flag(model.provider, err.message)
        if (err.kind === 'model' && !use.auto) { this.state.choice = null; this.write() }
        throw new HttpError(err.kind === 'busy' || err.kind === 'limit' ? 503 : 502, err.message)
      }
      throw err
    }
  }

  private usageSince (t: number): { requests: number; inputTokens: number; outputTokens: number; costUsd: number | null } {
    const r = this.d.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, SUM(cost) AS c FROM ai_usage WHERE at >= ?').get(t) as { n: number; i: number; o: number; c: number | null }
    return { requests: Number(r.n), inputTokens: Number(r.i), outputTokens: Number(r.o), costUsd: r.c === null ? null : Math.round(Number(r.c) * 10000) / 10000 }
  }

  private estimate (m: AiModel, kind: 'picks' | 'search'): string {
    if (m.provider === 'chatgpt') return 'uses your ChatGPT plan'
    const avg = this.d.db.prepare('SELECT AVG(input_tokens) AS i, AVG(output_tokens) AS o, COUNT(*) AS n FROM (SELECT input_tokens, output_tokens FROM ai_usage WHERE model = ? AND kind = ? ORDER BY at DESC LIMIT 20)')
      .get(m.id, kind) as { i: number | null; o: number | null; n: number }
    const t = Number(avg.n) > 0 ? { input: Number(avg.i), output: Number(avg.o) } : TYPICAL[kind]
    const cost = costOf(m.id, t.input, t.output)
    if (cost === null) return 'billed to your account per request'
    if (cost < 0.001) return 'under $0.001'
    return `about $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`
  }

  // ---- The viewer's taste, as the prompt describes it ----

  private tasteText (profile: Profile): TasteText {
    const t = this.d.reco.taste(profile)
    const entries: HistoryEntry[] = []
    for (const s of t.signals) {
      const it = this.d.items.lookup(s.item.id)
      const name = it?.name ?? (s.item.name !== s.item.id ? s.item.name : '')
      if (!name) continue
      entries.push({ id: s.item.id, name, year: it?.year ?? (Number.parseInt(s.item.year ?? '', 10) || undefined), type: s.item.type, label: s.label, weight: s.weight })
    }
    return { entries, more: t.prefs.filter(f => f.pref === 1).map(f => f.label), never: t.prefs.filter(f => f.pref === -1).map(f => f.label) }
  }

  // ---- Saved answers ----

  private saved (profileId: string, kind: 'picks' | 'search', key: string): { model: string; at: number; data: Saved[] } | null {
    const r = this.d.db.prepare('SELECT model, at, data FROM ai_results WHERE profile_id = ? AND kind = ? AND key = ?').get(profileId, kind, key) as { model: string; at: number; data: string } | undefined
    return r ? { model: r.model, at: Number(r.at), data: JSON.parse(r.data) as Saved[] } : null
  }

  private save (profileId: string, kind: 'picks' | 'search', key: string, model: string, data: Saved[]): void {
    this.d.db.prepare(`INSERT INTO ai_results (profile_id, kind, key, model, at, data) VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT (profile_id, kind, key) DO UPDATE SET model = excluded.model, at = excluded.at, data = excluded.data`)
      .run(profileId, kind, key, model, this.now(), JSON.stringify(data))
    if (kind === 'search') this.d.db.prepare("DELETE FROM ai_results WHERE kind = 'search' AND at < ?").run(this.now() - 2 * SEARCH_TTL_MS)
  }

  /** What may be shown to this profile now: not rated, dismissed or watched since, nothing it turned off. */
  private filter (profile: Profile, strict: boolean): (it: ItemMeta) => boolean {
    const snap = this.d.store.snapshot(profile.id)
    const now = this.now()
    if (!strict) {
      const no = new Set([...snap.ratings.filter(r => r.value < 0).map(r => r.id), ...snap.dismissals.map(d => d.id)])
      return it => !no.has(it.id) && Boolean(it.poster)
    }
    const exclude = exclusions(snap)
    const muted = new Set([...snap.prefs].filter(([, v]) => v === -1).map(([k]) => k))
    return it => !exclude.has(it.id) && isRecommendable(it, now) && !(muted.size && rawFeatures(it).some(([k]) => muted.has(k)))
  }

  private toItems (profile: Profile, data: Saved[], strict: boolean): RecItem[] {
    const ok = this.filter(profile, strict)
    const out: RecItem[] = []
    for (const s of data) {
      const it = this.d.items.lookup(s.id)
      if (it && ok(it)) out.push(toRecItem(it, { kind: 'ai', text: s.why || it.genres.slice(0, 2).join(' · '), seed: s.seed }))
    }
    return out
  }

  // ---- AI picks ----

  modelName (id: string): string {
    return this.models().find(m => m.id === id)?.name ?? id
  }

  /** The saved picks (no model request). */
  picks (profile: Profile, opts: { private?: boolean } = {}): AiPicksResponse {
    const active = this.active()
    const available = !opts.private && active !== null
    const s = this.saved(profile.id, 'picks', '')
    const picks: AiPicks | null = s && !opts.private ? { items: interleave(this.toItems(profile, s.data, true)), at: s.at, model: this.modelName(s.model) } : null
    return { available, picks, hint: active ? `${active.model.name} · ${this.estimate(active.model, 'picks')}` : undefined }
  }

  /** Asks the model for new picks (the viewer pressed the button), saves and returns them. */
  makePicks (profile: Profile): Promise<AiPicksResponse> {
    return this.once(`picks:${profile.id}`, async () => {
      const prev = this.saved(profile.id, 'picks', '')
      const before = (prev?.data ?? []).map(s => this.d.items.lookup(s.id)).filter((it): it is ItemMeta => Boolean(it)).slice(0, 40).map(it => titleLine(it))
      const taste = this.tasteText(profile)
      const { text, model } = await this.ask('picks', { system: PICKS_SYSTEM, prompt: picksPrompt(taste, before, this.now()), schema: SUGGESTIONS_SCHEMA, effort: 'medium', maxTokens: 16_000 })
      const data = await this.resolve(text, taste)
      if (!this.toItems(profile, data, true).length) throw new HttpError(502, `${model.name} didn’t suggest anything that could be found in the catalogue. Try again, or pick another model in AI settings.`)
      this.save(profile.id, 'picks', '', model.id, data)
      return this.picks(profile)
    })
  }

  // ---- AI search ----

  async search (profile: Profile, query: string, refresh: boolean): Promise<AiSearchResponse> {
    const key = query.toLowerCase().replace(/\s+/g, ' ').trim()
    const hit = this.saved(profile.id, 'search', key)
    if (hit && !refresh && this.now() - hit.at < SEARCH_TTL_MS) {
      return { items: this.toItems(profile, hit.data, false), at: hit.at, model: this.modelName(hit.model), cached: true }
    }
    return this.once(`search:${profile.id}:${key}`, async () => {
      const taste = this.tasteText(profile)
      const { text, model } = await this.ask('search', { system: SEARCH_SYSTEM, prompt: searchPrompt(query, taste, this.now()), schema: SUGGESTIONS_SCHEMA, effort: 'low', maxTokens: 8_000 })
      const data = await this.resolve(text, taste)
      this.save(profile.id, 'search', key, model.id, data)
      return { items: this.toItems(profile, data, false), at: this.now(), model: model.name, cached: false }
    })
  }

  /** The model's titles, found in the catalogue, with their "because" pointed at the liked title it names. */
  private async resolve (text: string, taste: TasteText): Promise<Saved[]> {
    const suggestions = parseSuggestions(text)
    const found = await resolveAll(this.d.items, suggestions)
    const liked = new Map<string, HistoryEntry>()
    for (const e of taste.entries) if (e.weight > 0 && e.id) liked.set(normTitle(e.name), e)
    const out: Saved[] = []
    for (const { suggestion: s, item } of found) {
      // "because" names a liked title, as the prompt listed it ("Dark (2017, series)").
      const seed = s.because ? liked.get(normTitle(s.because.replace(/\s*\([^)]*\)\s*$/, ''))) : undefined
      out.push({ id: item.id, type: item.type, why: s.why, seed: seed && seed.id !== item.id ? { id: seed.id!, type: seed.type, name: seed.name } : undefined })
    }
    this.d.log?.(`ai: ${suggestions.length} suggested, ${out.length} found in the catalogue`)
    return out
  }

  private once<T> (key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key)
    if (running) return running as Promise<T>
    const p = fn().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }
}

/** Films and series alternating, each in the model's order, for the home screen (the tabs filter one kind). */
export function interleave (items: RecItem[]): RecItem[] {
  const m = items.filter(i => i.type === 'movie')
  const s = items.filter(i => i.type === 'series')
  const out: RecItem[] = []
  for (let i = 0; i < Math.max(m.length, s.length); i++) {
    if (m[i]) out.push(m[i])
    if (s[i]) out.push(s[i])
  }
  return out
}

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
const startOfMonth = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime() }
