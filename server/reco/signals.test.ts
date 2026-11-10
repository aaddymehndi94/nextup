import { describe, expect, it } from 'vitest'
import {
  computeSignals, DAY, DECAY, decay, exclusions, isCompleted, progressSignal, strength, WEIGHTS,
} from './signals.ts'
import type { ProgressRow, TasteSnapshot } from './types.ts'

const NOW = Date.UTC(2026, 5, 1)
const empty = (): TasteSnapshot => ({ ratings: [], list: [], progress: [], dismissals: [], prefs: new Map() })

function row (over: Partial<ProgressRow> = {}): ProgressRow {
  return {
    id: 'tt1', type: 'movie', streamId: 'tt1', position: 0, duration: 6000, maxPosition: 0, watchedSec: 0,
    startedAt: NOW - DAY, updatedAt: NOW - DAY, hidden: false, ...over,
  }
}

const weightOf = (snap: TasteSnapshot, now = NOW) => computeSignals(snap, now)[0]?.weight ?? 0

describe('signal weights', () => {
  const like = { ...empty(), ratings: [{ id: 'tt1', type: 'movie' as const, value: 1 as const, at: NOW }] }
  const finished = { ...empty(), progress: [row({ position: 5900, maxPosition: 5900, watchedSec: 5800, completedAt: NOW })] }
  const abandoned = { ...empty(), progress: [row({ position: 600, maxPosition: 600, watchedSec: 600, updatedAt: NOW - 10 * DAY })] }
  const listed = { ...empty(), list: [{ id: 'tt1', type: 'movie' as const, addedAt: NOW, at: NOW }] }
  const played = { ...empty(), progress: [row({ position: 60, maxPosition: 60, watchedSec: 60 })] }

  it('orders like > finished > |stopped early| > My List > a single short play', () => {
    const w = [like, finished, abandoned, listed, played].map(s => Math.abs(weightOf(s)))
    expect(w).toEqual([...w].sort((a, b) => b - a))
    expect(weightOf(abandoned)).toBeLessThan(0)
    expect(weightOf(played)).toBeLessThanOrEqual(0.05)
  })

  it('a dislike outweighs having finished it, and "not interested" is a milder negative', () => {
    const snap = { ...finished, ratings: [{ id: 'tt1', type: 'movie' as const, value: -1 as const, at: NOW }] }
    expect(weightOf(snap)).toBeCloseTo(WEIGHTS.dislike, 5)
    const ni = { ...empty(), dismissals: [{ id: 'tt1', type: 'movie' as const, reason: 'not_interested' as const, at: NOW }] }
    expect(weightOf(ni)).toBeLessThan(0)
    expect(weightOf(ni)).toBeGreaterThan(WEIGHTS.dislike)
    const seen = { ...empty(), dismissals: [{ id: 'tt1', type: 'movie' as const, reason: 'seen' as const, at: NOW }] }
    expect(computeSignals(seen, NOW)).toHaveLength(0)
  })

  it('a like gains a little, but only a little, from also finishing the title', () => {
    const both = { ...finished, ratings: like.ratings }
    expect(weightOf(both)).toBeGreaterThan(weightOf(like))
    expect(weightOf(both)).toBeLessThanOrEqual(WEIGHTS.like + WEIGHTS.likeBonusCap)
  })

  it('onboarding taps count a bit less than considered ratings', () => {
    const tapped = { ...empty(), ratings: [{ ...like.ratings[0], source: 'onboarding' }] }
    expect(weightOf(tapped)).toBeCloseTo(WEIGHTS.like * WEIGHTS.onboardingScale, 5)
  })

  it('stopping early only counts against a title once it has gone stale', () => {
    const recent = progressSignal([row({ position: 600, maxPosition: 600, watchedSec: 600, updatedAt: NOW - DAY })], 'movie', NOW)
    const stale = progressSignal([row({ position: 600, maxPosition: 600, watchedSec: 600, updatedAt: NOW - 10 * DAY })], 'movie', NOW)
    expect(recent?.label).toBe('watching')
    expect(recent!.w).toBeGreaterThan(0)
    expect(stale?.label).toBe('abandoned')
    expect(stale!.w).toBeLessThan(0)
  })

  it('skipping to the end is not finishing', () => {
    const skim = progressSignal([row({ position: 5950, maxPosition: 5950, watchedSec: 90 })], 'movie', NOW)
    expect(skim?.label).toBe('played')
    expect(skim!.w).toBe(WEIGHTS.play)
  })

  it('more finished episodes means a stronger series signal, up to a cap', () => {
    const eps = (n: number) => Array.from({ length: n }, (_, i) => row({ id: 's1', type: 'series', streamId: `s1:1:${i + 1}`, season: 1, episode: i + 1, completedAt: NOW - DAY, watchedSec: 2500, duration: 2700, position: 2650, maxPosition: 2650 }))
    const w = [1, 2, 5, 20].map(n => progressSignal(eps(n), 'series', NOW)!.w)
    expect(w[1]).toBeGreaterThan(w[0])
    expect(w[2]).toBeGreaterThan(w[1])
    expect(w[3]).toBe(WEIGHTS.seriesMax)
  })
})

