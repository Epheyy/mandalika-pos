/*
 * Pure helpers for tabs that live in the hash path ("#/laporan/refund": screen "laporan", tab "refund").
 * A screen passes the tabs the user may open right now; a missing or unknown segment means the first one.
 */
export interface PathTab<K extends string = string> {
  /** The id the screen and the tests know the tab by (data-tab-key). */
  readonly key: K
  /** The path segment, e.g. "kode-diskon". */
  readonly slug: string
}

/** The tab named by a path segment, or undefined when the segment is absent or not one of `tabs`. */
export function tabForSegment<K extends string>(tabs: readonly PathTab<K>[], segment: string | undefined): K | undefined {
  if (segment === undefined) return undefined
  return tabs.find((t) => t.slug === segment)?.key
}

/** The tab on show: the one the path names, else the first. Undefined only when no tab is available. */
export function activeTab<K extends string>(tabs: readonly PathTab<K>[], segment: string | undefined): K | undefined {
  return tabForSegment(tabs, segment) ?? tabs[0]?.key
}

export function slugForTab<K extends string>(tabs: readonly PathTab<K>[], key: K): string | undefined {
  return tabs.find((t) => t.key === key)?.slug
}

/** The segment right after `base`, or undefined when the path is not under `base`. */
export function segmentAfter(path: readonly string[], base: readonly string[], offset = 0): string | undefined {
  if (base.some((b, i) => path[i] !== b)) return undefined
  return path[base.length + offset]
}
