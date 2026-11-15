import { useSyncExternalStore } from 'react'
import { getActiveProfile } from './api.ts'
import { readableAccent } from './colour.ts'

// How nexttupp looks, per profile on this device: a preset, or your own action colour, background, text size,
// poster corners, motion and title-page tint. The action colour can also be any colour you pick (colour.ts). Applied as CSS variables on <html> (styles.css :root has the
// defaults), so every screen follows at once. The look stays dark: the artwork carries the colour.

export const ACCENTS = [
  { id: 'white', label: 'White', color: '#ffffff' },
  { id: 'sun', label: 'Sun', color: '#ffd166' },
  { id: 'peach', label: 'Peach', color: '#ffb48a' },
  { id: 'mint', label: 'Mint', color: '#7ee2b8' },
  { id: 'sky', label: 'Sky', color: '#8ecbff' },
  { id: 'lilac', label: 'Lilac', color: '#c8b4ff' },
] as const

export const BACKGROUNDS = [
  { id: 'black', label: 'Projection black', shades: ['#0a0a0b', '#131315', '#1b1b1e'] },
  { id: 'oled', label: 'True black', shades: ['#000000', '#0c0c0e', '#151517'] },
  { id: 'midnight', label: 'Midnight', shades: ['#080b12', '#10151e', '#181e29'] },
  { id: 'espresso', label: 'Espresso', shades: ['#0f0b09', '#19140f', '#221b15'] },
  { id: 'forest', label: 'Forest', shades: ['#08100c', '#0f1914', '#16231c'] },
  { id: 'plum', label: 'Plum', shades: ['#0e0a10', '#17121b', '#201a25'] },
] as const

export const PRESETS = [
  { id: 'projection', label: 'Projection room', accent: 'white', background: 'black' },
  { id: 'lights-out', label: 'Lights out', accent: 'white', background: 'oled' },
  { id: 'midnight', label: 'Midnight', accent: 'sky', background: 'midnight' },
  { id: 'matinee', label: 'Matinee', accent: 'sun', background: 'espresso' },
  { id: 'greenroom', label: 'Greenroom', accent: 'mint', background: 'forest' },
  { id: 'velvet', label: 'Velvet', accent: 'lilac', background: 'plum' },
] as const

export const TEXT_SIZES = [
  { id: 'small', label: 'Smaller', scale: 0.92 },
  { id: 'default', label: 'Default', scale: 1 },
  { id: 'large', label: 'Larger', scale: 1.1 },
  { id: 'largest', label: 'Largest', scale: 1.22 },
] as const

export const CORNERS = [
  { id: 'square', label: 'Square', radius: '0.1875rem' },
  { id: 'soft', label: 'Soft', radius: '0.625rem' },
  { id: 'round', label: 'Round', radius: '1.125rem' },
] as const

type Id<T extends readonly { id: string }[]> = T[number]['id']
export interface Theme {
  /** One of ACCENTS, or 'custom': the colour in `custom`, lightened as far as dark text on it needs. */
  accent: Id<typeof ACCENTS> | 'custom'
  /** The colour last picked as one's own (#rrggbb), kept while a listed one is chosen. */
  custom: string
  background: Id<typeof BACKGROUNDS>
  text: Id<typeof TEXT_SIZES>
  corners: Id<typeof CORNERS>
  /** Fewer animations: things appear without sliding or fading. */
  calm: boolean
  /** A title's page takes on its artwork's colour (ambient.ts). */
  ambient: boolean
}

export const DEFAULT_THEME: Theme = { accent: 'white', custom: '#ff8fab', background: 'black', text: 'default', corners: 'soft', calm: false, ambient: true }

const key = () => `nexttupp:theme:${getActiveProfile() ?? 'default'}`
const pick = <T extends readonly { id: string }[]>(list: T, id: unknown, fallback: Id<T>): Id<T> =>
  (list.some(x => x.id === id) ? id : fallback) as Id<T>

/** This profile's look, from this browser; anything unknown falls back to the default. */
export function readTheme (): Theme {
  let raw: Partial<Record<keyof Theme, unknown>> = {}
  try { raw = JSON.parse(localStorage.getItem(key()) ?? '{}') ?? {} } catch { /* default */ }
  const custom = typeof raw.custom === 'string' && readableAccent(raw.custom) ? raw.custom.toLowerCase() : DEFAULT_THEME.custom
  return {
    accent: raw.accent === 'custom' ? 'custom' : pick(ACCENTS, raw.accent, 'white'),
    custom,
    background: pick(BACKGROUNDS, raw.background, DEFAULT_THEME.background),
    text: pick(TEXT_SIZES, raw.text, DEFAULT_THEME.text),
    corners: pick(CORNERS, raw.corners, DEFAULT_THEME.corners),
    calm: raw.calm === true,
    ambient: raw.ambient !== false,
  }
}

/** The action colour this look shows. */
export const accentColor = (t: Theme): string =>
  t.accent === 'custom' ? readableAccent(t.custom) ?? '#ffffff' : ACCENTS.find(a => a.id === t.accent)!.color

/** The preset this look matches, if any. */
export const presetOf = (t: Theme) => PRESETS.find(p => p.accent === t.accent && p.background === t.background)

export function applyTheme (t: Theme): void {
  const root = document.documentElement
  const accent = accentColor(t)
  const [bg, bg1, bg2] = BACKGROUNDS.find(b => b.id === t.background)!.shades
  const set = (name: string, value: string) => root.style.setProperty(name, value)
  set('--accent', accent)
  set('--theme-bg', bg)
  set('--bg-1', bg1)
  set('--bg-2', bg2)
  set('--text-scale', String(TEXT_SIZES.find(s => s.id === t.text)!.scale))
  set('--radius-art', CORNERS.find(c => c.id === t.corners)!.radius)
  root.classList.toggle('calm', t.calm)
  root.dataset.ambient = t.ambient ? 'on' : 'off'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
}

const listeners = new Set<() => void>()
let cache: { k: string; t: Theme } | null = null
const read = (): Theme => {
  const k = key()
  if (cache?.k !== k) cache = { k, t: readTheme() }
  return cache.t
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export const useTheme = (): Theme => useSyncExternalStore(subscribe, read)

/** Changes this profile's look, here and now. */
export function setTheme (patch: Partial<Theme>): void {
  const t = { ...read(), ...patch }
  try { localStorage.setItem(key(), JSON.stringify(t)) } catch { /* this visit only */ }
  cache = { k: key(), t }
  applyTheme(t)
  for (const l of listeners) l()
}

/** Puts on the active profile's look: at start-up, and after switching profile. */
export function applyProfileTheme (): void {
  applyTheme(read())
  for (const l of listeners) l()
}
