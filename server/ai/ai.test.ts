import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiModel } from '../../shared/types.ts'
import { openDb } from '../db.ts'
import { HttpError } from '../http.ts'
import { SqliteTasteStore } from '../store.ts'
import { ItemCache } from '../taste/items.ts'
import { RecoService } from '../taste/service.ts'
import { ChatgptAuth } from './chatgpt.ts'
import { claudeModels, openAiModels } from './models.ts'
import { parseSuggestions, picksPrompt, type Suggestion, SUGGESTIONS_SCHEMA, tasteText } from './prompts.ts'
import { AiError, type Ask, makeProviders, type ProviderApi } from './providers.ts'
import { matchScore, normTitle } from './resolve.ts'
import { AiService } from './service.ts'

// AI picks and search without a real model: a fake provider answers, a fake Cinemeta knows the titles.

describe('models', () => {
  it('Automatic is the newest model of Claude’s cheapest line', () => {
    const caps = { structured_outputs: { supported: true } }
    const list = claudeModels([
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-01T00:00:00Z', line: 'opus', capabilities: caps },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', line: 'haiku', capabilities: caps },
      { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z', line: 'haiku', capabilities: caps },
      { id: 'claude-mythos-5-2', display_name: 'Claude Mythos 5.2', created_at: '2026-10-05T00:00:00Z', line: 'mythos', capabilities: caps },
      { id: 'claude-3-old', display_name: 'Old', created_at: '2024-01-01T00:00:00Z', line: 'sonnet', lifecycle: 'retired', capabilities: caps },
    ])
    expect(list.map(m => m.id)).toEqual(['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-opus-5-5'])
    expect(list[0].price).toEqual({ input: 0.1, output: 0.5 })
  })

  it('Automatic is the cheapest line of OpenAI’s newest generation, skipping snapshots and odd variants', () => {
    const ids = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5-nano', 'gpt-5.4-nano', 'gpt-5.5-pro', 'gpt-4o', 'gpt-5-2025-08-07', 'gpt-realtime', 'o3']
    const list = openAiModels(ids.map(id => ({ id })), 'openai')
    expect(list[0].id).toBe('gpt-6-luna')
    expect(list.map(m => m.id)).not.toContain('gpt-5.5-pro')
    expect(list.map(m => m.id)).not.toContain('gpt-5-2025-08-07')
    expect(list.slice(0, 4).map(m => m.id)).toEqual(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'])
    // A ChatGPT sign-in lists slugs, hides some, and has no per-request price.
    const plan = openAiModels([{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }, { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'hide' }], 'chatgpt')
    expect(plan.map(m => [m.id, m.name, m.price])).toEqual([['gpt-6.1-sol', 'GPT-6.1 Sol', undefined]])
  })
})

describe('prompts', () => {
  it('reads the model’s JSON, even wrapped in prose, and drops junk', () => {
    const text = 'Sure!\n```json\n{"titles":[{"title":"Dark","year":2017,"type":"series","imdbId":"tt5753856","because":"","why":"Twisty"},{"title":"","year":1},{"title":"Primer","year":"x","type":"film","imdbId":"bogus"}]}\n```'
    expect(parseSuggestions(text)).toEqual([
      { title: 'Dark', year: 2017, type: 'series', imdbId: 'tt5753856', because: '', why: 'Twisty' },
      { title: 'Primer', year: 0, type: 'movie', imdbId: '', because: '', why: '' },
    ])
    expect(parseSuggestions('no json here')).toEqual([])
  })

  it('describes the history in groups, strongest first, and lists what was suggested before', () => {
    const t = tasteText({
      entries: [
        { name: 'Dark', year: 2017, type: 'series', label: 'Liked', weight: 0.6 },
        { name: 'Arrival', year: 2016, type: 'movie', label: 'Liked', weight: 1 },
        { name: 'Friends', year: 1994, type: 'series', label: 'Disliked', weight: -1 },
        { name: 'Lost', year: 2004, type: 'series', label: 'Stopped early', weight: -0.3 },
      ],
      more: ['South Korea'],
      never: ['Animation'],
    })
    expect(t).toContain('Liked:\n- Arrival (2016, film)\n- Dark (2017, series)')
    expect(t).toContain('Disliked:\n- Friends (1994, series)')
    expect(t).toContain('Stopped early:\n- Lost (2004, series)')
    expect(t).toContain('More of: South Korea')
    expect(t).toContain('Never show: Animation')
    expect(picksPrompt({ entries: [], more: [], never: [] }, ['Oldboy (2003, film)'], Date.UTC(2026, 10, 11))).toMatch(/Today is 2026-11-11[\s\S]*Suggested before:\n- Oldboy \(2003, film\)/)
  })
})

describe('matching titles', () => {
  it('needs the name, and the year when there is one', () => {
    expect(normTitle('The Office (UK)')).toBe('officeuk')
    expect(normTitle('Amélie')).toBe('amelie')
    expect(matchScore({ title: 'Oldboy', year: 2003 }, { name: 'Oldboy', year: 2003 })).toBe(3)
    expect(matchScore({ title: 'Oldboy', year: 2003 }, { name: 'Oldboy', year: 2013 })).toBe(1)
    expect(matchScore({ title: 'Shōgun', year: 2024 }, { name: 'Shogun', year: 2024 })).toBe(3)
    expect(matchScore({ title: 'Mission: Impossible - Dead Reckoning', year: 2023 }, { name: 'Mission: Impossible - Dead Reckoning Part One', year: 2023 })).toBe(2)
    expect(matchScore({ title: 'Dune', year: 2021 }, { name: 'Dunkirk', year: 2017 })).toBe(0)
  })
})

// ---- The service, end to end ----

const meta = (id: string, type: 'movie' | 'series', name: string, year: number, genres: string[], country = 'United States') => ({
  id, imdb_id: id, type, name, releaseInfo: type === 'series' ? `${year}–` : String(year), released: `${year}-03-01T00:00:00.000Z`,
  poster: `https://images.metahub.space/poster/small/${id}/img`, genre: genres, country, imdbRating: '8.0', popularities: { moviedb: 20 },
  runtime: '110 min', description: `${name}: a story.`,
})
const METAS = [
  meta('tt0000001', 'series', 'Severance', 2022, ['Drama', 'Mystery', 'Sci-Fi']),
  meta('tt0000002', 'series', 'Dark', 2017, ['Crime', 'Drama', 'Mystery'], 'Germany'),
  meta('tt0000003', 'movie', 'Arrival', 2016, ['Drama', 'Sci-Fi']),
  meta('tt0000004', 'series', 'Friends', 1994, ['Comedy', 'Romance']),
  meta('tt0000005', 'movie', 'Oldboy', 2003, ['Action', 'Drama', 'Mystery'], 'South Korea'),
  meta('tt0000006', 'movie', 'Oldboy', 2013, ['Action', 'Drama', 'Mystery']),
  meta('tt0000007', 'series', 'Black Mirror', 2011, ['Drama', 'Mystery', 'Sci-Fi'], 'United Kingdom'),
  meta('tt0000008', 'movie', 'Coherence', 2013, ['Drama', 'Mystery', 'Sci-Fi']),
  meta('tt0000009', 'series', 'Mr. Robot', 2015, ['Crime', 'Drama', 'Thriller']),
  meta('tt0000010', 'movie', 'Primer', 2004, ['Drama', 'Sci-Fi', 'Thriller']),
  meta('tt0000011', 'series', 'Westworld', 2016, ['Drama', 'Mystery', 'Sci-Fi', 'Western']),
]

let searches = 0
async function fakeCinemeta (url: string): Promise<unknown> {
  const m = /\/meta\/(movie|series)\/(tt\d+)\.json$/.exec(url)
  if (m) return { meta: METAS.find(x => x.id === m[2]) }
  const s = /\/catalog\/(movie|series)\/top\/search=([^/]+)\.json$/.exec(url)
  if (s) {
    searches++
    const q = normTitle(decodeURIComponent(s[2]))
    // Like Cinemeta: search results are thin (no genres), so a title needs its own fetch before it can be shown.
    return { metas: METAS.filter(x => x.type === s[1] && normTitle(x.name).includes(q)).map(x => ({ id: x.id, imdb_id: x.id, type: x.type, name: x.name, releaseInfo: x.releaseInfo })) }
  }
  return { metas: [] }
}

const sug = (title: string, year: number, type: 'movie' | 'series', why: string, because = '', imdbId = ''): Suggestion => ({ title, year, type, imdbId, because, why })
const PICKS: Suggestion[] = [
  sug('Coherence', 2013, 'movie', 'A dinner party splinters into realities.', 'Arrival (2016, film)'),
  sug('Oldboy', 2003, 'movie', 'Park Chan-wook’s revenge puzzle.'),
  sug('The Glass Lighthouse', 2019, 'movie', 'Invented: should never show.'),
  sug('Dark', 2017, 'series', 'Already liked: should be filtered.'),
  sug('Black Mirror', 2011, 'series', 'Tech dread, one story at a time.', 'Severance (2022, series)'),
  sug('Mr. Robot', 2015, 'series', 'A hacker’s paranoia from the inside.', 'Severance', 'tt0000009'),
  sug('Westworld', 2016, 'movie', 'Wrong type from the model: still found.'),
]

class FakeProvider implements ProviderApi {
  asks: Ask[] = []
  answer: Suggestion[] = PICKS
  fail: AiError | null = null
  searches = 0
  async models (cred: { provider: string; secret: string }): Promise<AiModel[]> {
    if (cred.secret.includes('bad')) throw new AiError('auth', 'Claude turned down the API key.')
    return [
      { id: 'claude-haiku-5-5', provider: 'anthropic', name: 'Claude Haiku 5.5', tier: 0, price: { input: 0.1, output: 0.5 } },
      { id: 'claude-opus-5-5', provider: 'anthropic', name: 'Claude Opus 5.5', tier: 2, price: { input: 4, output: 20 } },
    ]
  }

  async ask (_cred: unknown, _model: string, q: Ask) {
    this.asks.push(q)
    if (this.fail) throw this.fail
    return { text: JSON.stringify({ titles: this.answer }), inputTokens: 2000, outputTokens: 3000, searches: this.searches }
  }
}

const opened: Array<{ dir: string; db: DatabaseSync }> = []
afterEach(() => {
  for (const o of opened.splice(0)) { o.db.close(); rmSync(o.dir, { recursive: true, force: true }) }
})

async function setup () {
  const dir = mkdtempSync(join(tmpdir(), 'nexttupp-ai-'))
  const db = openDb(join(dir, 'nexttupp.db'))
  opened.push({ dir, db })
  const store = new SqliteTasteStore(db)
  const items = new ItemCache(db, { baseUrl: 'https://cinemeta.test', fetch: fakeCinemeta, intervalMs: 0, concurrency: 8 })
  const reco = new RecoService({ store, items, cf: null })
  const me = store.defaultProfile()
  for (const id of ['tt0000001', 'tt0000002', 'tt0000003']) {
    const m = METAS.find(x => x.id === id)!
    await items.ensure([{ id, type: m.type }])
    store.setRating(me.id, { id, type: m.type }, 1)
  }
  await items.ensure([{ id: 'tt0000004', type: 'series' }])
  store.setRating(me.id, { id: 'tt0000004', type: 'series' }, -1)
  const provider = new FakeProvider()
  let now = Date.UTC(2026, 10, 11, 12)
  const ai = new AiService({ db, dataDir: dir, items, reco, store, providers: provider, chatgpt: new ChatgptAuth(), now: () => now })
  return { dir, db, store, items, me, provider, ai, tick: (ms: number) => { now += ms } }
}

describe('AiService', () => {
  it('keeps the key in an owner-only file and never shows it', async () => {
    const { ai, dir } = await setup()
    await expect(ai.connectKey('anthropic', 'sk-ant-bad-key-0000000000')).rejects.toThrow(HttpError)
    await ai.connectKey('anthropic', 'sk-ant-api03-secret-4f2a')
    const status = ai.status(true)
    expect(JSON.stringify(status)).not.toContain('secret')
    expect(status.connections).toEqual([expect.objectContaining({ provider: 'anthropic', label: 'Key ending 4f2a' })])
    expect(status.active).toEqual({ model: expect.objectContaining({ id: 'claude-haiku-5-5' }), auto: true })
    expect(status.estimate?.picks).toBe('about $0.02')
    expect(statSync(join(dir, 'ai.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'ai.json'), 'utf8')).toContain('sk-ant-api03-secret-4f2a')
  })

  it('asks for picks only when told to, keeps real titles the viewer hasn’t seen, and serves them again for free', async () => {
    const { ai, me, provider, store } = await setup()
    expect(ai.picks(me)).toEqual({ available: false, picks: null, hint: undefined })
    await ai.connectKey('anthropic', 'sk-ant-api03-secret-4f2a')
    expect(ai.picks(me).picks).toBeNull()
    expect(provider.asks).toHaveLength(0)

    const res = await ai.makePicks(me)
    expect(provider.asks).toHaveLength(1)
    expect(provider.asks[0].prompt).toContain('- Severance (2022, series)')
    expect(provider.asks[0].prompt).toContain('Disliked:\n- Friends (1994, series)')
    const items = res.picks!.items
    // Invented title dropped, liked title filtered, the 2003 Oldboy (not the remake), Westworld found as a series.
    expect(items.map(i => i.name).sort()).toEqual(['Black Mirror', 'Coherence', 'Mr. Robot', 'Oldboy', 'Westworld'])
    expect(items.find(i => i.name === 'Oldboy')!.id).toBe('tt0000005')
    expect(items.find(i => i.name === 'Coherence')!.reason).toEqual({ kind: 'ai', text: 'A dinner party splinters into realities.', seed: { id: 'tt0000003', type: 'movie', name: 'Arrival' } })
    expect(items.find(i => i.name === 'Mr. Robot')!.reason.seed?.id).toBe('tt0000001')
    expect(items.map(i => i.type).slice(0, 4)).toEqual(['movie', 'series', 'movie', 'series'])

    // Showing them again doesn't ask; a title disliked since disappears.
    store.setRating(me.id, { id: 'tt0000005', type: 'movie' }, -1)
    const again = ai.picks(me)
    expect(provider.asks).toHaveLength(1)
    expect(again.picks!.items.map(i => i.name)).not.toContain('Oldboy')
    expect(ai.picks(me, { private: true })).toMatchObject({ available: false, picks: null })

    // Refreshing tells the model what it suggested last time.
    await ai.makePicks(me)
    expect(provider.asks[1].prompt).toContain('Suggested before:\n- Coherence (2013, film)')
    expect(ai.status(true).usage.month).toMatchObject({ requests: 2, inputTokens: 4000, outputTokens: 6000, costUsd: 0.0034 })
  })

  it('answers the same search from what it saved, and asks again only on refresh', async () => {
    const { ai, me, provider } = await setup()
    await ai.connectKey('anthropic', 'sk-ant-api03-secret-4f2a')
    provider.answer = [sug('Primer', 2004, 'movie', 'Garage time travel, no hand-holding.'), sug('Dark', 2017, 'series', 'You liked it: search may show it.')]
    const first = await ai.search(me, 'Mind-bending   time travel', false)
    expect(first).toMatchObject({ cached: false, model: 'Claude Haiku 5.5' })
    expect(first.items.map(i => i.name)).toEqual(['Primer', 'Dark'])
    expect(provider.asks[0].effort).toBe('low')
    const second = await ai.search(me, 'mind-bending time travel', false)
    expect(second.cached).toBe(true)
    expect(provider.asks).toHaveLength(1)
    await ai.search(me, 'mind-bending time travel', true)
    expect(provider.asks).toHaveLength(2)
  })

  it('lets the model search the web for Ask AI and picks, and counts the searches in the cost', async () => {
    const { ai, me, provider } = await setup()
    await ai.connectKey('anthropic', 'sk-ant-api03-secret-4f2a')
    provider.searches = 3
    await ai.search(me, 'the best new sci-fi series this year', false)
    expect(provider.asks[0].search).toBeGreaterThan(0)
    // Haiku 5.5: 2,000 tokens in and 3,000 out is $0.0017, and 3 searches at $10 per 1,000 add $0.03.
    expect(ai.status(true).usage.month.costUsd).toBe(0.0317)
    await ai.makePicks(me)
    expect(provider.asks[1].search).toBeGreaterThan(0)
  })

  it('stops at the daily limit and flags a connection that needs fixing', async () => {
    const { ai, me, provider, tick } = await setup()
    await ai.connectKey('anthropic', 'sk-ant-api03-secret-4f2a')
    ai.settings({ dailyLimit: 1 })
    await ai.search(me, 'one', false)
    await expect(ai.search(me, 'two', false)).rejects.toMatchObject({ status: 429 })
    tick(24 * 3600_000)
    provider.fail = new AiError('credit', 'Your Claude account is out of credit.')
    await expect(ai.search(me, 'three', false)).rejects.toMatchObject({ message: 'Your Claude account is out of credit.' })
    expect(ai.status(true).connections[0].problem).toBe('Your Claude account is out of credit.')
    provider.fail = null
    await ai.search(me, 'four', false)
    expect(ai.status(true).connections[0].problem).toBeUndefined()
  })

  it('uses the chosen model, and falls back to Automatic when it’s gone', async () => {
    const { ai } = await setup()
    await ai.connectKey('anthropic', 'sk-ant-api03-secret-4f2a')
    ai.settings({ choice: 'claude-opus-5-5' })
    expect(ai.active()).toMatchObject({ model: { id: 'claude-opus-5-5' }, auto: false })
    ai.settings({ choice: 'claude-gone-1' })
    expect(ai.active()).toMatchObject({ model: { id: 'claude-haiku-5-5' }, auto: true })
  })
})

// ---- Sign in with ChatGPT ----

// ---- Web search, at the providers' HTTP boundary ----------------------------------------------------------

type Sent = { url: string; body: Record<string, any> }
/** A fake provider API: answers each request with the next reply (a JSON body, [status, body], or { events } streamed). */
function fakeApi (...replies: Array<object | [number, object] | { events: object[] }>) {
  const sent: Sent[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    const r = replies.shift()
    if (!r) throw new Error('no more replies')
    if ('events' in r) {
      const sse = r.events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const [status, body] = Array.isArray(r) ? r : [200, r]
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { sent, fetch: fetch as typeof globalThis.fetch }
}

const ASK: Ask = { system: 'Pick films.', prompt: 'New sci-fi series?', schema: SUGGESTIONS_SCHEMA, effort: 'low', maxTokens: 8000, search: 5 }
const claudeReply = (content: object[], usage: object, stop = 'end_turn') => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stop, stop_sequence: null, stop_details: null,
  usage: { input_tokens: 0, output_tokens: 0, ...usage },
})
const searched = (id: string) => [
  { type: 'server_tool_use', id, name: 'web_search', input: { query: 'best new sci-fi series' } },
  { type: 'web_search_tool_result', tool_use_id: id, content: [{ type: 'web_search_result', url: 'https://news.test/a', title: 'New sci-fi', encrypted_content: 'x', page_age: null }] },
]
const cite = { type: 'web_search_result_location', url: 'https://news.test/a', title: 'New sci-fi', encrypted_index: 'i', cited_text: 'a strange new series' }

describe('web search on Claude', () => {
  it('searches with the web search tool and reads the titles it writes after searching', async () => {
    const api = fakeApi(claudeReply([
      { type: 'text', text: 'Let me check what came out recently.' },
      ...searched('srvtoolu_1'),
      // Search answers come with citations, which split the text into pieces.
      { type: 'text', text: '{"titles":[{"title":"Pluribus","year":2025,"type":"series",' },
      { type: 'text', text: '"imdbId":"","because":"","why":"A strange new series."}]}', citations: [cite] },
    ], { input_tokens: 21000, output_tokens: 900, server_tool_use: { web_search_requests: 1 } }))
    const ans = await makeProviders({ fetch: api.fetch }).ask({ provider: 'anthropic', secret: 'sk-ant-test' }, 'claude-sonnet-5-5', ASK)
    expect(api.sent[0].body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }])
    expect(parseSuggestions(ans.text).map(t => t.title)).toEqual(['Pluribus'])
    expect(ans).toMatchObject({ inputTokens: 21000, outputTokens: 900, searches: 1 })
  })

  it('uses the basic search tool on models without the newer one, and carries on after a pause', async () => {
    const api = fakeApi(
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0: web_search_20260209 is not supported on claude-haiku-4-5' } }],
      claudeReply(searched('srvtoolu_1'), { input_tokens: 9000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } }, 'pause_turn'),
      claudeReply([...searched('srvtoolu_2'), { type: 'text', text: '{"titles":[{"title":"Pluribus","year":2025,"type":"series","imdbId":"","because":"","why":"New."}]}' }],
        { input_tokens: 12000, output_tokens: 400, server_tool_use: { web_search_requests: 1 } }),
    )
    const ans = await makeProviders({ fetch: api.fetch }).ask({ provider: 'anthropic', secret: 'sk-ant-test' }, 'claude-haiku-4-5', ASK)
    expect(api.sent.map(s => s.body.tools[0].type)).toEqual(['web_search_20260209', 'web_search_20250305', 'web_search_20250305'])
    // The paused turn goes back as it was, so the search picks up where it stopped.
    expect(api.sent[2].body.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'server_tool_use' }, { type: 'web_search_tool_result' }] })
    expect(parseSuggestions(ans.text).map(t => t.title)).toEqual(['Pluribus'])
    expect(ans).toMatchObject({ inputTokens: 21000, outputTokens: 500, searches: 2 })
  })
})

