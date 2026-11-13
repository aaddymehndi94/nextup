import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trailerIds } from './catalog/cinemeta.ts'
import { FakeTrailerSource, registerTrailerRoutes, type TrailerSource, Trailers } from './trailers.ts'

const A = 'aaaaaaaaaaa'
const B = 'bbbbbbbbbbb'
const C = 'ccccccccccc'

/** A source the test finishes by hand: each save waits until `finish(id)` or `fail(id)`. */
function manualSource (bytes = 100) {
  const pending = new Map<string, { dest: string; resolve: () => void; reject: (e: Error) => void }>()
  const started: string[] = []
  const source: TrailerSource = {
    ready: () => true,
    save: (id, dest) => new Promise((resolve, reject) => { started.push(id); pending.set(id, { dest, resolve, reject }) }),
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) }
  return {
    source,
    started,
    async finish (id: string, size = bytes) {
      const p = pending.get(id)!
      writeFileSync(p.dest, Buffer.alloc(size, 1))
      pending.delete(id)
      p.resolve()
      await settle()
    },
    async fail (id: string) {
      const p = pending.get(id)!
      pending.delete(id)
      p.reject(new Error('Video unavailable'))
      await settle()
    },
  }
}

let dir: string
let now: number
const titles: Record<string, string[]> = { tt1: [A, B], tt2: [C], tt3: [] }
const make = (source: TrailerSource, extra: Partial<ConstructorParameters<typeof Trailers>[0]> = {}) =>
  new Trailers({ dir, source, lookup: async (_t, id) => titles[id] ?? [], now: () => now, ...extra })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexttupp-trailers-'))
  now = 1_700_000_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Trailers', () => {
  it('prepares on the first ask, then is ready from the saved file', async () => {
    const m = manualSource()
    const t = make(m.source)
    expect(await t.status('movie', 'tt1')).toEqual({ state: 'preparing' })
    expect(await t.status('movie', 'tt1')).toEqual({ state: 'preparing' })
    expect(m.started).toEqual([A]) // one download for both asks
    await m.finish(A)
    expect(await t.status('movie', 'tt1')).toEqual({ state: 'ready', url: `/api/trailer/video/${A}` })
    expect(readdirSync(dir)).toEqual([`${A}.mp4`])
  })

  it('has none without trailers, without the helper, or in private mode before it is saved', async () => {
    const m = manualSource()
    expect(await make(m.source).status('movie', 'tt3')).toEqual({ state: 'none' })
    expect(await make({ ...m.source, ready: () => false }).status('movie', 'tt1')).toEqual({ state: 'none' })
    expect(await make(m.source, { lookup: async () => { throw new Error('offline') } }).status('movie', 'tt1')).toEqual({ state: 'none' })
    const t = make(m.source)
    expect(await t.status('movie', 'tt1', { private: true })).toEqual({ state: 'none' })
    expect(m.started).toEqual([])
    await t.status('movie', 'tt1')
    await m.finish(A)
    expect((await t.status('movie', 'tt1', { private: true })).state).toBe('ready')
  })

  it('tries the next trailer when one fails, and gives up for a while when all have', async () => {
    const m = manualSource()
    const t = make(m.source)
    await t.status('movie', 'tt1')
    await m.fail(A)
    expect(await t.status('movie', 'tt1')).toEqual({ state: 'preparing' })
    expect(m.started).toEqual([A, B])
    await m.fail(B)
    expect(await t.status('movie', 'tt1')).toEqual({ state: 'none' })
    expect(existsSync(join(dir, `${A}.part.mp4`))).toBe(false)
    now += 3600_000
    expect(await t.status('movie', 'tt1')).toEqual({ state: 'preparing' })
    expect(m.started).toEqual([A, B, A])
  })

  it('runs one download at a time, the page on screen first, and drops ones nobody waits for', async () => {
    const m = manualSource()
    const extra = { tt4: ['ddddddddddd'], tt5: ['eeeeeeeeeee'] }
    Object.assign(titles, extra)
    const t = make(m.source)
    await t.status('movie', 'tt1') // starts A
    await t.status('movie', 'tt2') // waits
    now += 1000
    await t.status('movie', 'tt4') // waits, asked later
    expect(m.started).toEqual([A])
    await m.finish(A)
    expect(m.started).toEqual([A, 'ddddddddddd']) // the newer ask went first
    now += 120_000 // the page that wanted C was left long ago
    await t.status('movie', 'tt5')
    await m.finish('ddddddddddd')
    expect(m.started).toEqual([A, 'ddddddddddd', 'eeeeeeeeeee'])
    expect(t.busy(C)).toBe(false)
  })

  it('keeps the folder under its cap, least recently shown first', async () => {
    const m = manualSource()
    const t = make(m.source, { capBytes: 250 })
    await t.status('movie', 'tt1')
    await m.finish(A)
    now += 1000
    await t.status('movie', 'tt2')
    await m.finish(C)
    now += 1000
    await t.status('movie', 'tt1') // A shown again: now the most recent
    titles.tt6 = ['fffffffffff']
    now += 1000
    await t.status('movie', 'tt6')
    await m.finish('fffffffffff')
    expect(readdirSync(dir).sort()).toEqual([`${A}.mp4`, 'fffffffffff.mp4'])
  })

  it('clears leftovers of downloads cut short', () => {
    writeFileSync(join(dir, `${A}.part.mp4`), 'x')
    mkdirSync(join(dir, `${A}.part.mp4.dl`))
    writeFileSync(join(dir, `${B}.mp4`), 'x')
    make(manualSource().source)
    expect(readdirSync(dir)).toEqual([`${B}.mp4`])
  })
})

