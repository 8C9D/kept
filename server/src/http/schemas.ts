import { z } from "zod";
import { InvalidDateError, parseIsoDate } from "../domain/calendarDate.js";
import {
  MAX_STORABLE_CENTS,
  MIN_STORABLE_CENTS,
  cents,
} from "../domain/money.js";
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
const vendor = z.string().min(1).max(200).nullable();
const vendorTaxNumber = z.string().min(1).max(50).nullable();
const subtotalCents = centsSchema.nullable();
const hstCents = centsSchema.nullable();
const otherTaxCents = centsSchema.nullable();
const totalCents = centsSchema;
const currency = z.string().regex(/^[A-Z]{3}$/, {
  error: "must be a three-letter currency code like CAD",
});
const category = z.string().min(1).max(200).nullable();
const paymentMethod = z.string().min(1).max(100).nullable();
const isBusiness = z.boolean();
const notes = z.string().max(5000).nullable();
const ocrRawText = z.string().max(100_000).nullable();

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
 * What the on-device parser suggested, recorded verbatim for the §7.3
 * accuracy measurement. Absent and null both mean "the parser found
 * nothing" - the client sends what it has. Deliberately not strict about
 * having every key so a client with fewer heuristics can still report.
 */
export const ocrSuggestionsSchema = z.strictObject({
  vendor: vendor.optional(),
  purchasedAt: isoDateSchema.nullable().optional(),
  totalCents: centsSchema.nullable().optional(),
  hstCents: hstCents.optional(),
  subtotalCents: subtotalCents.optional(),
  vendorTaxNumber: vendorTaxNumber.optional(),
});

/**
 * Creation. Omitting a nullable field means null; omitting `currency` or
 * `status` means the column default (CAD, pending).
 *
 * `totalCents` and `isBusiness` may be omitted only while the receipt is
 * `pending` (wave 4): a batch-scanned receipt stores what the parser found
 * and states what it did not, and `is_business` still carries no default
 * anywhere (spec §5.2) - a confirmed receipt cannot exist without an
 * explicit choice, which the superRefine below and the database's check
 * constraint both enforce.
 */
export const createReceiptSchema = z
  .strictObject({
    purchasedAt,
    capturedAt,
    vendor: vendor.optional(),
    vendorTaxNumber: vendorTaxNumber.optional(),
    subtotalCents: subtotalCents.optional(),
    hstCents: hstCents.optional(),
    otherTaxCents: otherTaxCents.optional(),
    totalCents: totalCents.nullable().optional(),
    currency: currency.optional(),
    category: category.optional(),
    paymentMethod: paymentMethod.optional(),
    isBusiness: isBusiness.nullable().optional(),
    notes: notes.optional(),
    status: receiptStatusSchema.optional(),
    ocrRawText: ocrRawText.optional(),
    ocrSuggestions: ocrSuggestionsSchema.optional(),
    // The image is uploaded to storage first (spec §6); creating the receipt
    // records where it landed and what it hashed to.
    image: z.strictObject({
      objectKey: z.string().min(1).max(500),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, {
        error: "must be a lowercase hex sha-256 digest",
      }),
    }),
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
    if (body.isBusiness === undefined || body.isBusiness === null) {
      ctx.addIssue({
        code: "custom",
        path: ["isBusiness"],
        message: "a confirmed receipt requires a business-or-personal choice",
      });
    }
  });

/**
 * Update. Every field is optional; an omitted field is left unchanged, an
 * explicit null clears a nullable field. `totalCents` and `isBusiness`
 * accept null only insofar as the receipt stays pending - the route
 * enforces that a receipt ending up confirmed has both, since the rule
 * depends on the row's current values, which a schema cannot see.
 * `ocrSuggestions` is deliberately absent: what the parser said is an
 * immutable record, or the accuracy measurement measures nothing.
 */
export const updateReceiptSchema = z
  .strictObject({
    purchasedAt: purchasedAt.optional(),
    capturedAt: capturedAt.optional(),
    vendor: vendor.optional(),
    vendorTaxNumber: vendorTaxNumber.optional(),
    subtotalCents: subtotalCents.optional(),
    hstCents: hstCents.optional(),
    otherTaxCents: otherTaxCents.optional(),
    totalCents: totalCents.nullable().optional(),
    currency: currency.optional(),
    category: category.optional(),
    paymentMethod: paymentMethod.optional(),
    isBusiness: isBusiness.nullable().optional(),
    notes: notes.optional(),
    status: receiptStatusSchema.optional(),
    ocrRawText: ocrRawText.optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, {
    error: "at least one field must be provided",
  });

export const listReceiptsQuerySchema = z.strictObject({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  isBusiness: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  status: receiptStatusSchema.optional(),
  q: z.string().min(1).max(200).optional(),
  // Backlog imports make lists large on day one; pages are mandatory, with
  // an opaque keyset cursor from the previous page's response.
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

/**
 * The decoded shape of a list cursor: the sort key of the last row of the
 * previous page. Opaque to clients; validated on the way back in because a
 * cursor is still client input.
 */
export const listCursorSchema = z.strictObject({
  purchasedAt: isoDateSchema,
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
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
