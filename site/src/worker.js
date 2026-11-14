// nexttupp.com: static assets, plus the things assets can't do on their own.
//  1. www.nexttupp.com redirects to the apex (a host-based rule, which _redirects can't express).
//  2. /invite, from when sign-up needed an invite, redirects to /join.
//  3. The addresses people guess, like /login and /signup, redirect to /account (/account#create for sign-up).
//  4. Security and cache headers on every response (worker-src: /watch's offline copy, watch-sw.js).
// Unknown paths get 404.html with a 404 status from the assets binding (not_found_handling).

const APEX = 'nexttupp.com'

// connect-src: /account and /watch sign in, create accounts and list the account’s computers through the nexttupp API. A local
// preview can allow a local API as well with `wrangler dev --var DEV_CONNECT_SRC:http://127.0.0.1:8799`; the
// var isn't set in wrangler.jsonc, so a deploy never has it.
const API = 'https://api.nexttupp.com'

const SHORTCUTS = {
  '/signin': '/account', '/sign-in': '/account', '/login': '/account', '/log-in': '/account',
  '/signup': '/account#create', '/sign-up': '/account#create', '/register': '/account#create', '/create-account': '/account#create',
}
const csp = connect => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src ${connect}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
const CSP = csp(API)

const SECURITY = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'strict-transport-security': 'max-age=31536000',
}

export default {
  async fetch (request, env) {
    const url = new URL(request.url)
    const host = (request.headers.get('host') || url.hostname).toLowerCase()

    if (host === 'www.' + APEX || host.startsWith('www.' + APEX + ':')) {
      return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301)
    }
    if (url.pathname === '/invite' || url.pathname === '/invite.html') return Response.redirect(`${url.origin}/join`, 301)
    const shortcut = SHORTCUTS[url.pathname.toLowerCase().replace(/\/$/, '')]
    if (shortcut) return Response.redirect(`${url.origin}${shortcut}`, 302)

    const res = await env.ASSETS.fetch(request)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v)
    const dev = typeof env.DEV_CONNECT_SRC === 'string' && /^(http:\/\/(localhost|127\.0\.0\.1):\d{2,5} ?)+$/.test(env.DEV_CONNECT_SRC) ? env.DEV_CONNECT_SRC : ''
    out.headers.set('content-security-policy', dev ? csp(`${API} ${dev}`) : CSP)
    // Fonts and images change rarely; pages, CSS and JS revalidate so a deploy shows up at once.
    if (res.ok && /^\/(fonts|img)\//.test(url.pathname)) out.headers.set('cache-control', 'public, max-age=604800')
    // The phone app's service worker: always checked for a new version. A worker's own fetches follow the CSP
    // sent with its script, so it gets one that lets it fetch this site's files (to keep /watch for offline).
    if (url.pathname === '/watch-sw.js') {
      out.headers.set('cache-control', 'no-cache')
      out.headers.set('content-security-policy', "default-src 'none'; connect-src 'self'")
    }
    return out
  },
}
