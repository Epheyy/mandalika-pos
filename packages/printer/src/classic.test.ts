import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({
  listBonded: vi.fn(),
  connect: vi.fn(),
  write: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock('./classicPlugin', () => ({ ClassicPrinter: plugin }))

import { ClassicSppTransport } from './classic'

beforeEach(() => {
  Object.values(plugin).forEach((f) => f.mockReset().mockResolvedValue(undefined))
})

describe('ClassicSppTransport', () => {
  it('connects with the address and a 10 s timeout', async () => {
    await new ClassicSppTransport().connect('86:67:7A:7E:30:CB')
    expect(plugin.connect).toHaveBeenCalledWith({ address: '86:67:7A:7E:30:CB', timeoutMs: 10000 })
  })

  it('writes base64 once per call', async () => {
    await new ClassicSppTransport().write(new Uint8Array([27, 64]))
    expect(plugin.write).toHaveBeenCalledTimes(1)
    expect(plugin.write).toHaveBeenCalledWith({ data: 'G0A=' })
  })

  it('drains by bytes written, then resets the counter', async () => {
    const t = new ClassicSppTransport()
    await t.write(new Uint8Array(500))
    await t.write(new Uint8Array(300))
    await t.disconnect()
    expect(plugin.disconnect).toHaveBeenLastCalledWith({ drainMs: 400 })
    await t.disconnect()
    expect(plugin.disconnect).toHaveBeenLastCalledWith({ drainMs: 0 })
  })

  it('propagates the plugin reject code', async () => {
    plugin.connect.mockRejectedValue({ code: 'CONNECT_TIMEOUT' })
    await expect(new ClassicSppTransport().connect('x')).rejects.toMatchObject({
      code: 'CONNECT_TIMEOUT',
    })
  })

  it('lists bonded devices and reports availability', async () => {
    plugin.listBonded.mockResolvedValue({
      devices: [
        { address: 'A', name: 'RPPO2N', type: 'dual', hasSpp: true },
        { address: 'B', name: null, type: 'classic', hasSpp: false },
      ],
    })
    const t = new ClassicSppTransport()
    expect(await t.listBonded()).toEqual([
      { deviceId: 'A', name: 'RPPO2N' },
      { deviceId: 'B', name: 'Perangkat' },
    ])
    expect(await t.isAvailable()).toBe(true)
    plugin.listBonded.mockRejectedValue(new Error('x'))
    expect(await t.isAvailable()).toBe(false)
    expect(await t.pickDevice()).toBeNull()
  })
})