const PLURIBUS = '{"titles":[{"title":"Pluribus","year":2025,"type":"series","imdbId":"","because":"","why":"A strange new series."}]}'
/** A finished OpenAI response, streamed: what it searched for, then its answer. */
const openAiStream = (queries: string[]) => ({
  events: [
    { type: 'response.output_text.delta', delta: PLURIBUS, item_id: 'msg_1', output_index: queries.length, content_index: 0, sequence_number: 1 },
    {
      type: 'response.completed',
      sequence_number: 2,
      response: {
        id: 'resp_1', object: 'response', status: 'completed',
        output: [
          ...queries.map((query, i) => ({ id: `ws_${i}`, type: 'web_search_call', status: 'completed', action: { type: 'search', query } })),
          { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: PLURIBUS, annotations: [] }] },
        ],
        usage: { input_tokens: 18000, output_tokens: 700, total_tokens: 18700 },
      },
    },
  ],
})

describe('web search on OpenAI and ChatGPT', () => {
  it('searches with the web_search tool, keeps the JSON schema, and counts the searches', async () => {
    const api = fakeApi(openAiStream(['new sci-fi series 2026', 'Pluribus reviews']))
    const ans = await makeProviders({ fetch: api.fetch }).ask({ provider: 'openai', secret: 'sk-test' }, 'gpt-6.2-sol', ASK)
    expect(api.sent[0].body).toMatchObject({ tools: [{ type: 'web_search' }], max_tool_calls: 5, text: { format: { type: 'json_schema' } } })
    expect(parseSuggestions(ans.text).map(t => t.title)).toEqual(['Pluribus'])
    expect(ans).toMatchObject({ inputTokens: 18000, outputTokens: 700, searches: 2 })
  })

  it('answers without searching when the account doesn’t allow it', async () => {
    const api = fakeApi(
      [400, { error: { message: 'Tool web_search is not supported with this plan.', type: 'invalid_request_error', param: 'tools', code: null } }],
      openAiStream([]),
    )
    const ans = await makeProviders({ fetch: api.fetch }).ask({ provider: 'chatgpt', secret: 'chatgpt-access-token' }, 'gpt-6.2-sol', ASK)
    expect(api.sent[1].body.tools).toBeUndefined()
    expect(parseSuggestions(ans.text).map(t => t.title)).toEqual(['Pluribus'])
    expect(ans.searches).toBe(0)
  })
})

