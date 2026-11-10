// Types shared by the Bluetooth Classic (SPP) transport and the native
// ClassicPrinter plugin. Keep in sync with ClassicPrinterPlugin.java.

export type ClassicDeviceType = 'classic' | 'le' | 'dual' | 'unknown'

export interface ClassicBondedDevice {
  address: string
  name: string | null
  type: ClassicDeviceType
  /** True when the OS lists the serial-port profile among the device UUIDs. */
  hasSpp: boolean
}

/** Reject codes the native plugin may return. */
export const CLASSIC_ERROR_CODES = [
  'BT_OFF',
  'PERMISSION_DENIED',
  'NOT_BONDED',
  'CONNECT_TIMEOUT',
  'CONNECT_FAILED',
  'NOT_CONNECTED',
  'WRITE_FAILED',
] as const

export type ClassicErrorCode = (typeof CLASSIC_ERROR_CODES)[number]
