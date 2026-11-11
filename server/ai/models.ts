import type { AiModel, AiProvider } from '../../shared/types.ts'

// Which models to offer and which one "Automatic" means: the cheapest line of the newest generation, so a
// new small model is picked up as soon as the provider lists it. Prices are only for the cost estimates shown
// in the app (USD per million tokens, standard tier, from the providers' price pages, November 2026).

const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-fable-5-2': { input: 8, output: 40 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6.1-terra': { input: 1, output: 5 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-mini': { input: 0.25, output: 2 },
}

export const priceOf = (id: string): { input: number; output: number } | undefined => PRICES[id]

/** Cost in USD of a request, when the model's price is known. */
export function costOf (id: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[id]
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1e6 : null
}

// ---- Claude ----

const CLAUDE_LINES = ['haiku', 'sonnet', 'opus', 'fable'] as const

/** The fields of the Models API's entries that matter here. */
export interface ClaudeModelInfo {
  id: string
  display_name: string
  created_at: string
  line?: string | null
  lifecycle?: string
  capabilities?: { structured_outputs?: { supported?: boolean } } | null
}

/** Active Claude models that can answer in a JSON schema, cheapest line first, newest first within a line. */
export function claudeModels (list: ClaudeModelInfo[]): AiModel[] {
  return list
    .filter(m => (m.lifecycle ?? 'active') === 'active' && m.capabilities?.structured_outputs?.supported !== false)
    .map(m => ({ m, tier: CLAUDE_LINES.indexOf(m.line as typeof CLAUDE_LINES[number]) }))
    .filter(x => x.tier >= 0) // Mythos needs a verified organisation; models outside a line are odd ones out
    .map(({ m, tier }) => ({ id: m.id, provider: 'anthropic' as const, name: m.display_name, tier, createdAt: Date.parse(m.created_at) || 0, price: PRICES[m.id] }))
    .sort((a, b) => a.tier - b.tier || b.createdAt - a.createdAt)
}

// ---- OpenAI ----

// gpt-6 names its lines luna < terra < sol < astra; gpt-5 used nano < mini < (none) < pro.
const OPENAI_TIER: Record<string, number> = { nano: 0, luna: 0, mini: 1, terra: 1, '': 2, sol: 2, astra: 3 }
const OPENAI_ID = /^gpt-(\d+)(?:\.(\d+))?(?:-(nano|mini|luna|terra|sol|astra))?$/

/** The fields of the Models API's entries that matter (an API key lists `id`; ChatGPT sign-in lists `slug`). */
export interface OpenAiModelInfo { id?: string; slug?: string; display_name?: string; visibility?: string; supported_in_api?: boolean; created?: number }

const titleCase = (s: string) => s.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => `${d ? ' ' : ''}${c.toUpperCase()}`)

/** GPT text models (no snapshots, pro, audio, image or codex variants), cheapest line of the newest generation first. */
export function openAiModels (list: OpenAiModelInfo[], provider: AiProvider): AiModel[] {
  const out: Array<AiModel & { gen: number }> = []
  for (const m of list) {
    const id = m.slug ?? m.id
    if (!id || (m.visibility && m.visibility !== 'list') || m.supported_in_api === false) continue
    const p = OPENAI_ID.exec(id)
    if (!p) continue
    const gen = Number(p[1]) * 100 + Number(p[2] ?? 0)
    const tier = OPENAI_TIER[p[3] ?? '']
    out.push({ id, provider, name: m.display_name ?? titleCase(id.replace(/^gpt/, 'GPT')), tier, gen, createdAt: (m.created ?? 0) * 1000, price: provider === 'chatgpt' ? undefined : PRICES[id] })
  }
  const major = (gen: number) => Math.floor(gen / 100)
  const newest = Math.max(0, ...out.map(m => major(m.gen)))
  return out
    // The newest generation's lines first (cheapest first, newest version within a line), then older generations.
    .sort((a, b) => Number(major(b.gen) === newest) - Number(major(a.gen) === newest) || a.tier - b.tier || b.gen - a.gen)
    .map(({ gen: _g, ...m }) => m)
}

/** "Automatic": the first of a provider's list as sorted above. */
export const automatic = (models: AiModel[]): AiModel | undefined => models[0]
