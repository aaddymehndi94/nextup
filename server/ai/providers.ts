import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { AiModel, AiProvider } from '../../shared/types.ts'
import { claudeModels, type ClaudeModelInfo, openAiModels, type OpenAiModelInfo } from './models.ts'

// One way to ask any connected provider for JSON: Claude through the Anthropic SDK, GPT through the OpenAI SDK
// (an API key, or a ChatGPT sign-in's access token, which the Responses API takes the same way).
//
// With `search`, the model may search the web first (Claude's web search tool, OpenAI's web_search tool), so it
// can name titles newer than it was trained on. Claude's search results come with citations, which can't be
// combined with a JSON schema, so a searching Claude is asked for the JSON in words instead (parseSuggestions
// reads it either way).

type Fetch = typeof globalThis.fetch

export interface Ask {
  system: string
  prompt: string
  schema: Record<string, unknown>
  /** Thinking/reasoning depth: low for search (quick), medium for picks. */
  effort: 'low' | 'medium'
  /** Claude only; ChatGPT sign-in rejects an output cap. */
  maxTokens: number
  /** Lets the model search the web, at most this many times (for titles newer than it knows). Off when 0 or left out. */
  search?: number
}

export interface Answer { text: string; inputTokens: number; outputTokens: number; searches?: number }

export type AiErrorKind = 'auth' | 'credit' | 'limit' | 'busy' | 'model' | 'refused' | 'network' | 'other'

/** A failure with a message fit to show. `kind` auth/credit/limit mark the connection as needing attention. */
export class AiError extends Error {
  readonly kind: AiErrorKind
  constructor (kind: AiErrorKind, message: string) { super(message); this.kind = kind }
}

export interface Credential { provider: AiProvider; secret: string }

/** What the service needs from a provider; tests substitute their own. */
export interface ProviderApi {
  models (cred: Credential): Promise<AiModel[]>
  ask (cred: Credential, model: string, q: Ask): Promise<Answer>
}

const NAMES: Record<AiProvider, string> = { anthropic: 'Claude', openai: 'OpenAI', chatgpt: 'ChatGPT' }

/** For when the answer can't be held to the schema: the same shape, asked for in words. */
const JSON_IN_WORDS = '\n\nAnswer with JSON only, in this shape: {"titles":[{"title":"","year":0,"type":"movie","imdbId":"","because":"","why":""}]}'
/** Searching takes a while: several searches, then reading the results. */
const SEARCH_TIMEOUT_MS = 300_000

// ---- Claude ----

const claude = (key: string, fetch?: Fetch) => new Anthropic({ apiKey: key, authToken: null, maxRetries: 2, timeout: 120_000, fetch })

function claudeError (err: unknown): AiError {
  if (err instanceof AiError) return err
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiError('auth', 'Claude turned down the API key. Check it in AI settings, or make a new one at platform.claude.com.')
  }
  if (err instanceof Anthropic.NotFoundError) return new AiError('model', 'That Claude model isn’t available to this key. Pick another in AI settings.')
  if (err instanceof Anthropic.RateLimitError) return new AiError('busy', 'Claude is limiting requests from this key right now. Try again in a minute.')
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return new AiError('credit', 'Your Claude account is out of credit. Add some at platform.claude.com, under Billing.')
    return new AiError('other', `Claude refused the request: ${err.message}`)
  }
  if (err instanceof Anthropic.InternalServerError) return new AiError('busy', 'Claude is busy or down right now. Try again in a minute.')
  if (err instanceof Anthropic.APIConnectionError) return new AiError('network', 'Couldn’t reach Claude. Check the internet connection.')
  return new AiError('other', (err as Error)?.message ?? 'Claude request failed')
}

async function claudeModelsOf (key: string, fetch?: Fetch): Promise<AiModel[]> {
  try {
    const list: ClaudeModelInfo[] = []
    for await (const m of claude(key, fetch).models.list()) list.push(m as unknown as ClaudeModelInfo)
    return claudeModels(list)
  } catch (err) { throw claudeError(err) }
}

/** Web search with dynamic filtering (newer models), then the basic tool that every model takes. */
const CLAUDE_SEARCH = ['web_search_20260209', 'web_search_20250305'] as const
/** A long search pauses the turn; it's sent back to carry on, at most this many times. */
const MAX_PAUSES = 3

