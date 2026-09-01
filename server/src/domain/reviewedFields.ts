/**
 * Which fields on a PENDING receipt a human has actually entered or looked
 * at and accepted (2026-09-01).
 *
 * The problem this solves: a pending receipt is a draft the person may come
 * back to on another device, or after the app was killed mid-confirm. Every
 * read path serves `suggestions` alongside the stored row, and both clients
 * prefill an empty field from its suggestion - which is correct for a field
 * nobody has touched, and wrong for one a human already typed. Without this
 * record the server cannot tell the two apart: "the total is 1435 because
 * the parser said so" and "the total is 1435 because a person read the paper
 * and typed it" are the same column value. So the client states which is
 * which, and `mergeSuggestions` serves a reviewed field's suggestion as
 * ABSENT - the row's own value is then the only thing there is to prefill
 * from, which is exactly constraint 2's answer: what a human confirmed wins,
 * and no parser guess may be re-applied over it.
 *
 * It is deliberately a record of REVIEW, not of edit: a person who reads the
 * parser's vendor, agrees with it and moves on has reviewed that field just
 * as much as one who retyped it, and re-suggesting at the next open would
 * make their agreement invisible.
 *
 * The vocabulary is closed and matches the receipt's own editable field
 * names exactly (`http/schemas.ts` validates against it). Free-text values
 * never appear here - these are FIELD NAMES, the same class of thing
 * `domain/userEvents.ts`'s `EVENT_FIELDS` is, and for the same privacy
 * reason: a column that could hold arbitrary client text is a column a
 * receipt's contents leak into.
 *
 * Eight of the ten have a suggestion to suppress (mergedSuggestions.ts
 * maps them; `paymentMethod` and `otherFeesCents` joined with prompt v5,
 * 2026-09-01); the other two - `category`, `notes` - are recorded anyway.
 * A client that reports "the person reviewed the category" is telling the
 * truth about a draft's state, and a vocabulary that accepted only the
 * suggested subset would force clients to
 * decide which truths are worth sending.
 */
export const REVIEWED_FIELDS = [
  "purchasedAt",
  "vendor",
  "subtotalCents",
  "hstCents",
  "tipCents",
  "otherFeesCents",
  "totalCents",
  "category",
  "paymentMethod",
  "notes",
] as const;

export type ReviewedField = (typeof REVIEWED_FIELDS)[number];

/**
 * A set can name each field at most once, so the vocabulary's own size is
 * the bound - restating it as a literal 10 is one field away from being
 * wrong.
 */
export const MAX_REVIEWED_FIELDS = REVIEWED_FIELDS.length;
