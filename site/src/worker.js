// nexttupp.com: static assets, plus the two things assets can't do on their own.
//  1. www.nexttupp.com redirects to the apex (a host-based rule, which _redirects can't express).
//  2. Security and cache headers on every response.
// Unknown paths get 404.html with a 404 status from the assets binding (not_found_handling).

const APEX = 'nexttupp.com'

// connect-src: the /watch page signs in and lists the account's computers through the nexttupp API. A local
// preview can allow a local API as well with `wrangler dev --var DEV_CONNECT_SRC:http://127.0.0.1:8799`; the
// var isn't set in wrangler.jsonc, so a deploy never has it.
const API = 'https://api.nexttupp.com'
const csp = connect => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; connect-src ${connect}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
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

    const res = await env.ASSETS.fetch(request)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v)
    const dev = typeof env.DEV_CONNECT_SRC === 'string' && /^(http:\/\/(localhost|127\.0\.0\.1):\d{2,5} ?)+$/.test(env.DEV_CONNECT_SRC) ? env.DEV_CONNECT_SRC : ''
    out.headers.set('content-security-policy', dev ? csp(`${API} ${dev}`) : CSP)
    // Fonts and images change rarely; pages, CSS and JS revalidate so a deploy shows up at once.
    if (res.ok && /^\/(fonts|img)\//.test(url.pathname)) out.headers.set('cache-control', 'public, max-age=604800')
    return out
  },
}
