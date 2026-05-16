// @mandalika/printer — BLE ESC/POS receipt printing for the native POS shell
// (plan §6). Transport-agnostic: buildReceipt → PrinterTransport → bytes.

export { buildReceipt, COLS } from './escpos'
export type { ReceiptData, ReceiptLine } from './escpos'
export { NoopTransport } from './transport'
export type { PrinterTransport, PrinterDevice, PrinterKind } from './transport'
export { CapacitorBleTransport } from './ble'
export { createTransport, printReceipt } from './print'
export type { PrintJob } from './print'
