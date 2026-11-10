// /join?code=<invite code> (or /join#<invite code>): shows the code, ready to copy into the app.
// The code is only ever put on the page as text; it is never sent anywhere.

const CODE = /^[A-Za-z0-9_-]{8,128}$/

function readCode () {
  const fromQuery = new URLSearchParams(location.search).get('code')
  if (fromQuery) return fromQuery.trim()
  const hash = decodeURIComponent(location.hash.slice(1)).trim()
  if (!hash) return ''
  return hash.startsWith('code=') ? hash.slice(5) : hash
}

const code = readCode()
const invited = document.querySelector('[data-invited]')
const uninvited = document.querySelector('[data-uninvited]')

if (code && CODE.test(code)) {
  document.title = 'You’re invited to nexttupp'
  invited.hidden = false
  uninvited.hidden = true
  document.querySelector('[data-code]').textContent = code

  const button = document.querySelector('[data-copy]')
  const label = document.querySelector('[data-copy-label]')
  const status = document.querySelector('[data-copy-status]')
  let timer
  button.addEventListener('click', async () => {
    let ok = false
    try { await navigator.clipboard.writeText(code); ok = true } catch {
      // Older browsers, or no clipboard permission: select the code so it can be copied by hand.
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('[data-code]'))
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
      try { ok = document.execCommand('copy') } catch { ok = false }
    }
    label.textContent = ok ? 'Copied' : 'Copy code'
    status.textContent = ok ? 'Copied. Paste it in step 3.' : 'Couldn’t copy automatically. The code is selected: press Ctrl+C (⌘C on a Mac).'
    clearTimeout(timer)
    timer = setTimeout(() => { label.textContent = 'Copy code' }, 2400)
  })
} else if (code) {
  // Something was there but it isn't a code: most likely a link cut short while being shared.
  document.querySelector('[data-uninvited-lede]').textContent =
    'This invite link looks incomplete, so there’s no code to show. Ask the person who sent it to copy the whole link, or to send you a new invite.'
}
