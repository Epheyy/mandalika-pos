// Shared guard for actions whose success means "durably queued on this device"
// (sale, refund, shift, cash flow, customer, transfer receive).
//
// `engine.enqueue` is async and rejects if the outbox write failed. A caller must
// (1) not run the same action twice while a write is in flight — a React
// `disabled` prop only takes effect on the next render, so two taps in one frame
// would otherwise create two sales with different keys — and (2) only show
// success / clear the form / print once the write has resolved.

export type SubmitOutcome<T> =
  | { status: 'busy' }
  | { status: 'saved'; value: T }
  | { status: 'failed'; error: unknown }

export interface SubmitGate {
  isBusy(): boolean
  run<T>(action: () => Promise<T>): Promise<SubmitOutcome<T>>
}

/** Synchronous single-flight gate: the flag flips before the first await. */
export function createSubmitGate(): SubmitGate {
  let busy = false
  return {
    isBusy: () => busy,
    async run<T>(action: () => Promise<T>): Promise<SubmitOutcome<T>> {
      if (busy) return { status: 'busy' }
      busy = true
      try {
        return { status: 'saved', value: await action() }
      } catch (error) {
        return { status: 'failed', error }
      } finally {
        busy = false
      }
    },
  }
}

/** Persistent, plain-language copy for a write that did not reach storage. */
export function notSavedMessage(what: string): string {
  return `${what} BELUM tersimpan di perangkat. Coba lagi.`
}

export const OUTBOX_CORRUPT_PENDING_MESSAGE =
  'Antrean sinkronisasi rusak; sedang diamankan. Hubungi admin sebelum melanjutkan transaksi.'

export const OUTBOX_CORRUPT_UNSECURED_MESSAGE =
  'Antrean sinkronisasi rusak dan GAGAL diamankan; jangan hapus data aplikasi, hubungi admin.'

export const OUTBOX_CORRUPT_MESSAGE =
  'Antrean sinkronisasi rusak dan telah diamankan; hubungi admin sebelum melanjutkan transaksi.'