async function claudeAsk (key: string, model: string, q: Ask, fetch?: Fetch): Promise<Answer> {
  const client = claude(key, fetch)
  const searches = q.search ?? 0
  let tool: typeof CLAUDE_SEARCH[number] | null = searches > 0 ? CLAUDE_SEARCH[0] : null
  let effort = true
  const send = (messages: Anthropic.MessageParam[]) => client.messages.create({
    model,
    max_tokens: q.maxTokens,
    system: tool ? q.system + JSON_IN_WORDS : q.system,
    messages,
    ...(tool ? { tools: [tool === 'web_search_20260209' ? { type: tool, name: 'web_search' as const, max_uses: searches } : { type: tool, name: 'web_search' as const, max_uses: searches }] } : {}),
    output_config: { ...(tool ? {} : { format: { type: 'json_schema' as const, schema: q.schema } }), ...(effort ? { effort: q.effort } : {}) },
  }, tool ? { timeout: SEARCH_TIMEOUT_MS } : undefined)
  // Older models take no effort setting (Claude Haiku 4.5) or only the basic search tool: ask again without.
  const sendWithFallbacks = async (messages: Anthropic.MessageParam[]): Promise<Anthropic.Message> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(messages)
      } catch (err) {
        if (attempt < 2 && err instanceof Anthropic.BadRequestError) {
          if (tool === CLAUDE_SEARCH[0] && /web_search/i.test(err.message)) { tool = CLAUDE_SEARCH[1]; continue }
          if (effort && /effort/i.test(err.message)) { effort = false; continue }
        }
        throw err
      }
    }
  }
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: q.prompt }]
  let res: Anthropic.Message
  let inputTokens = 0
  let outputTokens = 0
  let searched = 0
  try {
    for (let pauses = 0; ; pauses++) {
      res = await sendWithFallbacks(messages)
      inputTokens += res.usage.input_tokens
      outputTokens += res.usage.output_tokens
      searched += res.usage.server_tool_use?.web_search_requests ?? 0
      if (res.stop_reason !== 'pause_turn') break
      if (pauses >= MAX_PAUSES) throw new AiError('busy', 'Claude took too long searching. Try again.')
      messages.push({ role: 'assistant', content: res.content })
    }
  } catch (err) { throw claudeError(err) }
  if (res.stop_reason === 'refusal') throw new AiError('refused', 'Claude declined this request. Try wording it differently.')
  // The answer is what it wrote after its last search, not what it said while searching.
  let from = 0
  for (let i = res.content.length - 1; i >= 0; i--) if (res.content[i].type === 'web_search_tool_result') { from = i + 1; break }
  const text = res.content.slice(from).map(b => (b.type === 'text' ? b.text : '')).join('')
  if (res.stop_reason === 'max_tokens' && !text.trim().endsWith('}')) throw new AiError('other', 'Claude’s answer was cut off. Try again.')
  return { text, inputTokens, outputTokens, searches: searched }
}

// ---- OpenAI (API key) and ChatGPT (sign-in) ----

const openai = (cred: Credential, fetch?: Fetch) => new OpenAI({
  apiKey: cred.secret,
  organization: null,
  project: null,
  fetch,
  // A ChatGPT plan's limit is final until it resets: don't retry into it.
  maxRetries: cred.provider === 'chatgpt' ? 0 : 2,
  timeout: 120_000,
})

const PLAN_LIMIT = 'Your ChatGPT plan’s allowance for nexttupp is used up for now. ChatGPT Settings → Usage shows when it resets.'

function openAiError (provider: AiProvider, err: unknown): AiError {
  if (err instanceof AiError) return err
  const who = NAMES[provider]
  if (err instanceof OpenAI.APIError) {
    const code = err.code ?? ''
    if (code === 'subscription_sharing_usage_limit_exceeded') return new AiError('limit', PLAN_LIMIT)
    if (code === 'subscription_sharing_usage_unavailable') return new AiError('busy', 'ChatGPT plan usage is unavailable right now. Try again in a few minutes.')
    if (code === 'insufficient_quota') return new AiError('credit', 'Your OpenAI account is out of credit. Add some at platform.openai.com, under Billing.')
    if (err.status === 401 || err.status === 403) {
      return provider === 'chatgpt'
        ? new AiError('auth', 'ChatGPT signed nexttupp out. Sign in with ChatGPT again in AI settings.')
        : new AiError('auth', 'OpenAI turned down the API key. Check it in AI settings, or make a new one at platform.openai.com.')
    }
    if (err.status === 404) return new AiError('model', `That model isn’t available to this ${who} account. Pick another in AI settings.`)
    if (err.status === 429) return new AiError('busy', `${who} is limiting requests right now. Try again in a minute.`)
    if (err.status !== undefined && err.status >= 500) return new AiError('busy', `${who} is busy or down right now. Try again in a minute.`)
    if (err instanceof OpenAI.APIConnectionError) return new AiError('network', `Couldn’t reach ${who}. Check the internet connection.`)
    return new AiError('other', `${who} refused the request: ${err.message}`)
  }
  return new AiError('other', (err as Error)?.message ?? `${who} request failed`)
}

