// The TV app's remote (tv/, web/src/tv.ts). Android's WebView moves focus with the D-pad by itself, but it
// stops in text fields and pops the keyboard up. In the TV app this takes over instead:
//
// - Up and Down move to the nearest line of controls, to the one most in line with where focus is. Left and
//   Right stay in the row: the nearest control level with the focused one, or nowhere.
// - A shelf (a row of cards, a series' episodes) is one stop on the way up and down: focus lands on the card it
//   was last on there, else the first one in view, and the shelf lines up under the masthead with its heading,
//   the same place every time. Anything else is centred. A shelf's own links (See all, Why these?) are reached
//   with Right past its last card; Down or Left from them goes back into the shelf.
// - Reaching a line of buttons lands on its main one, or coming out of a shelf, its first; tabs, on the selected
//   one; the masthead from below, on the current tab. A grid keeps its column.
//   Left past the start of a row goes up to that tab, as on a TV's home screen.
// - Menus keep Up/Down for themselves; a text field keeps Left/Right while there's text to move through, and
//   a slider keeps Left/Right.
// - Back to a page puts focus back where it was there (the poster that was opened).
// - Focusing a text field doesn't open the keyboard; OK does.
// - Each move and each OK plays the TV's own navigation sound (through the app, so the TV's setting applies).
// - Back (from the app) is Escape first: it closes a menu, panel or dialog before going back a page.
// - In the player with nothing focused, the arrows are the player's (<html data-tv-keys="player">).

export type Dir = 'up' | 'down' | 'left' | 'right'
export interface Box { left: number; top: number; right: number; bottom: number }

/** How much further a box may be than the nearest one and still count as on the same line. */
const SAME_LINE = 24

const gap = (a: Box, b: Box, dir: Dir) =>
  dir === 'down' ? b.top - a.bottom : dir === 'up' ? a.top - b.bottom : dir === 'right' ? b.left - a.right : a.left - b.right

/** Distance between two ranges on the other axis; 0 when they overlap. */
const offset = (a: Box, b: Box, dir: Dir) => {
  const [a1, a2, b1, b2] = dir === 'up' || dir === 'down' ? [a.left, a.right, b.left, b.right] : [a.top, a.bottom, b.top, b.bottom]
  return Math.max(0, b1 - a2, a1 - b2)
}

/** The index of the box to move to from `from`, or null at the edge. */
export function pickNext (from: Box, boxes: Box[], dir: Dir): number | null {
  const sideways = dir === 'left' || dir === 'right'
  const ahead = boxes.map((b, i) => ({ i, gap: gap(from, b, dir), off: offset(from, b, dir) }))
    .filter(c => boxes[c.i] !== from && c.gap >= -1 && (!sideways || c.off === 0))
  if (!ahead.length) return null
  const nearest = Math.min(...ahead.map(c => c.gap))
  const line = ahead.filter(c => c.gap <= nearest + SAME_LINE)
  line.sort((a, b) => a.off - b.off || a.gap - b.gap)
  return line[0].i
}

/** A control's box on screen, and whether it's fixed there (the masthead) rather than scrolling with the page. */
export interface Spot { box: Box; fixed: boolean }

/**
 * `pickNext` on the page rather than the screen: something fixed on screen (the masthead) counts as being at
 * the top of the page, so Up goes back row by row (even to a row scrolled under the masthead) and reaches the
 * masthead only from the top. `scrollY` is how far the page is scrolled.
 */
export function pickOnPage (from: Spot, spots: Spot[], dir: Dir, scrollY: number): number | null {
  const onPage = (s: Spot): Box => (s.fixed ? s.box : { ...s.box, top: s.box.top + scrollY, bottom: s.box.bottom + scrollY })
  return pickNext(onPage(from), spots.map(onPage), dir)
}

// ---- The page ----------------------------------------------------------------------------------------

const DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
/** Shelves: rows of cards (components/Row.tsx) and a series' episodes. */
const SHELF = '.row-scroller, .episode-list'
/** A shelf's own links, above it. */
const SHELF_HEAD = '.row-head'
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const OPEN = '[role="dialog"], [role="menu"], [aria-modal="true"], dialog[open]'

type TextField = HTMLInputElement | HTMLTextAreaElement
const isText = (el: Element | null): el is TextField =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(el.type))

const visible = (el: HTMLElement) => {
  const check = (el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility
  return check ? check.call(el, { opacityProperty: true, visibilityProperty: true }) : getComputedStyle(el).visibility !== 'hidden'
}

const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }

/** Inside something `position: fixed` (the masthead): the end of its offsetParent chain is fixed. */
function isFixed (el: HTMLElement): boolean {
  let n: Element = el
  while (n instanceof HTMLElement && n.offsetParent) n = n.offsetParent
  return n !== document.body && n !== document.documentElement && getComputedStyle(n).position === 'fixed'
}

/**
 * The controls a press could reach: those (partly) inside `area`, measured once each. A TV is slow and a page
 * can hold a thousand controls, so whole parts of the page outside the area (rows below, cards scrolled off to
 * the side) are skipped without looking inside; a part with no size, like `display: contents`, is looked into.
 */
function within (root: Element, area: Box, skip: Element | null): Array<{ el: HTMLElement; box: Box }> {
  const out: Array<{ el: HTMLElement; box: Box }> = []
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement || child instanceof SVGElement)) continue
      if ((child as HTMLElement).inert || child.getAttribute('aria-hidden') === 'true') continue
      const focusable = child instanceof HTMLElement && child.matches(FOCUSABLE)
      if (!focusable && !child.firstElementChild) continue
      const r = child.getBoundingClientRect()
      if (r.height > 0 && (r.bottom < area.top || r.top > area.bottom)) continue
      if (r.width > 0 && (r.right < area.left || r.left > area.right)) continue
      if (focusable && child !== skip && r.width >= 2 && r.height >= 2 && visible(child as HTMLElement)) {
        out.push({ el: child as HTMLElement, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
      }
      if (child.firstElementChild) walk(child)
    }
  }
  walk(root)
  return out
}

/** The card focus was last on in each shelf. */
const shelfSpot = new WeakMap<Element, HTMLElement>()

const usable = (x: HTMLElement) => x.getClientRects().length > 0 && visible(x)

/** Where focus lands in a shelf: the card it was last on there, else the first one in view. */
function entry (shelf: Element): HTMLElement | null {
  const last = shelfSpot.get(shelf)
  if (last?.isConnected && shelf.contains(last) && usable(last)) return last
  const left = shelf.getBoundingClientRect().left
  let first: HTMLElement | null = null
  for (const x of shelf.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!usable(x)) continue
    first ??= x
    if (x.getBoundingClientRect().left >= left - 1) return x
  }
  return first
}

