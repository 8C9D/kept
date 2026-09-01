import { z } from "zod";
import { InvalidDateError, parseIsoDate } from "../domain/calendarDate.js";
import {
  MAX_STORABLE_CENTS,
  MIN_STORABLE_CENTS,
  cents,
} from "../domain/money.js";
import {
  EVENT_ACTIONS,
  EVENT_CLIENTS,
  EVENT_FIELDS,
  isOccurredAtInBounds,
} from "../domain/userEvents.js";
import { OCR_SOURCES } from "../domain/ocrSuggestions.js";
import {
  MAX_REVIEWED_FIELDS,
  REVIEWED_FIELDS,
} from "../domain/reviewedFields.js";
import { receiptStatus } from "../db/schema.js";

/**
 * Request schemas for every route, in one place so the API surface reads in
 * one sitting. All object schemas are strict: an unexpected key - notably
 * any attempt to pass a user id - is a 400, not something silently ignored.
 */

/**
 * Money arrives as integer cents; 42.5 is a validation error, not rounded.
 * The transform brands the validated number as Cents, so everything past
 * this boundary carries the domain's money type.
 *
 * The range bounds come from the domain rather than being restated here:
 * `cents()` throws outside them, and a boundary that stops short of what
 * the layer behind it accepts is not a boundary. Stating them as zod checks
 * is what turns that throw into a 400 naming the field instead of a 500.
 */
const centsSchema = z
  .number()
  .int({ error: "must be an integer number of cents" })
  .refine(Number.isSafeInteger, { error: "must be an integer number of cents" })
  .min(MIN_STORABLE_CENTS, { error: "is outside the storable amount range" })
  .max(MAX_STORABLE_CENTS, { error: "is outside the storable amount range" })
  .transform(cents);

/** yyyy-mm-dd and a real calendar date (2026-02-30 is rejected). */
const isoDateSchema = z.string().refine(
  (value) => {
    try {
      parseIsoDate(value);
      return true;
    } catch (error) {
      if (error instanceof InvalidDateError) {
        return false;
      }
      throw error;
    }
  },
  { error: "must be a valid yyyy-mm-dd date" },
);

// Derived from the database enum so the two can never disagree.
const receiptStatusSchema = z.enum(receiptStatus.enumValues);

/**
 * One definition per receipt field, shared by the create and update schemas
 * below so the two can never drift apart.
 */
const purchasedAt = isoDateSchema;
const capturedAt = z.iso.datetime({ offset: true });
const vendorText = z.string().min(1).max(200);
const vendor = vendorText.nullable();
const subtotalCents = centsSchema.nullable();
const hstCents = centsSchema.nullable();
// Gratuity and every other non-HST, non-subtotal charge (delivery, service
// charges, bottle deposits, a foreign receipt's state sales tax), added
// 2026-08-28 as two fields rather than the one lumped `other_tax_cents`
// column the 2026-08-26 field reduction removed. Nullable like every other
// money field: absent means "no such line on this receipt".
const tipCents = centsSchema.nullable();
const otherFeesCents = centsSchema.nullable();
const totalCents = centsSchema;
const currency = z.string().regex(/^[A-Z]{3}$/, {
  error: "must be a three-letter currency code like CAD",
});
const category = z.string().min(1).max(200).nullable();
const paymentMethod = z.string().min(1).max(100).nullable();
const notes = z.string().max(5000).nullable();
const ocrRawText = z.string().max(100_000).nullable();

/**
 * Which fields a human has entered or explicitly reviewed on a still-pending
 * receipt (2026-09-01; domain/reviewedFields.ts carries the reasoning).
 *
 * A closed `z.enum`, never a free string, for exactly the reason
 * `userEventSchema`'s `action`/`field` are: this is a list of FIELD NAMES,
 * and a schema that accepted arbitrary text is a schema a receipt's contents
 * can leak through. An unknown name is a 400, not something silently kept.
 *
 * Deduplicated here rather than left to the writer: a client that reports
 * the same field twice means the same thing as one that reports it once, and
 * a stored array with duplicates would make every later reader defensive.
 * The `.max()` runs BEFORE the dedupe, on the array as sent - a client that
 * sends fifty entries is malfunctioning, and quietly collapsing that to a
 * legal set would hide it.
 */
