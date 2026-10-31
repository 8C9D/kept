import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../../src/db/schema.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * The root fix for the failure domain/suggestedAmounts.ts opens with: a
 * $218.94 Costco receipt stored as $8.50.
 *
 * The merge had already been taught to withhold that $8.50, and it did. But a
 * pending row's columns hold the raw capture-time parse, so a promotion that
 * named no amount wrote nothing and the withheld number became the record
 * anyway. These pin the guard on the pending -> confirmed transition, by the
 * exact body shapes the shipped clients send (web/src/bulkEdit.ts,
 * ios/Kept/Models/ReceiptRequests.swift), and pin that nothing else moved.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;
let shaCounter = 0;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("confirm-guard-user"));
});

/** "TOTAL DISCOUNT(S) $ 8.50" read as the total: only the total goes. */
const TOTAL_MISREAD: OcrFieldSuggestions = {
  vendor: "COSTCO",
  purchasedAt: "2026-03-15",
  totalCents: 850,
  hstCents: 734,
  subtotalCents: 21160,
  tipCents: null,
  otherFeesCents: null,
  paymentMethod: null,
  vendorTaxNumber: null,
};

/** HST of 50% of the subtotal corroborates nothing, so both amounts go. */
const NOTHING_TO_TRUST: OcrFieldSuggestions = {
  ...TOTAL_MISREAD,
  subtotalCents: 2000,
  hstCents: 1000,
  totalCents: 850,
};

const CONSISTENT: OcrFieldSuggestions = {
  ...TOTAL_MISREAD,
  subtotalCents: 10000,
  hstCents: 1300,
  totalCents: 11300,
};

interface ReceiptResponse {
  id: string;
  status: string;
  totalCents: number | null;
  subtotalCents: number | null;
  reviewedFields: string[];
  suggestions: Record<
    string,
    { value: unknown; withheld?: boolean }
  > | null;
}

