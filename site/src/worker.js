// nexttupp.com: static assets, plus the two things assets can't do on their own.
//  1. www.nexttupp.com redirects to the apex (a host-based rule, which _redirects can't express).
//  2. Security and cache headers on every response.
// Unknown paths get 404.html with a 404 status from the assets binding (not_found_handling).

const APEX = 'nexttupp.com'

const SECURITY = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
    // Fonts and images change rarely; pages, CSS and JS revalidate so a deploy shows up at once.
    if (res.ok && /^\/(fonts|img)\//.test(url.pathname)) out.headers.set('cache-control', 'public, max-age=604800')
    return out
  },
}