const reviewedFields = z
  .array(z.enum(REVIEWED_FIELDS))
  .max(MAX_REVIEWED_FIELDS)
  .transform((fields) => [...new Set(fields)]);

/**
 * Where `ocrRawText` came from - a photo's OCR or a PDF's text layer. The
 * merge treats the two differently for money fields only
 * (domain/mergedSuggestions.ts).
 */
const ocrSource = z.enum(OCR_SOURCES);

/**
 * Still a stored field on `ocr_suggestions`, which is an immutable record of
 * what a parser said and keeps whatever keys the client of the day sent -
 * see `ocrSuggestionsSchema` below. No receipt column carries it any more.
 */
const vendorTaxNumber = z.string().min(1).max(50).nullable();

/**
 * ⚠ TRANSITIONAL (2026-08-26 field reduction). The shipped iOS build
 * 1.0 (1) sends `vendorTaxNumber`, `otherTaxCents` and `isBusiness` on both
 * create and PATCH - the PATCH with explicit nulls - and every schema here
 * is strict, so refusing the keys would 400 every save the second user's installed build
 * makes. They are accepted with their old value types and DISCARDED: no
 * column exists for them and neither route's field map names them.
 *
 * Removal trigger: when no installed build sends them. Deleting these three
 * lines from both schemas is the whole removal.
 *
 * ⚠ `otherTaxCents` is NOT the same field as the new `otherFeesCents` below,
 * and must not be quietly routed into it (or into `tipCents`). This is a
 * discarded legacy key from build 1.0 (1) with different, lumped semantics
 * (tips and non-HST amounts folded into one number); `otherFeesCents` is a
 * 2026-08-28 field with its own, narrower meaning (everything that is
 * neither subtotal, HST, nor tip). Feeding one into the other would invent
 * data no human confirmed - exactly what constraint 2 forbids.
 */
const retiredReceiptFields = {
  vendorTaxNumber: vendorTaxNumber.optional(),
  otherTaxCents: centsSchema.nullable().optional(),
  isBusiness: z.boolean().nullable().optional(),
};

export const appleSignInSchema = z.strictObject({
  identityToken: z.string().min(1),
  // Apple provides the person's name only on first authorization, and only
  // to the client; the client passes it along when it has it.
  displayName: z.string().min(1).max(200).optional(),
});

export const uploadUrlSchema = z.strictObject({
  contentType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
});

/**
 * One image's storage location and integrity check, in the exact shape
 * `POST /api/receipts/upload-url` issues. Every route that attaches bytes
 * to a receipt validates this same shape: the create route's `image` key,
 * `POST /api/receipts/:id/images` (add a page, proposal #6, 2026-08-28) and
 * `PUT /api/receipts/:id/images/:page` (replace a page, same proposal).
 * Defined once so the objectKey/sha256 regex cannot drift between them.
 */
export const receiptImageSchema = z.strictObject({
  objectKey: z.string().min(1).max(500),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, {
    error: "must be a lowercase hex sha-256 digest",
  }),
});

/**
 * What the on-device parser suggested, recorded verbatim for the §7.3
 * accuracy measurement. Absent and null both mean "the parser found
 * nothing" - the client sends what it has. Deliberately not strict about
 * having every key so a client with fewer heuristics can still report.
 *
 * `vendorTaxNumber` outlived the receipt column it used to feed (2026-08-26):
 * this is a verbatim record of what a parser said, old clients still extract
 * one, and rewriting what they reported would corrupt the §7.3 measurement.
 */
export const ocrSuggestionsSchema = z.strictObject({
  vendor: vendor.optional(),
  purchasedAt: isoDateSchema.nullable().optional(),
  totalCents: centsSchema.nullable().optional(),
  hstCents: hstCents.optional(),
  subtotalCents: subtotalCents.optional(),
  // An amount like the other three, so it gets a suggestion field on the
  // same terms (2026-08-28: the on-device parser will start reporting one).
  tipCents: centsSchema.nullable().optional(),
  // Prompt v5's two new suggestion fields (2026-09-01). Optional like every
  // key here, which is what keeps the shipped iOS build working unchanged:
  // 1.0 (4) has no heuristic for either and sends neither, and a stored
  // record that omits them says the same thing a null does - the parser of
  // the day found nothing.
  otherFeesCents: centsSchema.nullable().optional(),
  paymentMethod: paymentMethod.optional(),
  vendorTaxNumber: vendorTaxNumber.optional(),
});