describe('trailer routes', () => {
  it('answers the status and serves the video with ranges', async () => {
    const m = manualSource()
    const t = make(m.source)
    const app = Fastify({ exposeHeadRoutes: false }) // as in server/index.ts
    registerTrailerRoutes(app, t)
    expect((await app.inject('/api/trailer/movie/tt1')).json()).toEqual({ state: 'preparing' })
    expect((await app.inject('/api/trailer/film/tt1')).statusCode).toBe(400)
    expect((await app.inject(`/api/trailer/video/${A}`)).statusCode).toBe(404)
    await m.finish(A, 1000)
    const ready = (await app.inject('/api/trailer/movie/tt1')).json()
    expect(ready).toEqual({ state: 'ready', url: `/api/trailer/video/${A}` })
    const whole = await app.inject(ready.url)
    expect(whole.statusCode).toBe(200)
    expect(whole.headers['content-type']).toBe('video/mp4')
    expect(whole.headers['cache-control']).toBe('no-store')
    expect(whole.rawPayload.length).toBe(1000)
    const part = await app.inject({ url: ready.url, headers: { range: 'bytes=100-199' } })
    expect(part.statusCode).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 100-199/1000')
    expect(part.rawPayload.length).toBe(100)
    expect((await app.inject({ method: 'HEAD', url: ready.url })).headers['content-length']).toBe('1000')
    expect((await app.inject('/api/trailer/video/..%2F..%2Fetc')).statusCode).toBe(404)
    // Private mode: no download starts.
    titles.tt7 = ['ggggggggggg']
    expect((await app.inject({ url: '/api/trailer/movie/tt7', headers: { 'x-nexttupp-private': '1' } })).json()).toEqual({ state: 'none' })
    await app.close()
  })
})

describe('trailer search', () => {
  it('searches once a day per title, keeps only video ids, and answers empty when it fails', async () => {
    const asked: string[] = []
    let fail = false
    const t = make(manualSource().source, {
      search: async (_type, id) => { asked.push(id); if (fail) throw new Error('offline'); return [A, 'not an id', B] },
    })
    const app = Fastify({ exposeHeadRoutes: false })
    registerTrailerRoutes(app, t)
    expect((await app.inject('/api/trailer/movie/tt1/search')).json()).toEqual({ ids: [A, B] })
    expect((await app.inject('/api/trailer/movie/tt1/search')).json()).toEqual({ ids: [A, B] })
    expect(asked).toEqual(['tt1'])
    expect((await app.inject('/api/trailer/film/tt1/search')).statusCode).toBe(400)
    now += 25 * 3600_000
    fail = true
    expect((await app.inject('/api/trailer/movie/tt1/search')).json()).toEqual({ ids: [] })
    // A failed search isn't kept: the next ask tries again.
    fail = false
    expect((await app.inject('/api/trailer/movie/tt1/search')).json()).toEqual({ ids: [A, B] })
    expect(asked).toEqual(['tt1', 'tt1', 'tt1'])
    await app.close()
  })
})

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe.skipIf(!hasFfmpeg)('FakeTrailerSource', () => {
  it('makes a short MP4 that is served once ready', async () => {
    const t = make(new FakeTrailerSource('ffmpeg', { seconds: 1, size: '160x90' }), { now: Date.now })
    expect((await t.status('movie', 'tt2')).state).toBe('preparing')
    let status = await t.status('movie', 'tt2')
    for (let i = 0; i < 100 && status.state === 'preparing'; i++) {
      await new Promise(r => setTimeout(r, 100))
      status = await t.status('movie', 'tt2')
    }
    expect(status).toEqual({ state: 'ready', url: `/api/trailer/video/${C}` })
    const file = join(dir, `${C}.mp4`)
    expect(statSync(file).size).toBeGreaterThan(1000)
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).toString().trim().split('\n')
    expect(probe).toEqual(['h264', 'aac'])
  }, 20_000)
})

describe('trailerIds', () => {
  it('puts trailers first and drops repeats and junk', () => {
    expect(trailerIds({
      trailers: [{ source: 'teaser00000', type: 'Teaser' }, { source: A, type: 'Trailer' }, { source: 'bad' }],
      trailerStreams: [{ ytId: A }, { ytId: B }],
    })).toEqual([A, 'teaser00000', B])
    expect(trailerIds({})).toEqual([])
  })
})
