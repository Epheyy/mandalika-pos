import { useState } from 'react'

/**
 * Delete with a visible answer. A refused delete keeps the dialog open with the server's reason; `busy` blocks a
 * second click, whose 404 would otherwise linger as the next dialog's error.
 */
export function useRowDelete<Row extends { id: string }>(
  remove: (id: string) => Promise<void>,
  refetch: () => Promise<unknown>,
  failure: string,
) {
  const [target, setTarget] = useState<Row | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const ask = (row: Row) => {
    setError(null)
    setTarget(row)
  }
  const cancel = () => {
    if (!busy) setTarget(null)
  }
  const confirm = async () => {
    if (!target) return
    setBusy(true)
    try {
      await remove(target.id)
    } catch (e: unknown) {
      setError(e instanceof Error && e.message ? e.message : failure)
      return
    } finally {
      setBusy(false)
    }
    setTarget(null)
    await refetch()
  }
  return { target, error, busy, ask, cancel, confirm }
}
