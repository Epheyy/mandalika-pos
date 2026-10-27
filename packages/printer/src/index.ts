// @mandalika/printer — BLE ESC/POS receipt printing for the native POS shell
// (plan §6). Transport-agnostic: buildReceipt → PrinterTransport → bytes.

export { buildReceipt, buildRecap, buildTandaTerima, COLS } from './escpos'
export type { ReceiptData, ReceiptDiscountRow, ReceiptLine, RecapData, RecapMethodRow, TandaTerimaData, TandaTerimaLine } from './escpos'
export { NoopTransport } from './transport'
export type { PrinterTransport, PrinterDevice, PrinterKind } from './transport'
export { CapacitorBleTransport } from './ble'
export { createTransport, printReceipt, printRecap, printTandaTerima } from './print'
export type { PrintJob, RecapJob, TandaTerimaJob } from './print'
