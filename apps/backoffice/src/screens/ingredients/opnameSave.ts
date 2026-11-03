/**
 * "Simpan" sends only the lines the operator entered in the current draft. The server updates exactly the lines it is
 * sent and leaves the rest as stored, so an ingredient nobody counted stays NULL and is skipped by "Selesai"
 * (sending 0 for it would zero its stock on completion).
 */
export function buildIngredientCountSaveItems(
  items: ReadonlyArray<{ id: string }>,
  draft: Readonly<Record<string, number>>,
): { itemId: string; counted: number }[] {
  return items.flatMap((it) => (draft[it.id] === undefined ? [] : [{ itemId: it.id, counted: draft[it.id] }]))
}