/** What a capture stores: the parse in the columns, pending. */
async function capture(
  suggestions: OcrFieldSuggestions | null,
  overrides: Record<string, unknown> = {},
): Promise<ReceiptResponse> {
  shaCounter += 1;
  const response = await harness.request(token, "POST", "/api/receipts", {
    ...receiptBody({
      vendor: suggestions?.vendor ?? "Hand Typed",
      subtotalCents: suggestions?.subtotalCents ?? 10000,
      hstCents: suggestions?.hstCents ?? 1300,
      totalCents: suggestions?.totalCents ?? 11300,
      ...(suggestions !== null && { ocrSuggestions: suggestions }),
      ...overrides,
    }),
    image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as ReceiptResponse;
}

function patch(id: string, body: Record<string, unknown>): Promise<Response> {
  return harness.request(token, "PATCH", `/api/receipts/${id}`, body);
}

async function storedRow(id: string) {
  const rows = await harness.db
    .select()
    .from(receipts)
    .where(eq(receipts.id, id));
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Test receipt row is missing");
  }
  return row;
}

async function expectRefused(response: Response): Promise<void> {
  expect(response.status).toBe(409);
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("amounts_need_review");
  // The person has to be told what is wrong and what to do about it.
  expect(body.error.message).toMatch(/didn't add up/);
  expect(body.error.message).toMatch(/enter them from the paper/);
}

describe("confirming a pending receipt whose amounts were withheld", () => {
  it("is what the merge is actually serving for this fixture", async () => {
    // The fixture is the premise of everything below: if the merge stopped
    // withholding this set, every refusal here would be testing nothing.
    const created = await capture(TOTAL_MISREAD);
    expect(created.suggestions?.totalCents).toMatchObject({
      value: null,
      withheld: true,
    });
    expect(created.suggestions?.subtotalCents?.withheld).toBe(false);
    // And the column still holds the number the merge declined to serve.
    expect(created.totalCents).toBe(850);
  });

  it("refuses the web's bulk confirm, which sends status alone", async () => {
    const created = await capture(TOTAL_MISREAD);

    await expectRefused(await patch(created.id, { status: "confirmed" }));

    const row = await storedRow(created.id);
    expect(row.status).toBe("pending");
    expect(row.totalCents).toBe(850);
  });

  it("refuses an iOS swipe, which sends what the row displays and no reviewedFields", async () => {
    const created = await capture(TOTAL_MISREAD);

    // QuickConfirmRequest(displaying:): `displayTotalCents` falls through to
    // the row for a withheld total, so this body carries the $8.50 itself.
    await expectRefused(
      await patch(created.id, {
        purchasedAt: "2026-03-15",
        vendor: "COSTCO",
        subtotalCents: 21160,
        hstCents: 734,
        totalCents: 850,
        status: "confirmed",
      }),
    );

    const row = await storedRow(created.id);
    expect(row.status).toBe("pending");
    expect(row.totalCents).toBe(850);
  });

  it("accepts the form, which names the field a person entered", async () => {
    const created = await capture(TOTAL_MISREAD);

    const response = await patch(created.id, {
      purchasedAt: "2026-03-15",
      vendor: "COSTCO",
      subtotalCents: 21160,
      hstCents: 734,
      tipCents: null,
      otherFeesCents: null,
      totalCents: 21894,
      category: null,
      paymentMethod: null,
      notes: null,
      reviewedFields: ["totalCents"],
      status: "confirmed",
    });

    expect(response.status).toBe(200);
    const row = await storedRow(created.id);
    expect(row.status).toBe("confirmed");
    expect(row.totalCents).toBe(21894);
  });

  it("never judges the VALUE a person entered, only that they entered it", async () => {
    // Constraint 2 cuts both ways (domain/suggestedAmounts.ts): the receipt
    // that really does print an unbalanced set must stay saveable.
    const created = await capture(TOTAL_MISREAD);

    const response = await patch(created.id, {
      totalCents: 850,
      reviewedFields: ["totalCents"],
      status: "confirmed",
    });

    expect(response.status).toBe(200);
    expect((await storedRow(created.id)).totalCents).toBe(850);
  });

  it("requires every withheld field, not just one of them", async () => {
    const created = await capture(NOTHING_TO_TRUST);
    expect(created.suggestions?.totalCents?.withheld).toBe(true);
    expect(created.suggestions?.subtotalCents?.withheld).toBe(true);

    await expectRefused(
      await patch(created.id, {
        totalCents: 2260,
        reviewedFields: ["totalCents"],
        status: "confirmed",
      }),
    );
    expect((await storedRow(created.id)).status).toBe("pending");

    const response = await patch(created.id, {
      totalCents: 2260,
      subtotalCents: 2000,
      reviewedFields: ["totalCents", "subtotalCents"],
      status: "confirmed",
    });
    expect(response.status).toBe(200);
  });

  it("lets a form leave a withheld subtotal blank: clearing it promotes nothing", async () => {
    // The paper has no subtotal printed. Web and iOS both send the blank box
    // as an explicit null and list only what was touched.
    const created = await capture(NOTHING_TO_TRUST);

    const response = await patch(created.id, {
      totalCents: 2260,
      subtotalCents: null,
      reviewedFields: ["totalCents"],
      status: "confirmed",
    });

    expect(response.status).toBe(200);
    const row = await storedRow(created.id);
    expect(row.subtotalCents).toBeNull();
    expect(row.totalCents).toBe(2260);
  });

  it("still answers a null total with the rule about totals, not this guard", async () => {
    const created = await capture(TOTAL_MISREAD);

    const response = await patch(created.id, {
      totalCents: null,
      status: "confirmed",
    });

    expect(response.status).toBe(400);
    expect((await storedRow(created.id)).status).toBe("pending");
  });

  it("judges the merge the client was served, so a PDF's LLM amounts count and a photo's do not", async () => {
    // The reason this asks the merge instead of re-running the arithmetic
    // over the raw records: the same two records merge differently by source.
    const llm = {
      model: "test-model",
      requestedAt: "2026-03-15T18:31:00.000Z",
      suggestions: TOTAL_MISREAD,
    };
    const pdf = await capture(null, { ocrSource: "pdf-text" });
    const photo = await capture(null, { ocrSource: "vision" });
    await harness.db
      .update(receipts)
      .set({ llmSuggestions: llm })
      .where(eq(receipts.id, pdf.id));
    await harness.db
      .update(receipts)
      .set({ llmSuggestions: llm })
      .where(eq(receipts.id, photo.id));

    await expectRefused(await patch(pdf.id, { status: "confirmed" }));
    expect((await patch(photo.id, { status: "confirmed" })).status).toBe(200);
  });

  it("does not refuse a field a person already reviewed in an earlier save", async () => {
    const created = await capture(TOTAL_MISREAD);
    const saved = await patch(created.id, {
      totalCents: 21894,
      reviewedFields: ["totalCents"],
    });
    expect(saved.status).toBe(200);

    // The merge now serves that field absent rather than withheld, so a
    // later bulk confirm promotes what the person typed.
    const response = await patch(created.id, { status: "confirmed" });
    expect(response.status).toBe(200);
    expect((await storedRow(created.id)).totalCents).toBe(21894);
  });
});

describe("everything else PATCH does is unchanged", () => {
  it("confirms a pending receipt with nothing withheld on status alone", async () => {
    const created = await capture(CONSISTENT);
    expect(created.suggestions?.totalCents?.withheld).toBe(false);

    const response = await patch(created.id, { status: "confirmed" });

    expect(response.status).toBe(200);
    expect((await storedRow(created.id)).status).toBe("confirmed");
  });

  it("confirms a receipt no parser ever read on status alone", async () => {
    const created = await capture(null);
    expect(created.suggestions).toBeNull();

    expect((await patch(created.id, { status: "confirmed" })).status).toBe(200);
  });

  it("leaves a receipt already confirmed alone, withheld flag or not", async () => {
    // The merge still flags a confirmed row's suggestions; only the
    // transition is guarded, so a later edit is not re-litigated.
    const created = await capture(TOTAL_MISREAD, { status: "confirmed" });
    expect(created.suggestions?.totalCents?.withheld).toBe(true);

    const edited = await patch(created.id, {
      notes: "corrected later",
      status: "confirmed",
    });
    expect(edited.status).toBe(200);
    expect((await storedRow(created.id)).notes).toBe("corrected later");
  });

  it("lets a save-for-later through: no status, no transition", async () => {
    const created = await capture(TOTAL_MISREAD);

    const response = await patch(created.id, {
      vendor: "Costco Wholesale",
      reviewedFields: ["vendor"],
    });

    expect(response.status).toBe(200);
    const row = await storedRow(created.id);
    expect(row.status).toBe("pending");
    expect(row.vendor).toBe("Costco Wholesale");
  });

  it("still answers a confirm with no total the way it always did", async () => {
    const created = await capture(null, { totalCents: null });

    const response = await patch(created.id, { status: "confirmed" });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("a confirmed receipt requires a total");
  });
});
