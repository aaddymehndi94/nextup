// Small fetch helpers with timeouts and a short in-memory cache for upstream APIs.

const cache = new Map<string, { at: number; value: unknown }>()

export class UpstreamError extends Error {
  readonly status?: number
  constructor (message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export async function fetchJson<T> (url: string, opts: { timeoutMs?: number; cacheMs?: number } = {}): Promise<T> {
  const { timeoutMs = 12_000, cacheMs = 0 } = opts
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < cacheMs) return hit.value as T
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (nextup)', accept: 'application/json' },
    })
  } catch (err) {
    const name = (err as Error).name
    throw new UpstreamError(name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : (err as Error).message)
  }
  if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`, res.status)
  const value = await res.json() as T
  if (cacheMs > 0) {
    cache.set(url, { at: Date.now(), value })
    if (cache.size > 500) cache.delete(cache.keys().next().value!)
  }
  return value
}
