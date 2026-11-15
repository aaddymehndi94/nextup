import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { useDocumentTitle } from '../hooks.ts'

// Where the browser lands after "Continue with Google" (the cloud sends it to 127.0.0.1:<port>/auth/google): it
// hands the one-time ticket to this computer's nexttupp, which signs in. The app's own window notices by
// itself, so this tab only says how it went. Shown in the computer's browser, outside the app's pages.

const WHY: Record<string, [string, string]> = {
  cancelled: ['Sign-in cancelled.', 'Nothing changed. To try again, go back to nexttupp and choose Continue with Google.'],
  expired: ['That sign-in took too long.', 'Go back to nexttupp and choose Continue with Google again.'],
  unverified_email: ['Google hasn’t confirmed that email.', 'Pick a Google account whose email is confirmed, or confirm it with Google first, then try again in nexttupp.'],
  account_disabled: ['This account has been disabled.', 'It can’t be used to sign in.'],
  too_many_attempts: ['Too many new accounts from this network.', 'Try again in an hour.'],
}
const FAILED: [string, string] = ['Google didn’t sign you in.', 'Go back to nexttupp and try again.']

type Outcome = { state: 'working' } | { state: 'done'; email: string } | { state: 'failed'; title: string; detail: string }

let started: Promise<Outcome> | null = null
function finish (): Promise<Outcome> {
  if (started) return started
  const hash = new URLSearchParams(location.hash.slice(1))
  history.replaceState(null, '', location.pathname) // the ticket leaves the address bar (and the history) at once
  const ticket = hash.get('ticket')
  const error = hash.get('error')
  started = ticket
    ? api.finishGoogle(ticket).then(
      s => ({ state: 'done', email: s.account?.email ?? '' }),
      err => ({ state: 'failed', title: 'That didn’t work.', detail: (err as Error).message }),
    )
    : Promise.resolve({ state: 'failed', title: (WHY[error ?? ''] ?? FAILED)[0], detail: (WHY[error ?? ''] ?? FAILED)[1] })
  return started
}

export function AuthGoogle () {
  useDocumentTitle('Signing in')
  const [outcome, setOutcome] = useState<Outcome>({ state: 'working' })
  useEffect(() => { void finish().then(setOutcome) }, [])

  return (
    <main className="auth-done" aria-live="polite">
      <p className="wordmark">nexttupp</p>
      {outcome.state === 'working' && <h1 className="auth-done-title"><span className="spinner" aria-hidden />Signing you in…</h1>}
      {outcome.state === 'done' && (
        <>
          <h1 className="auth-done-title">You’re signed in.</h1>
          <p className="auth-done-text">nexttupp on this computer is signed in as <strong>{outcome.email}</strong>. Go back to the app; you can close this tab.</p>
        </>
      )}
      {outcome.state === 'failed' && (
        <>
          <h1 className="auth-done-title">{outcome.title}</h1>
          <p className="auth-done-text">{outcome.detail}</p>
        </>
      )}
    </main>
  )
}
