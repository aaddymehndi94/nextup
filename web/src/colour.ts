// A colour someone picks for buttons and highlights. Their text is dark (Ink on Light), so a dark pick is
// lightened towards white, in 5% steps, until it reads: relative luminance 0.3, about 6.5:1 against the ink.

const HEX = /^#([0-9a-f]{6})$/i
const MIN_LUMINANCE = 0.3

const linear = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const luminance = ([r, g, b]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
const hex = (rgb: number[]) => '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('')

/** The picked colour, lightened only as far as dark text needs; null when it isn't a #rrggbb colour. */
export function readableAccent (picked: string): string | null {
  const m = HEX.exec(picked.trim())
  if (!m) return null
  const rgb = [0, 2, 4].map(i => Number.parseInt(m[1].slice(i, i + 2), 16))
  for (let step = 0; step <= 20; step++) {
    const mixed = rgb.map(c => Math.round(c + (255 - c) * step / 20))
    if (luminance(mixed) >= MIN_LUMINANCE) return hex(mixed)
  }
  return '#ffffff'
}
