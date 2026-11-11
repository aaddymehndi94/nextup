import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import type { AiModel, AiProvider, AiStatus } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useDocumentTitle } from '../hooks.ts'
import { usePrivate } from '../private.ts'
import { toast } from '../toast.ts'
import { TopBar } from '../components/TopBar.tsx'

// AI settings: connect a provider, choose the model, cap the requests. Nothing here asks a model; picks and
// Ask AI do, and only when pressed (server/ai).

type Load = { state: 'loading' } | { state: 'ok'; status: AiStatus } | { state: 'error'; message: string }

const PROVIDER_NAME: Record<AiProvider, string> = { chatgpt: 'ChatGPT', anthropic: 'Claude', openai: 'OpenAI' }
const LIMITS: Array<[number, string]> = [[10, '10 a day'], [20, '20 a day'], [50, '50 a day'], [100, '100 a day'], [200, '200 a day'], [0, 'No limit']]

const tokens = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`)
const perMillion = (m: AiModel) => (m.price ? `$${m.price.input} in / $${m.price.output} out per million tokens` : m.provider === 'chatgpt' ? 'your ChatGPT plan' : '')

export function Ai () {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const priv = usePrivate()
  useDocumentTitle('AI settings')

  const refresh = useCallback(() => api.ai().then(status => { setLoad({ state: 'ok', status }); return status }), [])
  useEffect(() => { refresh().catch(err => setLoad({ state: 'error', message: (err as Error).message })) }, [refresh])

  // While a ChatGPT sign-in is open in the browser, look for it finishing.
  const signingIn = load.state === 'ok' && load.status.signingIn
  useEffect(() => {
    if (!signingIn) return
    const had = load.state === 'ok' && load.status.connections.some(c => c.provider === 'chatgpt')
    const t = setInterval(() => {
      refresh().then(s => {
        if (!had && s.connections.some(c => c.provider === 'chatgpt')) toast('ChatGPT connected. AI picks and Ask AI will use your plan.')
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(t)
  }, [signingIn, refresh])

  const set = (status: AiStatus) => setLoad({ state: 'ok', status })

  return (
    <main className="account-page ai-page">
      <TopBar solid />
      <div className="account-body">
        <header className="account-head">
          <h1 className="account-title">AI settings</h1>
          <p className="account-lede">
            Optional. Connect ChatGPT, Claude or OpenAI and nexttupp can suggest picks from your taste, and answer searches like
            “a cosy 90s sitcom” or “something like Severance but funnier”.
          </p>
          <p className="account-note">
            A model is asked only when you press Get AI picks, Refresh or Ask AI. Answers are saved, so looking at them again
            costs nothing. Every title it names is checked against the catalogue first.
          </p>
        </header>
        {priv && <p className="account-notice" role="status">Private mode is on, so AI is off: it would send what you search for to the AI provider.</p>}
        {load.state === 'loading' && <div aria-busy="true"><div className="skeleton-line" style={{ width: '50%', height: '1.25rem' }} /></div>}
        {load.state === 'error' && <p className="notice" role="alert">{load.message}</p>}
        {load.state === 'ok' && (
          <>
            <Connect status={load.status} onStatus={set} />
            {load.status.connections.length > 0 && <ModelAndLimits status={load.status} onStatus={set} />}
            <Privacy />
          </>
        )}
      </div>
    </main>
  )
}

function Connect ({ status, onStatus }: { status: AiStatus; onStatus: (s: AiStatus) => void }) {
  const conn = (p: AiProvider) => status.connections.find(c => c.provider === p)
  const local = status.local

  const disconnect = async (p: AiProvider) => {
    try {
      const s = await api.aiDisconnect(p)
      onStatus(s)
      toast(p === 'chatgpt' && s.revoked === false
        ? 'Disconnected here. ChatGPT didn’t confirm, so you can also remove nexttupp in ChatGPT Settings → Connected apps.'
        : `${PROVIDER_NAME[p]} disconnected. Its key or sign-in is deleted from this computer.`)
    } catch (err) { toast(`Couldn’t disconnect. ${(err as Error).message}`) }
  }

  return (
    <section className="account-section" aria-labelledby="ai-connect-h">
      <h2 id="ai-connect-h" className="section-title">Connect</h2>
      {!local && <p className="account-note">Connect and change AI settings on the computer that runs nexttupp. This device can use what’s connected there.</p>}
      <ChatgptCard conn={conn('chatgpt')} local={local} signingIn={status.signingIn} onStatus={onStatus} onDisconnect={() => disconnect('chatgpt')} />
      <KeyCard provider="anthropic" conn={conn('anthropic')} local={local} onStatus={onStatus} onDisconnect={() => disconnect('anthropic')}
        what="Pay as you go with an API key. Claude subscriptions (Pro, Max) can’t be used by other apps."
        steps={<>Sign in at <Link href="https://platform.claude.com/settings/keys">platform.claude.com</Link>, add a little credit under Billing ($5 lasts a long time), then create a key and paste it here.</>}
        placeholder="sk-ant-…" />
      <KeyCard provider="openai" conn={conn('openai')} local={local} onStatus={onStatus} onDisconnect={() => disconnect('openai')}
        what="Pay as you go with an API key, separate from a ChatGPT subscription."
        steps={<>Sign in at <Link href="https://platform.openai.com/api-keys">platform.openai.com</Link>, add a little credit under Billing, then create a key and paste it here.</>}
        placeholder="sk-…" />
    </section>
  )
}

function Link ({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-link">{children}<ExternalLink aria-hidden className="inline-icon" /></a>
}

function Connected ({ label, problem, onDisconnect, local }: { label: string; problem?: string; onDisconnect: () => void; local: boolean }) {
  return (
    <>
      <div className="ai-connected">
        <span><span className="ai-dot" aria-hidden />Connected · {label}</span>
        {local && <button type="button" className="text-button" onClick={onDisconnect}><X aria-hidden />Disconnect</button>}
      </div>
      {problem && <p className="form-error" role="alert">{problem}</p>}
    </>
  )
}

function ChatgptCard ({ conn, local, signingIn, onStatus, onDisconnect }: {
  conn?: AiStatus['connections'][number]; local: boolean; signingIn: boolean; onStatus: (s: AiStatus) => void; onDisconnect: () => void
}) {
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    try {
      const { url } = await api.aiChatgpt()
      window.open(url, '_blank', 'noopener')
      onStatus(await api.ai())
    } catch (err) { toast(`Couldn’t start sign-in. ${(err as Error).message}`) }
    setBusy(false)
  }
  return (
    <div className="ai-card">
      <div className="ai-card-head">
        <h3 className="ai-card-title">ChatGPT</h3>
        <span className="ai-tag">Easiest</span>
      </div>
      <p className="account-note">Sign in and nexttupp uses your ChatGPT Plus or Pro plan. No key, no separate bill. You can set a weekly cap for nexttupp in ChatGPT’s settings.</p>
      {conn
        ? <Connected label={conn.label} problem={conn.problem} onDisconnect={onDisconnect} local={local} />
        : local && (
          <div className="actions">
            <button type="button" className="button primary" onClick={() => { void start() }} disabled={busy}>
              {busy && <span className="spinner" aria-hidden />}
              {signingIn ? 'Open sign-in again' : 'Sign in with ChatGPT'}
            </button>
            {signingIn && <span className="account-note" role="status">Finish signing in in your browser, then come back here.</span>}
          </div>
          )}
    </div>
  )
}

function KeyCard ({ provider, conn, local, what, steps, placeholder, onStatus, onDisconnect }: {
  provider: 'anthropic' | 'openai'; conn?: AiStatus['connections'][number]; local: boolean; what: string; steps: React.ReactNode; placeholder: string
  onStatus: (s: AiStatus) => void; onDisconnect: () => void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onStatus(await api.aiKey(provider, key.trim()))
      setKey('')
      toast(`${PROVIDER_NAME[provider]} connected.`)
    } catch (err) { setError((err as Error).message) }
    setBusy(false)
  }
  return (
    <div className="ai-card">
      <div className="ai-card-head"><h3 className="ai-card-title">{PROVIDER_NAME[provider]} API key</h3></div>
      <p className="account-note">{what}</p>
      {conn
        ? <Connected label={conn.label} problem={conn.problem} onDisconnect={onDisconnect} local={local} />
        : local && (
          <form className="ai-key-form" onSubmit={submit} aria-label={`Connect ${PROVIDER_NAME[provider]}`}>
            <p className="account-note">{steps}</p>
            <div className="ai-key-row">
              <label className="field">
                <span className="sr-only">{PROVIDER_NAME[provider]} API key</span>
                <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
              </label>
              <button type="submit" className="button secondary" disabled={!key.trim() || busy}>
                {busy && <span className="spinner" aria-hidden />}
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </form>
          )}
    </div>
  )
}

function ModelAndLimits ({ status, onStatus }: { status: AiStatus; onStatus: (s: AiStatus) => void }) {
  const save = async (body: { choice?: string | null; dailyLimit?: number }) => {
    try { onStatus(await api.aiSettings(body)) } catch (err) { toast(`Couldn’t save that. ${(err as Error).message}`) }
  }
  const auto = status.active?.auto ? status.active.model : null
  const firstAuto = auto ?? status.models[0]
  const providers = [...new Set(status.models.map(m => m.provider))]
  const m = status.usage.month
  const cost = m.costUsd === null ? '' : m.costUsd < 0.01 ? ', under 1¢' : `, about $${m.costUsd.toFixed(2)}`
  return (
    <section className="account-section" aria-labelledby="ai-model-h">
      <h2 id="ai-model-h" className="section-title">Model</h2>
      <label className="field">
        <span className="field-label">Which model to ask</span>
        <select className="ai-select" value={status.choice ?? ''} disabled={!status.local} onChange={e => { void save({ choice: e.target.value || null }) }}>
          <option value="">Automatic: the cheapest, newest{firstAuto ? ` (now ${firstAuto.name})` : ''}</option>
          {providers.map(p => (
            <optgroup key={p} label={PROVIDER_NAME[p]}>
              {status.models.filter(x => x.provider === p).map(x => <option key={x.id} value={x.id}>{x.name}{x.price ? ` · ${perMillion(x)}` : ''}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {status.active && status.estimate && (
        <p className="account-note">
          Using {status.active.model.name}. AI picks: {status.estimate.picks}. Ask AI: {status.estimate.search}.
          {' '}Automatic follows new models as they come out; bigger models know more but cost more.
        </p>
      )}
      {!status.active && <p className="account-note">Loading the list of models…</p>}
      <label className="field">
        <span className="field-label">Most AI requests, for all profiles</span>
        <select className="ai-select" value={status.dailyLimit} disabled={!status.local} onChange={e => { void save({ dailyLimit: Number(e.target.value) }) }}>
          {LIMITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <p className="account-note">Today: {status.usage.today} request{status.usage.today === 1 ? '' : 's'}. This month: {m.requests} request{m.requests === 1 ? '' : 's'}{m.requests ? `, ${tokens(m.inputTokens + m.outputTokens)} tokens${cost}` : ''}.</p>
    </section>
  )
}

function Privacy () {
  return (
    <section className="account-section" aria-labelledby="ai-privacy-h">
      <h2 id="ai-privacy-h" className="section-title">What is sent</h2>
      <p className="account-note">
        When you ask: the names of titles you’ve liked, disliked, finished or stopped, your “more of” and “never” choices, and
        what you type into Ask AI. Not your name, email or anything else. It goes from this computer straight to the provider you
        connected, under their privacy terms.
      </p>
      <p className="fine-print">
        Keys and sign-ins stay in a file on this computer that only your user can read. They’re never synced, never shown to
        phones or TVs, and Disconnect deletes them. Private mode never uses AI.
      </p>
    </section>
  )
}
