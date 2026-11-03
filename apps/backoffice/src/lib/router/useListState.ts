import { useCallback, useMemo } from 'react'
import { buildHash, type QueryValue } from './hash'
import { getRouteLocation, navigate } from './navigate'
import { useRoute } from './useRoute'

/**
 * One list field in the URL query. The type of `default` decides how the value is read:
 * number (finite only), boolean ("1"/"true" and "0"/"false"), otherwise string.
 * A value equal to its default is left out of the URL.
 */
export interface ListField<T extends string | number | boolean> {
  /** Query key, e.g. "q", "hal", "status". */
  key: string
  default: T
}

type ListValues = Record<string, string | number | boolean>

export type ListSchema<S extends ListValues> = {
  readonly [K in keyof S]: ListField<S[K]>
}

function readField<T extends string | number | boolean>(field: ListField<T>, raw: string | undefined): T {
  if (raw === undefined) return field.default
  if (typeof field.default === 'number') {
    if (raw.trim() === '') return field.default
    const n = Number(raw)
    return (Number.isFinite(n) ? n : field.default) as T
  }
  if (typeof field.default === 'boolean') {
    if (raw === '1' || raw === 'true') return true as T
    if (raw === '0' || raw === 'false') return false as T
    return field.default
  }
  return raw as T
}

const fieldsOf = <S extends ListValues>(schema: ListSchema<S>): Array<[keyof S, ListField<string | number | boolean>]> =>
  (Object.keys(schema) as Array<keyof S>).map((name) => [name, schema[name] as ListField<string | number | boolean>])

export function parseListState<S extends ListValues>(schema: ListSchema<S>, query: Readonly<Record<string, string>>): S {
  const out: ListValues = {}
  for (const [name, field] of fieldsOf(schema)) out[name as string] = readField(field, query[field.key])
  return out as S
}

/** Query keys for a state: a default comes out as undefined, which buildHash leaves out. */
export function serializeListState<S extends ListValues>(schema: ListSchema<S>, state: S): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {}
  for (const [name, field] of fieldsOf(schema)) {
    const value = state[name]
    out[field.key] = value === field.default ? undefined : value
  }
  return out
}

export interface ListStateOptions {
  /** Typing in a search box should replace the entry, not add one per keystroke. */
  replace?: boolean
}

/**
 * List filters, search, page and sort as URL query state. Pass a module-level schema (a new object each
 * render defeats the memo). Query keys outside the schema, and the path, are kept as they are.
 * Moving goes through the leave guard like any other navigation.
 */
export function useListState<S extends ListValues>(
  schema: ListSchema<S>,
): [S, (patch: Partial<S>, opts?: ListStateOptions) => void] {
  const loc = useRoute()
  const state = useMemo(() => parseListState(schema, loc.query), [schema, loc])
  const setState = useCallback(
    (patch: Partial<S>, opts: ListStateOptions = {}) => {
      const now = getRouteLocation()
      const next = { ...parseListState(schema, now.query), ...patch } as S
      const own = new Set(fieldsOf(schema).map(([, field]) => field.key))
      const kept: Record<string, QueryValue> = {}
      for (const [k, v] of Object.entries(now.query)) if (!own.has(k)) kept[k] = v
      void navigate(buildHash(now.path, { ...kept, ...serializeListState(schema, next) }), { replace: opts.replace })
    },
    [schema],
  )
  return [state, setState]
}
