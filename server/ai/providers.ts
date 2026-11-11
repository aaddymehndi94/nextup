import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { AiModel, AiProvider } from '../../shared/types.ts'
import { claudeModels, type ClaudeModelInfo, openAiModels, type OpenAiModelInfo } from './models.ts'

// One way to ask any connected provider for JSON: Claude through the Anthropic SDK, GPT through the OpenAI SDK
// (an API key, or a ChatGPT sign-in's access token, which the Responses API takes the same way).

export interface Ask {
  system: string
  prompt: string
  schema: Record<string, unknown>
  /** Thinking/reasoning depth: low for search (quick), medium for picks. */
  effort: 'low' | 'medium'
  /** Claude only; ChatGPT sign-in rejects an output cap. */
  maxTokens: number
}

export interface Answer { text: string; inputTokens: number; outputTokens: number }

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

// ---- Claude ----

const claude = (key: string) => new Anthropic({ apiKey: key, authToken: null, maxRetries: 2, timeout: 120_000 })

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

async function claudeModelsOf (key: string): Promise<AiModel[]> {
  try {
    const list: ClaudeModelInfo[] = []
    for await (const m of claude(key).models.list()) list.push(m as unknown as ClaudeModelInfo)
    return claudeModels(list)
  } catch (err) { throw claudeError(err) }
}

async function claudeAsk (key: string, model: string, q: Ask): Promise<Answer> {
  const client = claude(key)
  const send = (effort: boolean) => client.messages.create({
    model,
    max_tokens: q.maxTokens,
    system: q.system,
    messages: [{ role: 'user', content: q.prompt }],
    output_config: { format: { type: 'json_schema', schema: q.schema }, ...(effort ? { effort: q.effort } : {}) },
  })
  let res: Anthropic.Message
  try {
    // Older models (Claude Haiku 4.5) take no effort setting: ask again without it.
    res = await send(true).catch(err => {
      if (err instanceof Anthropic.BadRequestError && /effort/i.test(err.message)) return send(false)
      throw err
    })
  } catch (err) { throw claudeError(err) }
  if (res.stop_reason === 'refusal') throw new AiError('refused', 'Claude declined this request. Try wording it differently.')
  const text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('')
  if (res.stop_reason === 'max_tokens' && !text.trim().endsWith('}')) throw new AiError('other', 'Claude’s answer was cut off. Try again.')
  return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
}

// ---- OpenAI (API key) and ChatGPT (sign-in) ----

const openai = (cred: Credential) => new OpenAI({
  apiKey: cred.secret,
  organization: null,
  project: null,
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

async function openAiModelsOf (cred: Credential): Promise<AiModel[]> {
  try {
    const list: OpenAiModelInfo[] = []
    for await (const m of openai(cred).models.list()) list.push(m as unknown as OpenAiModelInfo)
    return openAiModels(list, cred.provider)
  } catch (err) { throw openAiError(cred.provider, err) }
}

type ResponseOut = { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } | null }

async function openAiAsk (cred: Credential, model: string, q: Ask): Promise<Answer> {
  const client = openai(cred)
  const run = async (opts: { reasoning: boolean; format: boolean }): Promise<Answer> => {
    // ChatGPT sign-in requires store:false and a streamed response; an API key is happy with the same request.
    const stream = await client.responses.create({
      model,
      instructions: opts.format ? q.system : `${q.system}\n\nAnswer with JSON only, in this shape: {"titles":[{"title":"","year":0,"type":"movie","imdbId":"","because":"","why":""}]}`,
      input: [{ role: 'user', content: q.prompt }],
      ...(opts.format ? { text: { format: { type: 'json_schema' as const, name: 'titles', schema: q.schema, strict: true } } } : {}),
      ...(opts.reasoning ? { reasoning: { effort: q.effort } } : {}),
      store: false,
      stream: true,
    })
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
    return { text, inputTokens: done.usage?.input_tokens ?? 0, outputTokens: done.usage?.output_tokens ?? 0 }
  }
  let opts = { reasoning: true, format: true }
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(opts)
    } catch (err) {
      // Not every model takes a reasoning effort or a JSON schema: drop what was refused and ask once more.
      const param = err instanceof OpenAI.APIError ? err.param ?? '' : ''
      if (attempt < 2 && err instanceof OpenAI.BadRequestError && param.startsWith('reasoning') && opts.reasoning) { opts = { ...opts, reasoning: false }; continue }
      if (attempt < 2 && err instanceof OpenAI.BadRequestError && param.startsWith('text') && opts.format) { opts = { ...opts, format: false }; continue }
      throw openAiError(cred.provider, err)
    }
  }
}

export const providers: ProviderApi = {
  models: cred => (cred.provider === 'anthropic' ? claudeModelsOf(cred.secret) : openAiModelsOf(cred)),
  ask: (cred, model, q) => (cred.provider === 'anthropic' ? claudeAsk(cred.secret, model, q) : openAiAsk(cred, model, q)),
}
