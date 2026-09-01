import {
  EVENT_ACTIONS,
  EVENT_FIELDS,
  type EventAction,
  type EventField,
} from "./userEvents.js";
import { mergeSuggestions, type MergedSuggestions } from "./mergedSuggestions.js";
import type { OcrFieldSuggestions, OcrSource } from "./ocrSuggestions.js";

/**
 * The aggregation behind `npm run action-report` (db/actionReport.ts),
 * split out the way parseAccuracy.ts is: the counting logic is pure and
 * unit-testable, and the script that owns the database connection just
 * reads rows and prints what this computes.
 *
 * Two different signals live in the same field, and the report keeps them
 * apart rather than collapsing them into one number:
 *
 *   - `field_edited` is about EDITING BEHAVIOUR: a field a person typed
 *     into, whether or not it ever carried a suggestion (`notes` has no
 *     suggestion to accept or override, but people still edit it).
 *     `editedTotal` sums each event's `count` (a field edited four times
 *     before save logs one event with count 4, not four events) - that is
 *     the number the owner actually asked for.
 *   - `suggestionAccepted` / `suggestionOverridden` are about PARSE
 *     QUALITY: did the person keep what the parser suggested, or replace
 *     it. A field with a high override rate is a field whose extraction is
 *     unreliable in exactly the sense the brief names.
 *
 * Neither substitutes for the other: a field can be edited often without a
 * suggestion existing (typing a category from scratch), and a suggestion
 * can be overridden in a single decisive edit that never fires
 * `field_edited` at all, depending on how a client instruments its form.
 *
 * 2026-08-28 (UX-enhancements proposal #4, approved): two more cuts over
 * the same `field_edited` events, both asked for by name in the owner's
 * original brief for this table -
 *
 *   - `parsePathBreakdown` distinguishes "the total was edited on a
 *     receipt where the heuristic (or the LLM) actually supplied a value"
 *     from "the total was edited on a receipt where NOTHING was
 *     suggested". Only the first case is evidence a parse path is
 *     unreliable; the second is a person typing from scratch, which tells
 *     you nothing about extraction quality and would make it look worse
 *     than it is if lumped in.
 *   - `editHistograms` is the repeat-edit distribution the brief calls out
 *     by name: "a user editing the total amount repeatedly" is a signal a
 *     mean destroys - one receipt edited fifteen times and fifteen
 *     receipts edited once sum to the same total edit count and are
 *     completely different findings.
 */

export interface RawEvent {
  action: EventAction;
  field: EventField | null;
  /** Present only on `field_edited`; null/absent counts as one edit. */
  count: number | null;
  /**
   * The two immutable suggestion records off the receipt this event names
   * (`user_events.receipt_id`), resolved once by the caller - or `undefined`
   * when `receiptId` was null, or named a row this reader could not find.
   * That second case is real and not a bug: `receipt_id` carries no foreign
   * key (spec §5) precisely because the iOS client queues events offline
   * alongside receipts that have not synced yet, or that have since been
   * deleted, so a resolvable id is not guaranteed.
   *
   * Carrying the two raw records rather than a pre-computed "was this field
   * suggested" boolean keeps that rule in exactly one place -
   * `mergeSuggestions`, the same domain function every receipt response
   * already calls to decide what a human saw as a suggestion. A second,
   * ad hoc version of that rule here is exactly the duplication this
   * codebase's review discipline exists to hunt.
   */
  receiptSuggestions?: {
    ocrSuggestions: OcrFieldSuggestions | null;
    llmSuggestions: OcrFieldSuggestions | null;
    /**
     * The receipt's own status and OCR source, which the merge needs to
     * decide what it serves (2026-09-01, mergedSuggestions.ts). Carried
     * for the same reason the two raw records are: so the rule stays in
     * one place instead of being approximated here.
     */
    status: "pending" | "confirmed";
    ocrSource: OcrSource | null;
  };
}

export interface ActionTally {
  action: EventAction;
  count: number;
}

export interface FieldActivity {
  field: EventField;
  /** Number of `field_edited` events logged for this field. */
  editedEvents: number;
  /** Sum of those events' `count` (absent count treated as 1). */
  editedTotal: number;
  suggestionAccepted: number;
  suggestionOverridden: number;
}

