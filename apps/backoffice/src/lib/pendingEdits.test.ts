import { describe, expect, it } from 'vitest'
import { completeAfterFlush, createKeyedQueue, createLineSaver, settleEdit, type PendingEdits } from './pendingEdits'

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

describe('createLineSaver', () => {
  const setup = (opts: { failSend?: boolean; hold?: Promise<void> } = {}) => {
    let edits: PendingEdits = { sc1: { a: 11 } }
    const log: string[] = []
    const saver = createLineSaver({
      getEdits: () => edits,
      setEdits: (fn) => { edits = fn(edits) },
      send: async (_sc, key, value) => {
        log.push(`send:${key}=${value}`)
        if (opts.hold) await opts.hold
        if (opts.failSend) throw new Error('down')
      },
      refresh: async () => { log.push(`refresh(pending=${JSON.stringify(edits.sc1 ?? {})})`) },
    })
    return { saver, log, get: () => edits, set: (e: PendingEdits) => { edits = e } }
  }

  it('refreshes before it clears the edit, so the input never reverts to stale data', async () => {
    const s = setup()
    await s.saver.save('sc1', 'a')
    expect(s.log).toEqual(['send:a=11', 'refresh(pending={"a":11})'])
    expect(s.get().sc1).toEqual({})
  })

  it('keeps a value typed while the save was in flight and sends it next', async () => {
    let release!: () => void
    const hold = new Promise<void>((r) => { release = r })
    const s = setup({ hold })
    const first = s.saver.save('sc1', 'a')
    await new Promise((r) => setTimeout(r, 0))
    s.set({ sc1: { a: 12 } })
    const second = s.saver.save('sc1', 'a')
    release()
    await Promise.all([first, second])
    expect(s.log.filter((l) => l.startsWith('send'))).toEqual(['send:a=11', 'send:a=12'])
    expect(s.get().sc1).toEqual({})
  })

  it('leaves the edit pending and rejects when the send fails', async () => {
    const s = setup({ failSend: true })
    await expect(s.saver.save('sc1', 'a')).rejects.toThrow('down')
    expect(s.get().sc1).toEqual({ a: 11 })
  })

  it('does nothing for a line with no pending edit', async () => {
    const s = setup()
    await s.saver.save('sc1', 'zzz')
    expect(s.log).toEqual([])
  })
})

describe('completeAfterFlush', () => {
  it('flushes first, then completes', async () => {
    const order: string[] = []
    const done = await completeAfterFlush(
      async () => { order.push('flush'); return true },
      async () => { order.push('complete') },
    )
    expect(done).toBe(true)
    expect(order).toEqual(['flush', 'complete'])
  })

  it('stops without completing when something could not be saved', async () => {
    let completed = false
    const done = await completeAfterFlush(async () => false, async () => { completed = true })
    expect(done).toBe(false)
    expect(completed).toBe(false)
  })
})