async function openAiModelsOf (cred: Credential, fetch?: Fetch): Promise<AiModel[]> {
  try {
    const client = openai(cred, fetch)
    let list: OpenAiModelInfo[] = []
    if (cred.provider === 'chatgpt') {
      // A ChatGPT plan's list comes as { models: [...] }, not the API's paginated { data: [...] }.
      const body = await client.get<{ models?: OpenAiModelInfo[]; data?: OpenAiModelInfo[] }>('/models')
      list = body?.models ?? body?.data ?? []
    } else {
      for await (const m of client.models.list()) list.push(m as unknown as OpenAiModelInfo)
    }
    return openAiModels(list, cred.provider)
  } catch (err) { throw openAiError(cred.provider, err) }
}

type ResponseOut = { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } | null }

async function openAiAsk (cred: Credential, model: string, q: Ask, fetch?: Fetch): Promise<Answer> {
  const client = openai(cred, fetch)
  const run = async (opts: { reasoning: boolean; format: boolean; search: boolean }): Promise<Answer> => {
    // ChatGPT sign-in requires store:false and a streamed response; an API key is happy with the same request.
    const stream = await client.responses.create({
      model,
      instructions: opts.format ? q.system : q.system + JSON_IN_WORDS,
      input: [{ role: 'user', content: q.prompt }],
      ...(opts.format ? { text: { format: { type: 'json_schema' as const, name: 'titles', schema: q.schema, strict: true } } } : {}),
      ...(opts.reasoning ? { reasoning: { effort: q.effort } } : {}),
      ...(opts.search ? { tools: [{ type: 'web_search' as const }], max_tool_calls: q.search } : {}),
      store: false,
      stream: true,
    }, opts.search ? { timeout: SEARCH_TIMEOUT_MS } : undefined)
    let done: ResponseOut | null = null
    let deltas = ''
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta') deltas += ev.delta
      else if (ev.type === 'response.completed') done = ev.response as unknown as ResponseOut
      else if (ev.type === 'response.failed') {
        const e = ev.response.error
        if (e?.code === 'subscription_sharing_usage_limit_exceeded' as string) throw new AiError('limit', PLAN_LIMIT)
        throw new AiError('other', `${NAMES[cred.provider]} couldn’t answer: ${e?.message ?? 'request failed'}`)
      } else if (ev.type === 'response.incomplete') throw new AiError('other', `${NAMES[cred.provider]}’s answer was cut off. Try again.`)
      else if (ev.type === 'error') {
        if (ev.code === 'subscription_sharing_usage_limit_exceeded') throw new AiError('limit', PLAN_LIMIT)
        throw new AiError('other', `${NAMES[cred.provider]} couldn’t answer: ${ev.message}`)
      }
    }
    if (!done) throw new AiError('network', `${NAMES[cred.provider]} stopped before finishing. Try again.`)
    const text = (done.output ?? []).flatMap(o => (o.type === 'message' ? o.content ?? [] : [])).map(c => (c.type === 'output_text' ? c.text ?? '' : '')).join('') || deltas
    const searches = (done.output ?? []).filter(o => o.type === 'web_search_call').length
    return { text, inputTokens: done.usage?.input_tokens ?? 0, outputTokens: done.usage?.output_tokens ?? 0, searches }
  }
  let opts = { reasoning: true, format: true, search: (q.search ?? 0) > 0 }
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(opts)
    } catch (err) {
      // Not every model or plan takes a reasoning effort, a JSON schema or web search: drop what was refused and
      // ask again. Without search the answer is still useful, only not up to date.
      const param = err instanceof OpenAI.APIError ? err.param ?? '' : ''
      if (attempt < 3 && err instanceof OpenAI.BadRequestError && param.startsWith('reasoning') && opts.reasoning) { opts = { ...opts, reasoning: false }; continue }
      if (attempt < 3 && err instanceof OpenAI.BadRequestError && param.startsWith('text') && opts.format) { opts = { ...opts, format: false }; continue }
      if (attempt < 3 && err instanceof OpenAI.BadRequestError && /^(tools|max_tool_calls)/.test(param) && opts.search) { opts = { ...opts, search: false }; continue }
      throw openAiError(cred.provider, err)
    }
  }
}

/** The providers' APIs; `fetch` replaces the network (tests). */
export function makeProviders (opts: { fetch?: Fetch } = {}): ProviderApi {
  return {
    models: cred => (cred.provider === 'anthropic' ? claudeModelsOf(cred.secret, opts.fetch) : openAiModelsOf(cred, opts.fetch)),
    ask: (cred, model, q) => (cred.provider === 'anthropic' ? claudeAsk(cred.secret, model, q, opts.fetch) : openAiAsk(cred, model, q, opts.fetch)),
  }
}

export const providers: ProviderApi = makeProviders()
