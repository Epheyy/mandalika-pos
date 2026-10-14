import { describe, expect, it } from 'vitest'
import { createKeyedQueue, settleEdit, type PendingEdits } from './pendingEdits'

describe('settleEdit', () => {
  it('drops a pending value that is still the one that was saved', () => {
    const before: PendingEdits = { sc1: { a: 11, b: 3 } }
    const after = settleEdit(before, 'sc1', 'a', 11)
    expect(after).toEqual({ sc1: { b: 3 } })
    expect(before.sc1.a).toBe(11) // input is not mutated
  })

  it('keeps a newer value typed while the save was in flight', () => {
    const after = settleEdit({ sc1: { a: 12 } }, 'sc1', 'a', 11)
    expect(after).toEqual({ sc1: { a: 12 } })
  })

  it('treats a cleared line (null) like any other value', () => {
    expect(settleEdit({ sc1: { a: null } }, 'sc1', 'a', null)).toEqual({ sc1: {} })
    expect(settleEdit({ sc1: { a: null } }, 'sc1', 'a', 5)).toEqual({ sc1: { a: null } })
  })

  it('is a no-op for an unknown line', () => {
    expect(settleEdit({ sc1: { a: 1 } }, 'sc2', 'a', 1)).toEqual({ sc1: { a: 1 } })
  })
})

describe('createKeyedQueue', () => {
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
  }

  it('never overlaps two runs for the same key and reads the latest value when its turn comes', async () => {
    const q = createKeyedQueue()
    let latest = 11
    const sent: number[] = []
    const gate = deferred()
    let inFlight = 0
    let maxInFlight = 0
    const task = async (hold?: Promise<void>) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      sent.push(latest) // value is read when the task starts
      await hold
      inFlight--
    }
    const first = q.run('line', () => task(gate.promise))
    await new Promise((r) => setTimeout(r, 0)) // the first save is now in flight with 11
    latest = 12 // typed while it is in flight
    const second = q.run('line', () => task())
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual([11]) // second has not started
    gate.resolve()
    await Promise.all([first, second])
    expect(sent).toEqual([11, 12])
    expect(maxInFlight).toBe(1)
  })

  it('runs different keys in parallel', async () => {
    const q = createKeyedQueue()
    const gate = deferred()
    const started: string[] = []
    const a = q.run('a', async () => { started.push('a'); await gate.promise })
    const b = q.run('b', async () => { started.push('b') })
    await b
    expect(started).toEqual(['a', 'b'])
    gate.resolve()
    await a
  })

  it('keeps serving a key after a run failed, and reports that failure to its caller', async () => {
    const q = createKeyedQueue()
    const failed = q.run('a', async () => { throw new Error('boom') })
    await expect(failed).rejects.toThrow('boom')
    await expect(q.run('a', async () => 'ok')).resolves.toBe('ok')
  })
})
