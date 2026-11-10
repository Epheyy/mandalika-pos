import { describe, expect, it, vi } from 'vitest'
import { AutoBluetoothTransport } from './autoTransport'
import type { ClassicBondedDevice } from './classicTypes'
import type { PrinterTransport } from './transport'

function fake(kind: PrinterTransport['kind'], connectImpl?: () => Promise<void>) {
  return {
    kind,
    isAvailable: vi.fn(async () => true),
    pickDevice: vi.fn(async () => null),
    listBonded: vi.fn(async () => []),
    connect: vi.fn(connectImpl ?? (async () => {})),
    write: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  } satisfies PrinterTransport
}

const rpp: ClassicBondedDevice = {
  address: '86:67:7A:7E:30:CB',
  name: 'RPPO2N',
  type: 'dual',
  hasSpp: true,
}

describe('AutoBluetoothTransport', () => {
  it('routes a serial-port printer to SPP, case-insensitively, for the whole job', async () => {
    const ble = fake('capacitor-ble')
    const spp = fake('android-spp')
    const t = new AutoBluetoothTransport(ble, spp, async () => [rpp])
    await t.connect('86:67:7a:7e:30:cb')
    await t.write(new Uint8Array([1]))
    await t.disconnect()
    expect(spp.connect).toHaveBeenCalledWith('86:67:7a:7e:30:cb')
    expect(ble.connect).not.toHaveBeenCalled()
    expect(spp.write).toHaveBeenCalledTimes(1)
    expect(spp.disconnect).toHaveBeenCalledTimes(1)
  })

  it('routes an LE-only device to BLE', async () => {
    const ble = fake('capacitor-ble')
    const spp = fake('android-spp')
    const le = { ...rpp, type: 'le' as const, hasSpp: false }
    await new AutoBluetoothTransport(ble, spp, async () => [le]).connect(rpp.address)
    expect(ble.connect).toHaveBeenCalled()
    expect(spp.connect).not.toHaveBeenCalled()
  })

  it('falls back to BLE when the lookup rejects', async () => {
    const ble = fake('capacitor-ble')
    const spp = fake('android-spp')
    await new AutoBluetoothTransport(ble, spp, async () => {
      throw new Error('no plugin')
    }).connect(rpp.address)
    expect(ble.connect).toHaveBeenCalled()
  })

  it.each(['BT_OFF', 'PERMISSION_DENIED'])('rethrows %s from the lookup without connecting', async (code) => {
    const ble = fake('capacitor-ble')
    const spp = fake('android-spp')
    const t = new AutoBluetoothTransport(ble, spp, async () => {
      throw Object.assign(new Error(code), { code })
    })
    await expect(t.connect(rpp.address)).rejects.toMatchObject({ code })
    expect(ble.connect).not.toHaveBeenCalled()
    expect(spp.connect).not.toHaveBeenCalled()
  })

  it('falls back to BLE for an UNIMPLEMENTED plugin error', async () => {
    const ble = fake('capacitor-ble')
    await new AutoBluetoothTransport(ble, fake('android-spp'), async () => {
      throw Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' })
    }).connect(rpp.address)
    expect(ble.connect).toHaveBeenCalled()
  })

  it('re-runs the lookup after disconnect', async () => {
    const lookup = vi.fn(async () => [rpp])
    const t = new AutoBluetoothTransport(fake('capacitor-ble'), fake('android-spp'), lookup)
    await t.connect(rpp.address)
    await t.disconnect()
    await t.connect(rpp.address)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('rejects write before connect', async () => {
    const t = new AutoBluetoothTransport(fake('capacitor-ble'), fake('android-spp'), async () => [])
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow('Printer belum tersambung')
  })

  it('leaves nothing active when the delegate connect rejects', async () => {
    const spp = fake('android-spp', async () => {
      throw new Error('boom')
    })
    const t = new AutoBluetoothTransport(fake('capacitor-ble'), spp, async () => [rpp])
    await expect(t.connect(rpp.address)).rejects.toThrow('boom')
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow('Printer belum tersambung')
  })

  it('delegates pickDevice, listBonded and isAvailable to BLE', async () => {
    const ble = fake('capacitor-ble')
    const t = new AutoBluetoothTransport(ble, fake('android-spp'), async () => [])
    await t.pickDevice()
    await t.listBonded()
    await t.isAvailable()
    expect(ble.pickDevice).toHaveBeenCalled()
    expect(ble.listBonded).toHaveBeenCalled()
    expect(ble.isAvailable).toHaveBeenCalled()
  })
})
