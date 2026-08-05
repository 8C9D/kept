import { z } from "zod";
import { InvalidDateError, parseIsoDate } from "../domain/calendarDate.js";
import { cents } from "../domain/money.js";
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
 */
const centsSchema = z
  .number()
  .int({ error: "must be an integer number of cents" })
  .refine(Number.isSafeInteger, { error: "must be an integer number of cents" })
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
 * Creation. Omitting a nullable field means null; omitting `currency` or
 * `status` means the column default (CAD, pending). `isBusiness` and
 * `totalCents` cannot be omitted, and `isBusiness` carries no default here
 * for the same reason the column has none (spec §5.2): absence must be an
 * error, never a quiet choice.
 */
export const createReceiptSchema = z.strictObject({
  purchasedAt,
  capturedAt,
  vendor: vendor.optional(),
  vendorTaxNumber: vendorTaxNumber.optional(),
  subtotalCents: subtotalCents.optional(),
  hstCents: hstCents.optional(),
  otherTaxCents: otherTaxCents.optional(),
  totalCents,
  currency: currency.optional(),
  category: category.optional(),
  paymentMethod: paymentMethod.optional(),
  isBusiness,
  notes: notes.optional(),
  status: receiptStatusSchema.optional(),
  ocrRawText: ocrRawText.optional(),
  // The image is uploaded to storage first (spec §6); creating the receipt
  // records where it landed and what it hashed to.
  image: z.strictObject({
    objectKey: z.string().min(1).max(500),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, {
      error: "must be a lowercase hex sha-256 digest",
    }),
  }),
});

/**
 * Update. Every field is optional; an omitted field is left unchanged, an
 * explicit null clears a nullable field.
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
    totalCents: totalCents.optional(),
    currency: currency.optional(),
    category: category.optional(),
    paymentMethod: paymentMethod.optional(),
    isBusiness: isBusiness.optional(),
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

export const updateMeSchema = z
  .strictObject({
    displayName: z.string().min(1).max(200).nullable().optional(),
    fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
    fiscalYearEndDay: z.number().int().min(1).max(31).optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, {
    error: "at least one field must be provided",
  });
