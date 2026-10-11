import { initJournal, initSecureKV } from '@mandalika/sync'

/** Storage boot, in order: hydrate secure storage, THEN adopt the SQLite outbox journal (it needs the
 *  Preferences KV for the migration backup/sentinel). Rejects with a message `main.tsx` shows as the
 *  retryable boot error; never resolves with an empty queue over data that may still be on disk. */
export async function bootStorage(): Promise<void> {
  await initSecureKV()
  await initJournal()
}
