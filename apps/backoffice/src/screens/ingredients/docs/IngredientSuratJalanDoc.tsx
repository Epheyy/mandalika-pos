// apps/backoffice/src/screens/ingredients/docs/IngredientSuratJalanDoc.tsx
//
// Clone of SP4 SuratJalanDoc adapted for IngredientTransfer:
//  - Title: "SURAT JALAN BAHAN"
//  - Items: ingredientName · ingredientUnit · sentQty
//  - Source/dest: sourceWarehouseName / destWarehouseName (flat fields, no nested object)
//
// All styles are inline. Tailwind is NOT applied here because html-to-image
// cannot reach Tailwind's runtime CSS during canvas serialization.
// System fonts only — no web fonts.

import type { components } from '@mandalika/api'
import type { CSSProperties, ReactNode } from 'react'

type IngredientTransfer = components['schemas']['IngredientTransfer']
type Letterhead = components['schemas']['Letterhead']

const PAGE_W = 794   // A4 @ 96dpi
const PAGE_H = 1123  // A4 @ 96dpi

interface IngredientSuratJalanDocProps {
  transfer: IngredientTransfer
}

export function IngredientSuratJalanDoc({ transfer: t }: IngredientSuratJalanDocProps) {
  const lh: Letterhead | null = t.senderLetterhead ?? null
  const addr = (lh?.addressLines ?? []).filter((s) => s && s.trim().length > 0)
  const dateSrc = t.sentAt ?? t.createdAt
  const date = dateSrc
    ? new Date(dateSrc).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })
    : ''
  const totalQty = t.items.reduce((s, x) => s + x.sentQty, 0)

  const sourceName = t.source.name ?? t.source.id
  const destName = t.dest.name ?? t.dest.id

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={headerStyle}>
        {lh?.logoUrl ? (
          <img
            src={lh.logoUrl}
            alt=""
            crossOrigin="anonymous"
            style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover' }}
          />
        ) : null}
        <div style={{ flex: 1 }}>
          <div style={brandNameStyle}>{lh?.brandName ?? lh?.locationName ?? ''}</div>
          {addr.length > 0 && <div style={mutedStyle}>{addr.join(' · ')}</div>}
          {(lh?.phone || lh?.npwp) && (
            <div style={mutedStyle}>
              {lh?.phone ?? ''}
              {lh?.phone && lh?.npwp ? ' · ' : ''}
              {lh?.npwp ? `NPWP ${lh.npwp}` : ''}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={docTitleStyle}>SURAT JALAN BAHAN</div>
          <div style={docNumStyle}>{t.suratJalanNo ?? ''}</div>
          <div style={mutedStyle}>{date}</div>
        </div>
      </div>
      <hr style={dividerStyle} />

      {/* Dari / Untuk */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
        <Block label="Dari" name={sourceName} addr={addr} />
        <Block label="Untuk" name={destName} addr={[]} />
      </div>

      {/* Items */}
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>Nama Bahan</Th>
            <Th>Satuan</Th>
            <Th right>Qty</Th>
          </tr>
        </thead>
        <tbody>
          {t.items.map((it) => (
            <tr key={it.id}>
              <Td>{it.ingredientName}</Td>
              <Td>{it.ingredientUnit}</Td>
              <Td right>{it.sentQty}</Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <Td colSpan={2} right bold style={{ borderTop: '1px solid #444' }}>
              Total
            </Td>
            <Td right bold style={{ borderTop: '1px solid #444' }}>
              {totalQty}
            </Td>
          </tr>
        </tfoot>
      </table>

      {t.note && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#444' }}>
          <b>Catatan:</b> {t.note}
        </div>
      )}

      {/* Signatures pinned near bottom; spacer pushes them down */}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 32, marginTop: 80 }}>
        <Sig label="Pengirim" />
        <Sig label="Penerima" />
      </div>
    </div>
  )
}

// ── Sub-components (kept in-file for self-containment) ──────────────────

function Block({ label, name, addr }: { label: string; name: string; addr: string[] }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={blockLabelStyle}>{label}</div>
      <div style={{ fontWeight: 700 }}>{name}</div>
      {addr.length > 0 && <div style={mutedStyle}>{addr.join(', ')}</div>}
    </div>
  )
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      style={{
        textAlign: right ? 'right' : 'left',
        background: '#f3f0e8',
        color: '#555',
        fontSize: 11,
        padding: '6px 8px',
        borderBottom: '1px solid #ddd',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  right,
  bold,
  colSpan,
  style,
}: {
  children: ReactNode
  right?: boolean
  bold?: boolean
  colSpan?: number
  style?: CSSProperties
}) {
  return (
    <td
      colSpan={colSpan}
      style={{
        textAlign: right ? 'right' : 'left',
        padding: '6px 8px',
        borderBottom: '1px solid #eee',
        fontWeight: bold ? 700 : 400,
        ...style,
      }}
    >
      {children}
    </td>
  )
}

function Sig({ label }: { label: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          borderTop: '1px solid #444',
          marginTop: 32,
          paddingTop: 4,
          textAlign: 'center',
          fontSize: 11,
          color: '#555',
        }}
      >
        {label}
      </div>
    </div>
  )
}

// ── Styles ──────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  width: PAGE_W,
  minHeight: PAGE_H,
  background: '#fff',
  color: '#1a1a1a',
  padding: 48,
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
  fontSize: 13,
  lineHeight: 1.5,
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'flex-start',
}

const brandNameStyle: CSSProperties = { fontWeight: 800, fontSize: 18 }
const docTitleStyle: CSSProperties = {
  fontWeight: 800,
  letterSpacing: '0.15em',
  fontSize: 16,
}
const docNumStyle: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 13,
}
const mutedStyle: CSSProperties = { color: '#666', fontSize: 12 }
const dividerStyle: CSSProperties = {
  border: 0,
  borderTop: '2px solid #8a6a1f',
  margin: '16px 0',
}
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const blockLabelStyle: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: '0.15em',
  color: '#888',
  textTransform: 'uppercase',
  marginBottom: 4,
}