/**
 * `POST /api/receipts/parse` (2026-09-01) - the capture-time parse the iOS
 * confirm screen calls fire-and-forget while the person is still looking at
 * the receipt.
 *
 * Only the two things the parse actually needs: the text, and the day it
 * was captured (which is what bounds the purchase date - see
 * `parse/claudeReceiptParser.ts`). Deliberately NOT a receipt id: this route
 * writes nothing and reads no row, so there is no receipt for it to be
 * about, and taking an id would invite exactly the second write path §7.3's
 * immutability clause exists to prevent.
 *
 * `ocrRawText` is bounded by the same 100 000 characters the create route's
 * column-bound field uses, and non-empty because parsing nothing is not a
 * request anyone means to make.
 */
export const parseOcrTextSchema = z.strictObject({
  ocrRawText: z.string().min(1).max(100_000),
  capturedAt,
});

/**
 * Creation. Omitting a nullable field means null; omitting `currency` or
 * `status` means the column default (CAD, pending).
 *
 * `totalCents` may be omitted only while the receipt is `pending` (wave 4):
 * a batch-scanned receipt stores what the parser found and states what it
 * did not. A confirmed receipt cannot exist without a total, which the
 * superRefine below and the database's check constraint both enforce.
 */
export const createReceiptSchema = z
  .strictObject({
    purchasedAt,
    capturedAt,
    vendor: vendor.optional(),
    subtotalCents: subtotalCents.optional(),
    hstCents: hstCents.optional(),
    tipCents: tipCents.optional(),
    otherFeesCents: otherFeesCents.optional(),
    totalCents: totalCents.nullable().optional(),
    currency: currency.optional(),
    category: category.optional(),
    paymentMethod: paymentMethod.optional(),
    notes: notes.optional(),
    status: receiptStatusSchema.optional(),
    ocrRawText: ocrRawText.optional(),
    ocrSource: ocrSource.optional(),
    ocrSuggestions: ocrSuggestionsSchema.optional(),
    reviewedFields: reviewedFields.optional(),
    ...retiredReceiptFields,
    // The image is uploaded to storage first (spec §6); creating the receipt
    // records where it landed and what it hashed to.
    image: receiptImageSchema,
  })
  .superRefine((body, ctx) => {
    if (body.status !== "confirmed") {
      return;
    }
    if (body.totalCents === undefined || body.totalCents === null) {
      ctx.addIssue({
        code: "custom",
        path: ["totalCents"],
        message: "a confirmed receipt requires a total",
      });
    }
  });

/**
 * Update. Every field is optional; an omitted field is left unchanged, an
 * explicit null clears a nullable field. `totalCents` accepts null only
 * insofar as the receipt stays pending - the route enforces that a receipt
 * ending up confirmed has one, since the rule depends on the row's current
 * values, which a schema cannot see. `ocrSuggestions` is deliberately
 * absent: what the parser said is an immutable record, or the accuracy
 * measurement measures nothing.
 */
export const updateReceiptSchema = z
  .strictObject({
    purchasedAt: purchasedAt.optional(),
    capturedAt: capturedAt.optional(),
    vendor: vendor.optional(),
    subtotalCents: subtotalCents.optional(),
    hstCents: hstCents.optional(),
    tipCents: tipCents.optional(),
    otherFeesCents: otherFeesCents.optional(),
    totalCents: totalCents.nullable().optional(),
    currency: currency.optional(),
    category: category.optional(),
    paymentMethod: paymentMethod.optional(),
    notes: notes.optional(),
    status: receiptStatusSchema.optional(),
    ocrRawText: ocrRawText.optional(),
    // Replaces the stored set outright rather than merging into it: the
    // client sends the full set it knows about, and a server-side union
    // would make un-reviewing a field (the person cleared it and wants the
    // parser's guess offered again) impossible to express.
    reviewedFields: reviewedFields.optional(),
    ...retiredReceiptFields,
  })
  .refine((fields) => Object.keys(fields).length > 0, {
    error: "at least one field must be provided",
  });

/**
 * How a list page is ordered. `purchasedAt` is the receipt date and the
 * default: a list of receipts is a list of purchases, not of scans.
 */
export const listSortSchema = z.enum([
  "purchasedAt",
  "capturedAt",
  "total",
  "vendor",
]);
export const listOrderSchema = z.enum(["asc", "desc"]);

