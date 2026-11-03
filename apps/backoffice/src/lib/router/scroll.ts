/*
 * Scroll restore per route. <main> is the scroll box, so the browser's own restoration does not apply.
 * The decision is pure (scrollPlan) and tested in node; the DOM side lives in shell/useScrollRestore.ts.
 */
import type { RouteMove } from './navigate'

export type ScrollPlan = { kind: 'keep' } | { kind: 'top' } | { kind: 'restore'; top: number }

const samePath = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i])

/**
 * What <main> should do after a move.
 * - Only the query changed (a filter, a page, an overlay): keep the scroll, or the list jumps under the user.
 * - A push or replace to another path is a new place: start at the top.
 * - Back/Forward to another path: put the entry's scroll back; an entry never saved starts at the top.
 */
export function scrollPlan(move: RouteMove, saved: ReadonlyMap<number, number>): ScrollPlan {
  if (samePath(move.from.path, move.to.path)) return { kind: 'keep' }
  if (move.kind !== 'pop') return { kind: 'top' }
  const top = saved.get(move.to.idx)
  return top && top > 0 ? { kind: 'restore', top } : { kind: 'top' }
}

/** Bounded so a long session of moves does not keep growing: the oldest idx goes first. */
export const MAX_REMEMBERED = 200

export function remember(saved: Map<number, number>, idx: number, top: number): void {
  saved.delete(idx)
  saved.set(idx, top)
  while (saved.size > MAX_REMEMBERED) {
    const oldest = saved.keys().next().value
    if (oldest === undefined) break
    saved.delete(oldest)
  }
}

/** A restore can only reach `top` once the content is tall enough; lazy chunks and async data make it late. */
export const RESTORE_TIMEOUT_MS = 1500
export const canReach = (top: number, scrollHeight: number, clientHeight: number): boolean => scrollHeight - clientHeight >= top
