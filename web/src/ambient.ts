import { useEffect } from 'react'

// A title page takes on its artwork's colour: the page background (--bg) becomes a very dark shade of the
// backdrop's main hue, so the hero runs into the page instead of stopping at black. styles.css animates --bg.

/** The artwork's dominant hue as a page background: saturated pixels count more, then it's darkened a lot. */
function ambientOf (img: HTMLImageElement): string | null {
  const w = 32
  const h = 18
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  let r = 0
  let g = 0
  let b = 0
  let total = 0
  for (let i = 0; i < px.length; i += 4) {
    const max = Math.max(px[i], px[i + 1], px[i + 2])
    const min = Math.min(px[i], px[i + 1], px[i + 2])
    // Colourful, not too dark: weight by saturation, and skip near-black letterboxing.
    const weight = max < 24 ? 0 : 0.15 + (max - min) / 255
    r += px[i] * weight
    g += px[i + 1] * weight
    b += px[i + 2] * weight
    total += weight
  }
  if (!total) return null
  const [hue, sat] = hsl(r / total, g / total, b / total)
  return `hsl(${Math.round(hue)} ${Math.round(Math.min(sat, 0.5) * 100)}% 8.5%)`
}

function hsl (r: number, g: number, b: number): [number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, s]
}

/**
 * Tints the page with this artwork while the component is shown. The image hosts allow CORS, so the copy the
 * page already downloaded is read straight from the browser's cache; if a host refuses, it's read through the
 * server's relay instead.
 */
export function useAmbient (src: string | undefined): void {
  useEffect(() => {
    if (!src) return
    let live = true
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (!live) return
      let color: string | null = null
      try { color = ambientOf(img) } catch { /* unreadable image */ }
      if (color) document.documentElement.style.setProperty('--bg', color)
    }
    if (src.startsWith('https://')) {
      img.crossOrigin = 'anonymous'
      img.onerror = () => {
        img.onerror = null
        img.removeAttribute('crossorigin')
        if (live) img.src = `/api/img?u=${encodeURIComponent(src)}`
      }
    }
    img.src = src
    return () => {
      live = false
      document.documentElement.style.removeProperty('--bg')
    }
  }, [src])
}