describe('time decay', () => {
  it('halves the decaying part at the half-life and never drops below the floor', () => {
    for (const kind of ['explicit', 'implicit'] as const) {
      const { halfLifeDays, floor } = DECAY[kind]
      expect(decay(0, kind)).toBe(1)
      expect(decay(halfLifeDays * DAY, kind)).toBeCloseTo(floor + (1 - floor) / 2, 6)
      expect(decay(100 * 365 * DAY, kind)).toBeGreaterThanOrEqual(floor)
      expect(decay(10 * DAY, kind)).toBeGreaterThan(decay(20 * DAY, kind))
    }
  })

  it('old behaviour fades faster than old ratings', () => {
    const yearAgo = NOW - 365 * DAY
    const liked = weightOf({ ...empty(), ratings: [{ id: 'tt1', type: 'movie', value: 1, at: yearAgo }] })
    const finished = weightOf({ ...empty(), progress: [row({ completedAt: yearAgo, updatedAt: yearAgo, watchedSec: 5800, position: 5900, maxPosition: 5900 })] })
    expect(liked / WEIGHTS.like).toBeGreaterThan(finished / WEIGHTS.complete)
  })
})

describe('exclusions and strength', () => {
  it('excludes rated, dismissed, finished and started titles, but not an accidental play', () => {
    const snap: TasteSnapshot = {
      ...empty(),
      ratings: [{ id: 'liked', type: 'movie', value: 1, at: NOW }, { id: 'disliked', type: 'movie', value: -1, at: NOW }],
      dismissals: [{ id: 'dismissed', type: 'movie', reason: 'seen', at: NOW }],
      progress: [
        row({ id: 'finished', streamId: 'finished', completedAt: NOW, watchedSec: 5800 }),
        row({ id: 'started', streamId: 'started', watchedSec: 900, position: 900 }),
        row({ id: 'oops', streamId: 'oops', watchedSec: 30, position: 30 }),
      ],
    }
    expect([...exclusions(snap)].sort()).toEqual(['disliked', 'dismissed', 'finished', 'liked', 'started'])
  })

  it('is a cold start below three clear positives', () => {
    const likes = (n: number): TasteSnapshot => ({ ...empty(), ratings: Array.from({ length: n }, (_, i) => ({ id: `tt${i}`, type: 'movie' as const, value: 1 as const, at: NOW })) })
    expect(strength(computeSignals(likes(2), NOW)).coldStart).toBe(true)
    expect(strength(computeSignals(likes(3), NOW)).coldStart).toBe(false)
    // Lots of list adds and brief plays are not enough on their own.
    const shallow: TasteSnapshot = { ...empty(), list: Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, type: 'movie' as const, addedAt: NOW, at: NOW })) }
    expect(strength(computeSignals(shallow, NOW)).coldStart).toBe(true)
    expect(strength(computeSignals(likes(5), NOW)).confidence).toBe(1)
  })

  it('isCompleted needs the end and real playback', () => {
    expect(isCompleted(5450, 6000, 3000)).toBe(true)
    expect(isCompleted(5450, 6000, 100)).toBe(false)
    expect(isCompleted(3000, 6000, 3000)).toBe(false)
    expect(isCompleted(2600, 2700, 700)).toBe(false)
    expect(isCompleted(2600, 2700, 900)).toBe(true)
    expect(isCompleted(7000, 7200, 1300)).toBe(true)
    expect(isCompleted(10, 0, 10)).toBe(false)
  })
})