/** The shelf a head belongs to, and a shelf's head controls. */
const shelfUnder = (head: Element) => head.closest('section')?.querySelector(SHELF) ?? null
const headOf = (shelf: Element) =>
  [...(shelf.closest('section')?.querySelector(SHELF_HEAD)?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(usable)

/** The page's masthead: not one of a list page kept, hidden and inert, behind this one (main.tsx). */
const masthead = () => [...document.querySelectorAll('.masthead')].find(m => !m.closest('[inert]')) ?? null

/** The bottom of the masthead when it stays on screen, else 0. */
function barBottom (): number {
  const bar = masthead()
  if (!bar) return 0
  const pos = getComputedStyle(bar).position
  return pos === 'fixed' || pos === 'sticky' ? Math.max(0, bar.getBoundingClientRect().bottom) : 0
}

/**
 * Focuses and scrolls to it at once (a remote is pressed quickly, and the next press measures from here).
 * Sideways, just enough to show it. Up and down, a shelf lines up under the masthead with its heading, the
 * same place every time; anything else is centred.
 */
function reveal (el: HTMLElement, dir: Dir | null) {
  el.focus({ preventScroll: true })
  const shelf = el.closest(SHELF)
  const block = shelf ? (shelf.closest('section') ?? shelf) : null
  const bar = barBottom()
  const fits = block !== null && block.getBoundingClientRect().height <= innerHeight - bar - 8
  if (dir !== 'up' && dir !== 'down') {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    // Along a shelf that's partly off screen (the page was scrolled away from it): line it up again.
    const b = block?.getBoundingClientRect()
    if (!fits || !b || (b.top >= bar && b.bottom <= innerHeight)) return
  }
  if (block && fits) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    window.scrollBy({ top: block.getBoundingClientRect().top - bar - 8, behavior: 'instant' })
    return
  }
  // Near the top of the page (the billboard, a title's buttons): the page's top, with nothing cut off above.
  if (el.getBoundingClientRect().bottom + scrollY <= innerHeight - 40) { window.scrollTo({ top: 0, behavior: 'instant' }); return }
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
}

/** Where focus starts when nothing has it: the screen's main action, else the first control on screen under the bar. */
function start (list: HTMLElement[]): HTMLElement | undefined {
  const onScreen = list.filter(el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
  return onScreen.find(el => el.matches('.button.primary'))
    ?? onScreen.find(el => el.getBoundingClientRect().top > 80)
    ?? onScreen[0]
}

export type Sound = Dir | 'click'
interface TvApp {
  keyboard: () => void
  sound: (s: Sound) => void
  /** Tells the app a text field has focus without its keyboard, so OK on it opens the keyboard. */
  textField: (waiting: boolean) => void
  /** Stops the page's own scroll restore after Back (router.ts), once focus is back and scrolled to. */
  stopScrollRestore: () => void
}

/** Set while OK re-focuses a text field, so it keeps its keyboard. */
let opening = false

/** OK on a text field: give it its keyboard back and focus it again, as a tap would, so the TV shows the keyboard. */
function openKeyboard (el: TextField, app: TvApp) {
  el.inputMode = el.dataset.tvInputMode ?? ''
  opening = true
  try { el.blur(); el.focus({ preventScroll: true }) } finally { opening = false }
  app.textField(false)
  app.keyboard()
}

function onKey (e: KeyboardEvent, app: TvApp) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
  const el = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  if (e.key === 'Enter' && el && !e.repeat) app.sound('click')
  if (e.key === 'Enter' && isText(el) && el.inputMode === 'none') {
    e.preventDefault()
    openKeyboard(el, app)
    return
  }
  const dir = DIRS[e.key]
  if (!dir) return
  if (el) {
    if ((dir === 'up' || dir === 'down') && el.closest('[role="menu"], [role="listbox"], [role="radiogroup"]')) return
    if (isText(el) && ((dir === 'left' && (el.selectionStart ?? 0) > 0) || (dir === 'right' && (el.selectionEnd ?? 0) < el.value.length))) return
    if ((dir === 'left' || dir === 'right') && ((el instanceof HTMLInputElement && el.type === 'range') || el.getAttribute('role') === 'slider')) return
  } else if (document.documentElement.dataset.tvKeys === 'player') return

  const modal = document.querySelector<HTMLElement>('[aria-modal="true"], dialog[open]')
  const scope: Element = modal ?? el?.closest('[role="dialog"]') ?? document.body
  const screen: Box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  if (!el || !scope.contains(el)) {
    const first = start(within(scope, screen, null).map(c => c.el))
    if (first) { e.preventDefault(); reveal(first, null); app.sound(dir) }
    return
  }
  const to = next(el, dir, scope)
  // No controls above or below at all (a page of text): Up and Down scroll it.
  if (to === undefined) return
  // Nowhere to go stays put: left alone, the WebView's own arrow-key navigation would jump somewhere else.
  e.preventDefault()
  if (!to) return
  reveal(to, dir)
  app.sound(dir)
}

/** Where a press goes from `el`: a control, null to stay put, undefined to leave the key to the page. */
function next (el: HTMLElement, dir: Dir, scope: Element): HTMLElement | null | undefined {
  const vertical = dir === 'up' || dir === 'down'
  const shelf = el.closest(SHELF)
  const head = shelf ? null : el.closest(SHELF_HEAD)
  const below = head && shelfUnder(head)
  // From a shelf's links: Down goes into the shelf; so does Left, past the last link.
  if (below && dir === 'down') return entry(below)

  // Up and Down look a screen ahead, across what's on screen; Left and Right along the row, a screen ahead.
  const from = boxOf(el)
  const W = innerWidth
  const H = innerHeight
  const area: Box = dir === 'down' ? { left: 0, right: W, top: from.bottom - 1, bottom: from.bottom + H }
    : dir === 'up' ? { left: 0, right: W, top: from.top - H, bottom: from.top + 1 }
      : dir === 'right' ? { left: from.right - 1, right: from.right + W, top: from.top, bottom: from.bottom }
        : { left: from.left - W, right: from.left + 1, top: from.top, bottom: from.bottom }
  let list = within(scope, area, el)
  // Nothing that near (a long gap on the page): look further.
  if (!list.length && vertical) list = within(scope, { ...area, top: -Infinity, bottom: Infinity }, el)
  if (!list.length && vertical) return undefined
  // Shelves' own links aren't on the way up and down.
  if (vertical) { const rest = list.filter(c => !c.el.closest(SHELF_HEAD)); if (rest.length) list = rest }
  const fixed = isFixed(el)
  const i = pickOnPage({ box: from, fixed }, list.map(c => ({ box: c.box, fixed: isFixed(c.el) })), dir, scrollY)
  if (i === null) {
    if (below && dir === 'left') return entry(below)
    // Right past a shelf's last card: its links.
    if (shelf && dir === 'right') return headOf(shelf)[0] ?? null
    // Left past the start of a row: up to the menu.
    return dir === 'left' && scope === document.body && !fixed ? menuItem() : null
  }
  const to = list[i].el
  if (!vertical) return to
  // Into another shelf: its card, not just the nearest one.
  const into = to.closest(SHELF)
  if (into && into !== shelf) return entry(into) ?? to
  // Up into the masthead: the current tab.
  if (!fixed && isFixed(to) && to.closest('.masthead')) return menuItem() ?? to
  // Into tabs: the selected one.
  const tabs = to.closest('[role="tablist"]')
  if (tabs && !tabs.contains(el)) return tabs.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? to
  // Onto a line of buttons: its main one; else, out of a shelf (whose cards sit anywhere across), its first.
  // Elsewhere (a grid of posters) the column is kept.
  const top = list[i].box.top
  const line = list.filter(c => Math.abs(c.box.top - top) <= SAME_LINE)
  const main = line.find(c => c.el.matches('.button.primary'))
  if (main) return main.el
  return shelf ? line.reduce((a, b) => (b.box.left < a.box.left ? b : a)).el : to
}

/** The masthead's current section (Home, Films…), else its first control: where Left from a row's start goes. */
function menuItem (): HTMLElement | null {
  const bar = masthead()
  if (!bar) return null
  const items = [...bar.querySelectorAll<HTMLElement>('[aria-current="page"], ' + FOCUSABLE)].filter(x => x.getClientRects().length && visible(x))
  return items.find(x => x.getAttribute('aria-current') === 'page') ?? items[0] ?? null
}

/**
 * Back from the TV app: closes what's open (as Escape does). Returns true when something was, so the app knows
 * not to go back a page.
 */
export function back (): boolean {
  // A <dialog> closes only on a real Escape; ask it to, the way Escape would (its `cancel` handler runs).
  const dialogs = document.querySelectorAll<HTMLDialogElement & { requestClose?: () => void }>('dialog[open]')
  const top = dialogs[dialogs.length - 1]
  if (top) {
    if (top.requestClose) top.requestClose()
    else if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close()
    return true
  }
  const open = Boolean(document.querySelector(OPEN)) || document.documentElement.classList.contains('np-open')
  const target = document.activeElement ?? document.body
  const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(esc)
  return open || esc.defaultPrevented
}

// ---- Back to where you were ---------------------------------------------------------------------------

/**
 * A control, findable again on the same page once it's drawn anew: its link or label (else its kind and words,
 * like an episode or a source), and which one of those.
 */
interface Mark { sel: string; text: string | null; n: number }

const words = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)

