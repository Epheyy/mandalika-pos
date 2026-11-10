import { describe, expect, it } from 'vitest'
import { printerErrorMessage } from './printerError'

const TIMEOUT =
  'Gagal mencetak: printer tidak menjawab. Pastikan printer menyala, ada kertas, dan dekat dengan tablet.'
const DROPPED = 'Gagal mencetak: sambungan ke printer terputus. Coba cetak ulang.'

const cases: Array<[string, unknown, string]> = [
  ['CONNECT_TIMEOUT', { code: 'CONNECT_TIMEOUT' }, TIMEOUT],
  ['BLE timeout text', new Error('Connection timeout.'), TIMEOUT],
  [
    'CONNECT_FAILED',
    { code: 'CONNECT_FAILED' },
    'Gagal mencetak: tidak bisa tersambung ke printer. Matikan lalu nyalakan printer, lalu coba lagi.',
  ],
  ['WRITE_FAILED', { code: 'WRITE_FAILED' }, DROPPED],
  ['NOT_CONNECTED', { code: 'NOT_CONNECTED' }, DROPPED],
  ['BT_OFF', { code: 'BT_OFF' }, 'Gagal mencetak: Bluetooth tablet mati. Nyalakan Bluetooth lalu coba lagi.'],
  [
    'PERMISSION_DENIED',
    { code: 'PERMISSION_DENIED' },
    'Gagal mencetak: izin Bluetooth ditolak. Izinkan "Perangkat di sekitar" untuk aplikasi POS di Pengaturan Android.',
  ],
  [
    'NOT_BONDED',
    { code: 'NOT_BONDED' },
    'Gagal mencetak: printer belum dipasangkan di Pengaturan Bluetooth tablet.',
  ],
  ['already Gagal', new Error('Gagal sesuatu'), 'Gagal sesuatu'],
  ['plain Error', new Error('Printer belum dipilih'), 'Gagal mencetak: Printer belum dipilih'],
  ['non-Error', 'boom', 'Gagal mencetak'],
]

describe('printerErrorMessage', () => {
  it.each(cases)('%s', (_n, input, want) => {
    const got = printerErrorMessage(input)
    expect(got).toBe(want)
    expect(got.startsWith('Gagal')).toBe(true)
  })
})