describe('ChatgptAuth', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }
  const jwt = (claims: Record<string, unknown>) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`
  }
  const NOW = Date.UTC(2026, 10, 11)

  function flow (opts: { scope?: string; nonce?: string } = {}) {
    const posts: Array<{ url: string; body: string }> = []
    const auth = new ChatgptAuth({
      now: () => NOW,
      fetch: (async (url: string, init?: RequestInit) => {
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
        if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' })
        if (url.endsWith('/jwks')) return json({ keys: [jwk] })
        posts.push({ url, body: String(init?.body) })
        const nonce = opts.nonce ?? new URL(started).searchParams.get('nonce')
        return json({
          access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: opts.scope ?? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          id_token: jwt({ iss: 'https://auth.openai.com', aud: 'oaiapp_123', exp: NOW / 1000 + 3600, nonce, sub: 'user-1', email: 'me@example.com' }),
        })
      }) as typeof fetch,
    })
    const started = auth.start('http://127.0.0.1:4545/auth/callback', 'urn:uuid:host', null)
    return { auth, started, posts, state: new URL(started).searchParams.get('state')! }
  }

  it('registers on first sign-in and checks the ID token', async () => {
    const { auth, started, posts, state } = flow()
    const u = new URL(started)
    expect(u.origin + u.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'dynamic_agent_client', agent_name_hint: 'nexttupp', ext_agent_host_id: 'urn:uuid:host', response_type: 'code',
      redirect_uri: 'http://127.0.0.1:4545/auth/callback', resource: 'https://api.openai.com/v1', code_challenge_method: 'S256',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    })
    expect(auth.signingIn).toBe(true)
    const s = await auth.finish({ code: 'c1', state, client_id: 'oaiapp_123' })
    expect(s).toMatchObject({ clientId: 'oaiapp_123', sub: 'user-1', email: 'me@example.com', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: NOW + 3600_000 })
    const body = new URLSearchParams(posts[0].body)
    expect(posts[0].url).toBe('https://auth.openai.com/api/accounts/oauth/token')
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', client_id: 'oaiapp_123', code: 'c1', redirect_uri: 'http://127.0.0.1:4545/auth/callback' })
    expect(body.get('code_verifier')).toBeTruthy()
    expect(auth.signingIn).toBe(false)
  })

  it('refuses a wrong state, a reply without plan access, and a token for another sign-in', async () => {
    const a = flow()
    await expect(a.auth.finish({ code: 'c1', state: 'forged', client_id: 'oaiapp_123' })).rejects.toThrow(/expired or was already used/)
    const b = flow({ scope: 'openid profile email offline_access' })
    await expect(b.auth.finish({ code: 'c1', state: b.state, client_id: 'oaiapp_123' })).rejects.toThrow(/plan wasn’t allowed/)
    const c = flow({ nonce: 'other' })
    await expect(c.auth.finish({ code: 'c1', state: c.state, client_id: 'oaiapp_123' })).rejects.toThrow(/didn’t check out/)
    const d = flow()
    await expect(d.auth.finish({ error: 'access_denied', state: d.state })).rejects.toThrow(/cancelled/)
  })
})