function matches (mark: Mark): HTMLElement[] {
  const all = [...document.querySelectorAll<HTMLElement>(mark.sel)]
  return mark.text === null ? all : all.filter(x => words(x) === mark.text)
}

function markOf (el: Element): Mark | null {
  if (!(el instanceof HTMLElement)) return null
  const href = el.getAttribute('href')
  const label = el.getAttribute('aria-label')
  const kind = el.classList[0]
  const mark: Mark | null = href ? { sel: `a[href="${CSS.escape(href)}"]`, text: null, n: 0 }
    : label ? { sel: `[aria-label="${CSS.escape(label)}"]`, text: null, n: 0 }
      : kind && words(el) ? { sel: `${el.localName}.${CSS.escape(kind)}`, text: words(el), n: 0 }
        : null
  if (mark) mark.n = matches(mark).indexOf(el)
  return mark
}

/** Which page of the history this is (React Router keeps a key in each entry). */
const pageKey = () => (history.state as { key?: string } | null)?.key ?? location.pathname + location.search

/** Focuses the marked control when the page draws it (its rows may still be loading), unless a key comes first. */
function restore (mark: Mark, app: TvApp) {
  let done = false
  const finish = () => { done = true; watch.disconnect(); clearTimeout(timer); removeEventListener('keydown', finish, true) }
  const attempt = () => {
    if (done) return
    const el = matches(mark)[mark.n]
    if (!el || !usable(el)) return
    finish()
    // The page's own scroll restore (router.ts) would otherwise keep pulling the page back as it loads.
    app.stopScrollRestore()
    reveal(el, 'down')
  }
  const watch = new MutationObserver(attempt)
  const timer = setTimeout(finish, 4000)
  addEventListener('keydown', finish, true)
  // A kept list page (main.tsx) comes back by losing its class and `inert`, not by being drawn again.
  requestAnimationFrame(() => {
    if (done) return
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'inert', 'hidden'] })
    attempt()
  })
}

