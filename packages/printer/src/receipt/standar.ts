// The built-in "Standar" layout: today's receipt, expressed as blocks. Rendered with `compat: 'v1'` it is
// byte-identical to the frozen buildReceiptV1 for any settings.

import type { components } from '@mandalika/api'
import { resolveReceiptFlags } from '@mandalika/types'
import type { ReceiptLayout, TxField } from './layout'

type ReceiptSettings = components['schemas']['ReceiptSettings']

export function standarLayout(settings: ReceiptSettings): ReceiptLayout {
  const flags = resolveReceiptFlags(settings)
  const headerText = settings.headerText ?? ''
  const footerText = settings.footerText ?? ''

  const top: TxField[] = [...(flags.showOrderNumber ? (['orderNumber'] as const) : []), 'date']
  const bottom: TxField[] = [
    ...(flags.showCustomerName ? (['customerName'] as const) : []),
    ...(flags.showCustomerPhone ? (['customerPhone'] as const) : []),
    ...(flags.showCashier ? (['cashier'] as const) : []),
  ]

  return {
    paperWidth: 58,
    compat: 'v1',
    blocks: [
      {
        id: 'std-header', type: 'header', enabled: true, text: headerText, size: 'large',
        showOutletName: false, showOutletAddress: false, showOutletPhone: false,
        spaceAfter: !!headerText && !!footerText,
      },
      { id: 'std-tx-top', type: 'transaction', enabled: true, fields: top, style: 'columns' },
      { id: 'std-div-1', type: 'divider', enabled: true },
      { id: 'std-items', type: 'items', enabled: true },
      { id: 'std-div-2', type: 'divider', enabled: true },
      {
        id: 'std-totals', type: 'totals', enabled: true,
        showSubtotal: flags.showSubtotal, showDiscount: flags.showDiscount, showTax: flags.showTax,
      },
      { id: 'std-payment', type: 'payment', enabled: true, showChange: flags.showChange },
      { id: 'std-div-3', type: 'divider', enabled: true },
      { id: 'std-tx-bottom', type: 'transaction', enabled: true, fields: bottom, style: 'inline' },
      ...(footerText
        ? [{
            id: 'std-footer', type: 'text' as const, enabled: true, text: footerText, align: 'center' as const,
            bold: false, size: 'normal' as const, spaceBefore: true,
          }]
        : []),
    ],
  }
}
