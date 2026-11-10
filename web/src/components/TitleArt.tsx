import { useEffect, useState } from 'react'
import { useLoaded } from '../hooks.ts'

const trimmed = new Map<string, Promise<string | null>>()

/**
 * Metahub logos sit centred on a padded transparent canvas (800×310), so set as-is the mark floats off the text
 * column and renders at a fraction of its box. Crop to the mark's alpha bounds once per URL and serve the crop
 * from a blob URL. Resolves null when the pixels can't be read (no CORS, decode error); callers then use the
 * original. Opaque images come back unchanged.
 */
function trimLogo (src: string): Promise<string | null> {
  let job = trimmed.get(src)
  if (!job) {
    job = new Promise(resolve => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        try {
          const w = img.naturalWidth
          const h = img.naturalHeight
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx || !w || !h) return resolve(null)
          ctx.drawImage(img, 0, 0)
          const { data } = ctx.getImageData(0, 0, w, h)
          let x0 = w; let y0 = h; let x1 = -1; let y1 = -1
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              if (data[(y * w + x) * 4 + 3] > 8) {
                if (x < x0) x0 = x
                if (x > x1) x1 = x
                if (y < y0) y0 = y
                if (y > y1) y1 = y
              }
            }
          }
          if (x1 < 0) return resolve(null)
          if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return resolve(src)
          const out = document.createElement('canvas')
          out.width = x1 - x0 + 1
          out.height = y1 - y0 + 1
          out.getContext('2d')?.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
          out.toBlob(blob => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png')
        } catch { resolve(null) }
      }
      img.onerror = () => resolve(null)
      img.src = src
    })
    trimmed.set(src, job)
  }
  return job
}

/** A title's logo artwork, or its name set as display type when there is no logo or it fails to load. */
export function TitleArt ({ name, logo, className, as: Tag = 'h1' }: {
  name: string
  logo?: string
  className: string
  as?: 'h1' | 'h2' | 'div'
}) {
  const [failed, setFailed] = useState(!logo)
  const [shown, setShown] = useState<{ for: string; src: string } | null>(null)
  useEffect(() => {
    if (!logo) return
    let live = true
    trimLogo(logo).then(src => { if (live) setShown({ for: logo, src: src ?? logo }) })
    return () => { live = false }
  }, [logo])
  const src = shown && shown.for === logo ? shown.src : undefined
  const [loaded, onLoad] = useLoaded(src)
  if (failed) return <Tag className={`${className} is-text`}>{name}</Tag>
  return (
    <Tag className={className}>
      {!src && <span className="sr-only">{name}</span>}
      {src && <img src={src} alt={name} decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />}
    </Tag>
  )
}
