/** The text to show for a failed request: the server's reason when it sent one, else the screen's own fallback. */
export function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message.trim() !== '' ? e.message : fallback
}
