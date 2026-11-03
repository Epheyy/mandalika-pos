import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_DEBOUNCE_MS = 300

/**
 * A search box whose committed value lives in the URL. `text` is what is typed (always live, so an export can
 * use it); `write` is called with the typed text 300 ms after the last keystroke, and only when it differs from
 * the URL value, so settling on the same text never adds an entry. Callers write with `{ replace: true }`.
 * A URL value that did not come from this box (Back/Forward, a reset) replaces the text and cancels a pending write.
 */
export function useUrlSearchText(
  urlValue: string,
  write: (value: string) => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): readonly [string, (next: string) => void] {
  const [text, setText] = useState(urlValue)
  const emitted = useRef(urlValue)
  const current = useRef(urlValue)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestWrite = useRef(write)
  useEffect(() => {
    latestWrite.current = write
    current.current = urlValue
  })

  useEffect(() => {
    if (urlValue === emitted.current) return
    emitted.current = urlValue
    if (timer.current) clearTimeout(timer.current)
    setText(urlValue)
  }, [urlValue])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const type = useCallback(
    (next: string) => {
      setText(next)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (next === current.current) return
        emitted.current = next
        latestWrite.current(next)
      }, debounceMs)
    },
    [debounceMs],
  )

  return [text, type]
}
