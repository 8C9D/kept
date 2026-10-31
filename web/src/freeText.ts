/**
 * The one rule for turning a free-text box into a write, shared by the
 * form's save, the table's inline cell and the bulk actions so the three
 * cannot normalize the same text three ways.
 *
 * Exact-match free text is the person's own data (the 2026-08-26 ruling on a
 * doubled-space category; `introducesNewValue`, options.tsx, states it for
 * the lists). So the trim applies to what someone TYPED, and never to what
 * is merely passing through a box on its way past: stored
 * "  Office   Supplies  " renders verbatim, and a save nobody edited must not
 * rewrite it, because the rewritten value stops matching the list it was
 * picked from.
 */

/** Trimmed, with an empty box meaning "no value" - never an empty string. */
export function normalizedFreeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * What to write for this box against the value `stored`, or `undefined` for
 * nothing at all - distinct from `null`, which is a real write that clears
 * the field.
 *
 * The first comparison is the whole fix: a box still holding exactly what is
 * stored was not edited, however untidy that value looks. Only past it does
 * the text count as the person's, and normalizing can then still find that
 * they changed nothing but surrounding whitespace.
 */
export function freeTextWrite(
  box: string,
  stored: string | null,
): string | null | undefined {
  if (box === (stored ?? "")) {
    return undefined;
  }
  const next = normalizedFreeText(box);
  return next === stored ? undefined : next;
}
