/**
 * Admin list matrix: map Firestore list membership + status arrays ↔ coarse UI radio choices.
 * "queue" matches the main grid tabs (to-watch + maybe-later); both are the active queue.
 */

export type MatrixUiChoice = "absent" | "queue" | "watched" | "archive";

/** Firestore `StatusKey` for writes when the user picks a non-absent column (queue → to-watch). */
export function matrixChoiceToStatusKey(
  choice: Exclude<MatrixUiChoice, "absent">
): "to-watch" | "watched" | "archive" {
  if (choice === "queue") return "to-watch";
  if (choice === "watched") return "watched";
  return "archive";
}

/**
 * Derive UI choice from raw list arrays. `itemKeys` is the set of `listKey(row)` for rows in `items`.
 */
export function membershipToMatrixChoice(
  key: string,
  itemKeys: ReadonlySet<string>,
  watched: ReadonlySet<string>,
  maybeLater: ReadonlySet<string>,
  archive: ReadonlySet<string>
): MatrixUiChoice {
  if (!itemKeys.has(key)) return "absent";
  if (archive.has(key)) return "archive";
  if (watched.has(key)) return "watched";
  if (maybeLater.has(key)) return "queue";
  return "queue";
}

export type MatrixCellDiff = {
  registryId: string;
  columnKey: string;
  from: MatrixUiChoice;
  to: MatrixUiChoice;
};

/** Collect cells where draft differs from baseline (same keys: registryId × columnKey). */
export function diffMatrixChoices(
  baseline: ReadonlyMap<string, ReadonlyMap<string, MatrixUiChoice>>,
  draft: ReadonlyMap<string, ReadonlyMap<string, MatrixUiChoice>>
): MatrixCellDiff[] {
  const out: MatrixCellDiff[] = [];
  for (const [registryId, draftCols] of draft) {
    const baseCols = baseline.get(registryId);
    for (const [columnKey, to] of draftCols) {
      const from = baseCols?.get(columnKey) ?? "absent";
      if (from !== to) {
        out.push({ registryId, columnKey, from, to });
      }
    }
  }
  return out;
}