/**
 * Which parse path a `field_edited` event landed on, so "edited when the
 * parser supplied something" and "edited when nothing was suggested at
 * all" are never averaged into one number.
 *
 *   - `suggested`: the field's merged suggestion (the same computation
 *     every receipt response serves) carried a value - the heuristic, the
 *     LLM, or both had produced one, and the person changed it anyway.
 *   - `not_suggested`: the receipt is known, but neither parser produced a
 *     value for this field. Editing it is filling a gap, not correcting a
 *     wrong answer.
 *   - `not_parseable`: this EVENT_FIELD has no suggestion field at all
 *     (`category` and `notes` - see `FIELD_SUGGESTION_KEY` below). Every
 *     edit here is a person typing from scratch, by construction, not a
 *     parser being second-guessed. `otherFees` and `paymentMethod` were in
 *     this bucket until 2026-09-01 and are not any more - prompt v5 asks
 *     the model for both, so their edits now classify as `suggested` or
 *     `not_suggested` like every other parseable field. Edits to them
 *     logged before that date will read as `not_suggested`, which is the
 *     true statement about those receipts: no parser produced a value.
 *   - `unknown_receipt`: the event's receipt reference did not resolve
 *     (`RawEvent.receiptSuggestions` is `undefined`) - an offline event
 *     whose receipt has not synced, or has since been deleted. The parse
 *     path is genuinely unknown, which is a different fact from "nothing
 *     was suggested" and must not be counted as either.
 */
export type ParsePath =
  | "suggested"
  | "not_suggested"
  | "not_parseable"
  | "unknown_receipt";

export interface ParsePathActivity {
  field: EventField;
  parsePath: ParsePath;
  editedEvents: number;
  editedTotal: number;
}

/**
 * A small, fixed histogram rather than a mean, on the owner's own reasoning
 * (proposal #4): a mean cannot distinguish "one receipt edited fifteen
 * times" from "fifteen receipts edited once", and the first is the
 * red-flag pattern the whole feature exists to surface. Each bucket counts
 * `field_edited` EVENTS (one save-session's worth of edits to one field on
 * one receipt), not the sum of their `count`s - `fieldActivity.editedTotal`
 * above is where that sum already lives.
 */
export type EditCountBucketLabel = "1" | "2" | "3-5" | "6+";

const EDIT_COUNT_BUCKET_LABELS: readonly EditCountBucketLabel[] = [
  "1",
  "2",
  "3-5",
  "6+",
];

export interface FieldEditHistogram {
  field: EventField;
  buckets: Record<EditCountBucketLabel, number>;
}

export interface ActionReportResult {
  eventCount: number;
  /** Every action in the vocabulary, zero included, most frequent first. */
  actionTallies: ActionTally[];
  /** Every field in the vocabulary, most-edited first. */
  fieldActivity: FieldActivity[];
  /**
   * Only the (field, parsePath) combinations that actually occurred - the
   * cross product is mostly structurally impossible (a `category` edit can
   * never land in `suggested`, since the field has no suggestion at all),
   * so listing every zero combination would be noise rather than a fixed
   * vocabulary worth always showing. Sorted by field, then most-edited
   * parse path first.
   */
  parsePathBreakdown: ParsePathActivity[];
  /**
   * Only for fields with at least one `field_edited` event - a field never
   * edited has no distribution to show. Sorted by field name.
   */
  editHistograms: FieldEditHistogram[];
}

/**
 * Which merged-suggestion key an EVENT_FIELD maps to, when it has one.
 *
 * Two of the ten fields in EVENT_FIELDS have no suggestion field at all:
 * `category` and `notes`, which have never had a parse path of any kind
 * (spec §7.3's heuristics are all money, vendor, or date, and no prompt
 * asks for either). Editing one of those is always a person typing from
 * scratch; there is no parser to have been right or wrong, so it is never
 * worth asking which one supplied it.
 *
 * `otherFees` and `paymentMethod` joined this map on 2026-09-01. The
 * argument that used to exclude them was about the HEURISTIC - no
 * consistent printed label for a fee line, no OCR rule for a card brand -
 * and prompt v5 makes it moot: the model is asked for both, so a merged
 * suggestion for them can exist and this report should say whether it did.
 */
const FIELD_SUGGESTION_KEY: Partial<Record<EventField, keyof MergedSuggestions>> =
  {
    total: "totalCents",
    purchasedAt: "purchasedAt",
    vendor: "vendor",
    hst: "hstCents",
    subtotal: "subtotalCents",
    tip: "tipCents",
    otherFees: "otherFeesCents",
    paymentMethod: "paymentMethod",
  };

