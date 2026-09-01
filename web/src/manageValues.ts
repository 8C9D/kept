import type { OptionField, ReceiptOptions } from "./types.js";

/**
 * The manage-values screen's rules (2026-09-01), kept out of the component
 * so they can be tested without a DOM - the same split every other screen
 * in this client uses (`bulkEdit.ts`, `fiscalPresets.ts`, ReceiptForm's
 * pure half).
 *
 * What the screen is for: `category`, `payment method` and `vendor` are
 * free text and will stay that way (engineering rule: never an enum, never
 * a taxonomy). The lists at `GET /api/receipts/options` are a convenience
 * over what the person has already typed - which means they accumulate
 * every typo, every "Food Basics " with a trailing space, every one-off
 * they never meant to keep. Until now the only way to fix one was to open
 * every receipt carrying it. Renaming rewrites the value on every receipt
 * that carries it; deleting retracts the suggestion and leaves the records
 * alone.
 */

/** The three lists, in the order the screen renders them. */
export const OPTION_LISTS = [
  {
    field: "vendor",
    key: "vendors",
    title: "Vendors",
    empty: "No vendors yet - they appear as you confirm receipts.",
  },
  {
    field: "category",
    key: "categories",
    title: "Categories",
    empty: "No categories yet - they appear as you confirm receipts.",
  },
  {
    field: "paymentMethod",
    key: "paymentMethods",
    title: "Payment methods",
    empty: "No payment methods yet - they appear as you confirm receipts.",
  },
] as const satisfies readonly {
  field: OptionField;
  key: keyof Pick<ReceiptOptions, "vendors" | "categories" | "paymentMethods">;
  title: string;
  empty: string;
}[];

export type OptionListSpec = (typeof OPTION_LISTS)[number];

/** The field as it reads inside a sentence ("the payment-method list"). */
export function optionFieldNoun(field: OptionField): string {
  switch (field) {
    case "vendor":
      return "vendor";
    case "category":
      return "category";
    case "paymentMethod":
      return "payment method";
  }
}

/**
 * Whether an inline rename is worth sending, and what it would do.
 *
 * The typed target is TRIMMED, matching what every other free-text box in
 * this client does on save (`assignText`, ReceiptForm.tsx) - a trailing
 * space picked up while typing a replacement is a slip, not a value someone
 * meant. That is not a retreat from the 2026-08-26 "free text is never
 * normalized" ruling: the value being renamed FROM is passed through
 * untouched and matched exactly, so a stray-space value that already exists
 * is still reachable, still distinct, and still renameable - which is one
 * of the things this screen is for.
 *
 * `merges` is true when the target is already one of the person's values.
 * Allowed on purpose - collapsing "Food basics" into "Food Basics" is the
 * commonest reason to rename at all - but surfaced, because it is the one
 * rename that makes a list entry disappear as well as change.
 */
export type RenameValidation =
  | { state: "ready"; to: string; merges: boolean }
  | { state: "blank" }
  | { state: "unchanged" };

export function validateRename(
  from: string,
  to: string,
  existing: readonly string[],
): RenameValidation {
  const trimmed = to.trim();
  if (trimmed === "") {
    // Deliberately not treated as "delete it": clearing the box is how a
    // rename gets abandoned, and a blank rename that silently deleted the
    // value would be the most destructive possible reading of an empty
    // input.
    return { state: "blank" };
  }
  if (trimmed === from) {
    return { state: "unchanged" };
  }
  return { state: "ready", to: trimmed, merges: existing.includes(trimmed) };
}

/** What a completed rename reports back - the server's own count, in
 * words, because "12 receipts updated" and "0" are different events and
 * the person just caused one of them. */
export function renameResultMessage(
  from: string,
  to: string,
  receiptsUpdated: number,
): string {
  const receipts =
    receiptsUpdated === 0
      ? "No receipts carried it"
      : receiptsUpdated === 1
        ? "1 receipt updated"
        : `${receiptsUpdated} receipts updated`;
  return `Renamed “${from}” to “${to}”. ${receipts}.`;
}

/**
 * The delete confirmation. It states what survives, in the same breath as
 * what goes: this removes a SUGGESTION, and every receipt keeps the words
 * on it. A confirmation that said only "remove this value?" would be read
 * by a reasonable person as "erase it from my records", which is the one
 * thing it does not do.
 */
export function deleteConfirmText(field: OptionField, value: string): string {
  return `Remove “${value}” from the ${optionFieldNoun(field)} list? Receipts that use it keep the text - only the suggestion goes.`;
}

export function deleteResultMessage(value: string): string {
  return `Removed “${value}” from the list. Receipts that used it still say so.`;
}
