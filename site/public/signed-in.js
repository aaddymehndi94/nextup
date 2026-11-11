// Marks the page as signed in (html.signed-in) when this browser has a nexttupp session from /watch or
// /invite, so CSS can show "Invite friends" in place of "Download" from the first frame. A plain, blocking
// script on purpose: it runs before the page paints. It only reads localStorage; nothing is sent.
try {
  const s = JSON.parse(localStorage.getItem('nexttupp:cloud') || 'null')
  if (s && typeof s.token === 'string' && s.expiresAt > Date.now()) document.documentElement.classList.add('signed-in')
} catch { /* storage unavailable: signed out */ }