function classifyParsePath(
  field: EventField,
  receiptSuggestions: RawEvent["receiptSuggestions"],
): ParsePath {
  const suggestionKey = FIELD_SUGGESTION_KEY[field];
  if (suggestionKey === undefined) {
    return "not_parseable";
  }
  if (receiptSuggestions === undefined) {
    return "unknown_receipt";
  }
  const merged = mergeSuggestions(
    receiptSuggestions.ocrSuggestions,
    receiptSuggestions.llmSuggestions,
    {
      status: receiptSuggestions.status,
      // ⚠ Deliberately empty, and NOT the receipt's stored reviewed set.
      // This report asks what the PARSERS offered for a field a human then
      // edited; the 2026-09-01 suppression rule hides a suggestion for
      // exactly the fields a human has already been through, so passing the
      // real set would answer "not_suggested" for every field this report
      // most wants to count. Suppression governs what a client prefills
      // from, which is not the question here.
      reviewedFields: [],
      ocrSource: receiptSuggestions.ocrSource,
    },
  );
  const value = merged === null ? null : merged[suggestionKey].value;
  return value !== null ? "suggested" : "not_suggested";
}

function editCountBucket(count: number): EditCountBucketLabel {
  if (count <= 1) return "1";
  if (count === 2) return "2";
  if (count <= 5) return "3-5";
  return "6+";
}

export function aggregateActionReport(events: RawEvent[]): ActionReportResult {
  const actionCounts = new Map<EventAction, number>(
    EVENT_ACTIONS.map((action) => [action, 0]),
  );
  const fieldActivity = new Map<EventField, FieldActivity>(
    EVENT_FIELDS.map((field) => [
      field,
      {
        field,
        editedEvents: 0,
        editedTotal: 0,
        suggestionAccepted: 0,
        suggestionOverridden: 0,
      },
    ]),
  );
  const parsePathActivity = new Map<string, ParsePathActivity>();
  const editHistograms = new Map<EventField, Record<EditCountBucketLabel, number>>();

  for (const event of events) {
    actionCounts.set(event.action, (actionCounts.get(event.action) ?? 0) + 1);

    if (event.field === null) {
      continue;
    }
    const activity = fieldActivity.get(event.field);
    if (activity === undefined) {
      // The field vocabulary is closed (EVENT_FIELDS) and the caller reads
      // rows this same process wrote through the validated route; reaching
      // this means the two have drifted apart.
      throw new Error(`No field activity bucket initialized for "${event.field}"`);
    }

    if (event.action === "field_edited") {
      const editCount = event.count ?? 1;
      activity.editedEvents += 1;
      activity.editedTotal += editCount;

      const parsePath = classifyParsePath(event.field, event.receiptSuggestions);
      const key = `${event.field} ${parsePath}`;
      const existingPath = parsePathActivity.get(key);
      if (existingPath === undefined) {
        parsePathActivity.set(key, {
          field: event.field,
          parsePath,
          editedEvents: 1,
          editedTotal: editCount,
        });
      } else {
        existingPath.editedEvents += 1;
        existingPath.editedTotal += editCount;
      }

      let histogram = editHistograms.get(event.field);
      if (histogram === undefined) {
        histogram = { "1": 0, "2": 0, "3-5": 0, "6+": 0 };
        editHistograms.set(event.field, histogram);
      }
      histogram[editCountBucket(editCount)] += 1;
    } else if (event.action === "suggestion_accepted") {
      activity.suggestionAccepted += 1;
    } else if (event.action === "suggestion_overridden") {
      activity.suggestionOverridden += 1;
    }
  }

  const actionTallies = [...actionCounts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));

  const fieldActivityList = [...fieldActivity.values()].sort(
    (a, b) => b.editedTotal - a.editedTotal || a.field.localeCompare(b.field),
  );

  const parsePathBreakdown = [...parsePathActivity.values()].sort(
    (a, b) =>
      a.field.localeCompare(b.field) || b.editedTotal - a.editedTotal,
  );

  const editHistogramList = [...editHistograms.entries()]
    .map(([field, buckets]) => ({ field, buckets }))
    .sort((a, b) => a.field.localeCompare(b.field));

  return {
    eventCount: events.length,
    actionTallies,
    fieldActivity: fieldActivityList,
    parsePathBreakdown,
    editHistograms: editHistogramList,
  };
}

/** The histogram's bucket order, for a caller printing a fixed-width table. */
export { EDIT_COUNT_BUCKET_LABELS };