/** Turns the remote handling on (only inside the TV app), with the app's keyboard and sounds. */
export function installTvNavigation (app: TvApp): void {
  document.documentElement.classList.add('tv')
  window.addEventListener('keydown', e => onKey(e, app), true)
  const marks = new Map<string, Mark>()
  document.addEventListener('focusin', e => {
    const t = e.target as HTMLElement
    const shelf = t.closest?.(SHELF)
    if (shelf) shelfSpot.set(shelf, t)
    const m = markOf(t)
    if (m) marks.set(pageKey(), m)
  })
  addEventListener('popstate', () => { const m = marks.get(pageKey()); if (m) restore(m, app) })
  document.addEventListener('focusin', e => {
    const t = e.target as Element
    if (!isText(t) || opening) return
    t.dataset.tvInputMode ??= t.getAttribute('inputmode') ?? ''
    t.inputMode = 'none'
    app.textField(true)
  })
  document.addEventListener('focusout', e => { if (isText(e.target as Element) && !opening) app.textField(false) })
  const w = window as { __nexttuppTvBack?: () => boolean; __nexttuppTvOpenKeyboard?: () => boolean }
  w.__nexttuppTvBack = back
  // The app takes OK on a text field before the TV's keyboard can swallow it (tv/ MainActivity), and calls this.
  w.__nexttuppTvOpenKeyboard = () => {
    const el = document.activeElement
    if (!isText(el)) return false
    openKeyboard(el, app)
    return true
  }
}