/**
 * The filter parameters GET /api/receipts and GET /api/receipts/summary
 * (proposal #3, 2026-08-28) accept identically. Defined once, in one strict
 * schema, so the two routes can never validate two different sets of query
 * keys - `routes/receipts.ts`'s `buildReceiptFilterConditions` turns this
 * same parsed shape into WHERE conditions for both, which is the other half
 * of that guarantee: one filter implementation, not two that can disagree.
 *
 * Exact-match over the stored free text (`category`, `paymentMethod`),
 * case-sensitive and unnormalized: these pair with GET /api/receipts/options,
 * which serves the user's own values verbatim, so anything else would
 * refuse to match what it offered.
 */
export const receiptFilterQuerySchema = z.strictObject({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  status: receiptStatusSchema.optional(),
  category: z.string().min(1).max(200).optional(),
  paymentMethod: z.string().min(1).max(100).optional(),
  q: z.string().min(1).max(200).optional(),
});

/**
 * The list adds sorting and paging on top of the shared filter above -
 * summary has neither: an aggregate has no pages and no order to render
 * rows in.
 */
export const listReceiptsQuerySchema = receiptFilterQuerySchema.extend({
  sort: listSortSchema.optional(),
  order: listOrderSchema.optional(),
  // Backlog imports make lists large on day one; pages are mandatory, with
  // an opaque keyset cursor from the previous page's response.
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

/**
 * The decoded shape of a list cursor: everything needed to resume the same
 * total order after the last row of the previous page. Opaque to clients;
 * validated on the way back in because a cursor is still client input.
 *
 * It carries the sort it was minted under so a cursor cannot be replayed
 * against a different ordering - the keyset comparison would silently
 * return the wrong slice, which is worse than refusing.
 *
 * `sortKey` is the value of the sorted column on that last row, rendered as
 * the string Postgres compares it as (a date, an ISO timestamp, an integer's
 * digits, a vendor name); `sortKeyNull` records that the row had none, since
 * null-keyed rows sort last and are compared by the tiebreak alone.
 */
/**
 * What a cursor's `sortKey` must look like for each sort, because the route
 * casts it back to the sorted column's own type inside the query
 * (`::date`, `::timestamptz`, `::integer`). Postgres is where an uncastable
 * string would otherwise be caught, and it catches it as a failed SELECT
 * mid-request - a 500 for what is client input. The bounds are the
 * columns' own, reused rather than restated.
 */
const cursorSortKeyFormats = {
  purchasedAt: isoDateSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  // Digits first so `Number()` cannot quietly accept "1e9", " 12" or "0x10",
  // then the same storable-cents range every money field is held to.
  total: z
    .string()
    .regex(/^-?\d+$/, { error: "must be an integer number of cents" })
    .transform(Number)
    .pipe(centsSchema),
  vendor: vendorText,
} as const satisfies Record<z.infer<typeof listSortSchema>, z.ZodType>;

export const listCursorSchema = z
  .strictObject({
    sort: listSortSchema,
    order: listOrderSchema,
    sortKeyNull: z.boolean(),
    sortKey: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .superRefine((cursor, ctx) => {
    // The null rank is stated as well as implied by the key, so the encoded
    // cursor describes its own place in the ordering. A hand-crafted one
    // that answered "did that row have a value?" twice, differently, would
    // reach the keyset comparison as a contradiction.
    if (cursor.sortKeyNull !== (cursor.sortKey === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["sortKeyNull"],
        message: "must agree with sortKey",
      });
      return;
    }
    if (cursor.sortKey === null) {
      return;
    }
    // A cursor is client input like any other, and "opaque" is a promise to
    // the client, not an exemption from validation: the key is parsed to
    // the shape its own sort will cast it to, here, where the answer is a
    // 400 rather than a failed statement.
    const format = cursorSortKeyFormats[cursor.sort].safeParse(cursor.sortKey);
    if (!format.success) {
      ctx.addIssue({
        code: "custom",
        path: ["sortKey"],
        message: `is not a valid ${cursor.sort} sort key`,
      });
    }
  });

/**
 * GET /api/receipts/possible-duplicates - proposal #8 (2026-08-28): does the
 * caller already have a live receipt on this date, for this total, from
 * (roughly) this vendor? All three arrive as query parameters like every
 * other GET filter in this file, so `totalCents` needs the same string-to-
 * cents translation `cursorSortKeyFormats.total` above uses for a cursor's
 * sort key - digits first so `Number()` cannot quietly accept "1e9", " 12"
 * or "0x10", then piped through the same storable-cents schema every
 * request BODY money field uses - rather than the JSON-number `centsSchema`
 * itself, which a query string (no number type) cannot satisfy directly.
 *
 * `vendor` is optional, and its ABSENCE is a deliberate value read by the
 * route as "compare against no vendor" (routes/receipts.ts's
 * possible-duplicates handler decides a null vendor matches a null vendor,
 * with the reasoning in that route's own comment), not as "ignore vendor
 * entirely".
 *
 * `excludeId` lets a caller confirming an already-created pending receipt
 * ask "does anything ELSE match" instead of matching itself.
 */
export const possibleDuplicatesQuerySchema = z.strictObject({
  purchasedAt: isoDateSchema,
  totalCents: z
    .string()
    .regex(/^-?\d+$/, { error: "must be an integer number of cents" })
    .transform(Number)
    .pipe(centsSchema),
  vendor: vendorText.optional(),
  excludeId: z.uuid().optional(),
});

/**
 * The three fields `GET /api/receipts/options` serves, spelled the way the
 * wire spells everything else - camelCase - and the vocabulary the
 * `:field` path parameter of the rename and delete routes is checked
 * against. `domain/receiptFieldOptions.ts` holds the STORED spelling
 * (`payment_method`); routes/receipts.ts owns the one-line translation
 * between them.
 */
export const receiptOptionFieldSchema = z.enum([
  "vendor",
  "category",
  "paymentMethod",
]);

export type ReceiptOptionApiField = z.infer<typeof receiptOptionFieldSchema>;

/**
 * `PATCH /api/receipts/options/:field` (2026-09-01) - rename one stored
 * value everywhere it appears, both in the option list and on every receipt
 * carrying it.
 *
 * One schema per field rather than one shared schema, because `to` becomes
 * the value of a receipt column and must be held to that column's own limit:
 * 200 characters for vendor and category, 100 for payment method, reusing
 * the same definitions the create and update schemas above use. A boundary
 * that stops short of what the layer behind it accepts is not a boundary -
 * the reasoning `centsSchema` states for money, applied to text.
 *
 * ⚠ `from` is NOT trimmed and must not become so. It names a value that is
 * already stored, verbatim, doubled spaces and all (the 2026-08-26 free-text
 * ruling, and the second user's "  Office   Supplies  " is the actual row this protects):
 * trimming it would make exactly the values most in need of a rename the ones
 * that cannot be renamed.
 *
 * `to` IS trimmed, deliberately and asymmetrically. It is new text a person
 * just typed into a rename box, where leading and trailing whitespace is an
 * accident of the keyboard rather than a value anyone means - and unlike the
 * options list, which must echo what is stored or its own exact-match filter
 * stops finding it, this is an explicit edit whose result the person sees
 * immediately. A whitespace-only rename target is refused rather than
 * silently accepted as an empty label.
 */
function renameOptionSchema(maxLength: number) {
  return z.strictObject({
    from: z.string().min(1).max(maxLength),
    to: z.string().trim().min(1).max(maxLength),
  });
}

export const renameReceiptOptionSchemas = {
  vendor: renameOptionSchema(200),
  category: renameOptionSchema(200),
  paymentMethod: renameOptionSchema(100),
} as const satisfies Record<ReceiptOptionApiField, z.ZodType>;

/**
 * `DELETE /api/receipts/options/:field?value=<string>` (2026-09-01) - forget
 * one offered value. The value arrives as a query parameter because a DELETE
 * carries no body in this API; it is the stored string verbatim, so it is
 * bounded but never trimmed, exactly like `from` above.
 */
export const deleteReceiptOptionQuerySchema = z.strictObject({
  value: z.string().min(1).max(200),
});

/**
 * Two ways to name an export period (spec §8, §12): a fiscal year - the
 * server derives the dates from the user's configured year end at request
 * time - or an explicit date range (the seam a future quarterly picker
 * uses).
 */
export const exportRequestSchema = z.union([
  z.strictObject({
    fiscalYearEndingIn: z.number().int().min(2000).max(2100),
  }),
  z
    .strictObject({
      periodStart: isoDateSchema,
      periodEnd: isoDateSchema,
    })
    .refine((period) => period.periodStart <= period.periodEnd, {
      error: "periodStart must not be after periodEnd",
    }),
]);

export const updateMeSchema = z
  .strictObject({
    displayName: z.string().min(1).max(200).nullable().optional(),
    fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
    fiscalYearEndDay: z.number().int().min(1).max(31).optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, {
    error: "at least one field must be provided",
  });

/**
 * Account deletion. Every field is optional and there is deliberately no
 * "confirm": true flag - a DELETE on your own account IS the confirmation,
 * and the place a person is asked whether they mean it is the client's
 * dialog, where they can read what happens.
 *
 * `appleAuthorizationCode` is a fresh, single-use code (Apple's own bound:
 * five minutes, one use) from a Sign in with Apple re-authorization the
 * client runs at deletion time, so the server can revoke the person's Apple
 * tokens. Optional because a client that cannot mint one - the web client,
 * which does not run the native flow - must still be able to delete the
 * account: Apple's own guidance is that the deletion is fulfilled either
 * way, and the omission is stated in the log rather than passed over.
 *
 * ⚠ Strict, like every schema here, and that is what refuses a user id: an
 * account deletion is the most attractive place there is to smuggle one in,
 * and the session token remains the only thing that says whose account this
 * is (spec §6).
 */
export const deleteMeSchema = z.strictObject({
  appleAuthorizationCode: z.string().min(1).max(2000).optional(),
});

/**
 * POST /api/events - fire-and-forget behavioural telemetry (the owner's
 * 2026-08-28 ask; domain/userEvents.ts carries the full reasoning).
 *
 * `action` and `field` are validated against the fixed vocabularies with
 * `z.enum`, never accepted as free strings - that is what makes "no field
 * values, ever" a structural guarantee instead of a convention someone has
 * to remember to keep. There is deliberately no payload/meta/properties key
 * here, matching the column that stores it (schema.ts, user_events): a
 * free-form bag is exactly where a value would leak in six months, and a
 * schema that cannot express one cannot leak one.
 *
 * `userId` is named nowhere in this schema, on purpose - the most
 * attractive place in the whole API to smuggle one in is a batch write, and
 * `strictObject` refuses the key with a 400 rather than silently ignoring
 * or trusting it (spec §6: "An endpoint that accepts a user id as a
 * parameter is a bug").
 */
const eventOccurredAt = z.iso.datetime({ offset: true }).refine(
  (value) => isOccurredAtInBounds(new Date(value)),
  { error: "occurredAt is outside the accepted range" },
);

/**
 * `durationMs` and `count` share a shape: non-negative, and bounded to what
 * the `integer` (int4) columns that store them can hold - the same reason
 * `centsSchema` above states the storable range as a zod check rather than
 * letting an out-of-range insert fail as a 500.
 */
const nonNegativeStorableInt = z
  .number()
  .int({ error: "must be an integer" })
  .min(0, { error: "must not be negative" })
  .max(MAX_STORABLE_CENTS, { error: "is outside the storable range" });

export const userEventSchema = z.strictObject({
  action: z.enum(EVENT_ACTIONS),
  occurredAt: eventOccurredAt,
  client: z.enum(EVENT_CLIENTS),
  appVersion: z.string().min(1).max(40).optional(),
  field: z.enum(EVENT_FIELDS).optional(),
  // No foreign key on the stored column (schema.ts) and none of the
  // validation here either, beyond "is a uuid": a receipt id naming a
  // receipt that never synced, or was since deleted, is accepted -
  // refusing it would turn a fire-and-forget log write into a failure
  // over a receipt the log does not even need to resolve.
  receiptId: z.uuid().optional(),
  durationMs: nonNegativeStorableInt.optional(),
  count: nonNegativeStorableInt.optional(),
});

/**
 * Batched: the iOS client is offline-first and syncs a queue, not one event
 * at a time. 1-50 per request - at least one (an empty batch is not a
 * request worth making), at most 50 (this is fire-and-forget telemetry, not
 * a bulk-import endpoint; a client with more than 50 queued should send
 * more than one request rather than one unbounded one).
 */
export const postEventsSchema = z.strictObject({
  events: z.array(userEventSchema).min(1).max(50),
});
