// @mandalika/printer — BLE ESC/POS receipt printing for the native POS shell
// (plan §6). Transport-agnostic: buildReceipt → PrinterTransport → bytes.

export { buildReceipt, buildRecap, buildTandaTerima, buildVoidSlip, voidSlipLines, COLS } from './escpos'
export type { ReceiptData, ReceiptDiscountRow, ReceiptLine, RecapData, RecapMethodRow, TandaTerimaData, TandaTerimaLine, VoidSlipData } from './escpos'
export type { RefundSlipData } from './receipt/slips'
export type { PaperWidth, ReceiptLayout } from './receipt/layout'
export { layoutFromApi } from './receipt/fromApi'
export { standarLayout } from './receipt/standar'
export { NoopTransport } from './transport'
export type { PrinterTransport, PrinterDevice, PrinterKind } from './transport'
export { CapacitorBleTransport } from './ble'
export { AutoBluetoothTransport } from './autoTransport'
export { ClassicSppTransport } from './classic'
export { printerErrorMessage } from './printerError'
export { createTransport, printReceipt, printRecap, printRefundSlip, printTandaTerima, printVoidSlip } from './print'
export type { PrintJob, RecapJob, RefundSlipJob, TandaTerimaJob, VoidSlipJob } from './print'
