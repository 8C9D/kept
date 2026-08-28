import { describe, expect, it } from "vitest";
import {
  aggregateActionReport,
  type RawEvent,
} from "../../src/domain/actionReport.js";
import { EVENT_ACTIONS, EVENT_FIELDS } from "../../src/domain/userEvents.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";

function event(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    action: "field_edited",
    field: "total",
    count: null,
    ...overrides,
  };
}

/** A suggestion record with every field null, overridden per test. */
function suggestions(
  overrides: Partial<OcrFieldSuggestions> = {},
): OcrFieldSuggestions {
  return {
    vendor: null,
    purchasedAt: null,
    totalCents: null,
    hstCents: null,
    subtotalCents: null,
    tipCents: null,
    vendorTaxNumber: null,
    ...overrides,
  };
}

describe("aggregateActionReport", () => {
  it("returns every action and field, zeroed, over no events", () => {
    const result = aggregateActionReport([]);
    expect(result.eventCount).toBe(0);
    expect(result.actionTallies).toHaveLength(EVENT_ACTIONS.length);
    expect(result.actionTallies.every((t) => t.count === 0)).toBe(true);
    expect(result.fieldActivity).toHaveLength(EVENT_FIELDS.length);
    expect(
      result.fieldActivity.every(
        (f) =>
          f.editedEvents === 0 &&
          f.editedTotal === 0 &&
          f.suggestionAccepted === 0 &&
          f.suggestionOverridden === 0,
      ),
    ).toBe(true);
  });

  it("sums field_edited's count rather than counting one edit per event", () => {
    const result = aggregateActionReport([
      event({ field: "total", count: 4 }),
      event({ field: "total", count: 2 }),
    ]);
    const total = result.fieldActivity.find((f) => f.field === "total");
    expect(total?.editedEvents).toBe(2);
    expect(total?.editedTotal).toBe(6);
  });

  it("treats an absent count as a single edit", () => {
    const result = aggregateActionReport([event({ field: "vendor", count: null })]);
    const vendor = result.fieldActivity.find((f) => f.field === "vendor");
    expect(vendor?.editedEvents).toBe(1);
    expect(vendor?.editedTotal).toBe(1);
  });

  it("tallies suggestion_accepted and suggestion_overridden separately from field_edited", () => {
    const result = aggregateActionReport([
      event({ action: "suggestion_accepted", field: "hst", count: null }),
      event({ action: "suggestion_overridden", field: "hst", count: null }),
      event({ action: "suggestion_overridden", field: "hst", count: null }),
    ]);
    const hst = result.fieldActivity.find((f) => f.field === "hst");
    expect(hst?.suggestionAccepted).toBe(1);
    expect(hst?.suggestionOverridden).toBe(2);
    expect(hst?.editedEvents).toBe(0);
  });

  it("counts every action, including ones with no field", () => {
    const result = aggregateActionReport([
      event({ action: "sign_in", field: null, count: null }),
      event({ action: "sign_in", field: null, count: null }),
      event({ action: "export_requested", field: null, count: null }),
    ]);
    const signIn = result.actionTallies.find((t) => t.action === "sign_in");
    const exportRequested = result.actionTallies.find(
      (t) => t.action === "export_requested",
    );
    expect(signIn?.count).toBe(2);
    expect(exportRequested?.count).toBe(1);
    expect(result.eventCount).toBe(3);
  });

  it("orders field activity by total edits, most-edited first", () => {
    const result = aggregateActionReport([
      event({ field: "total", count: 5 }),
      event({ field: "vendor", count: 1 }),
    ]);
    expect(result.fieldActivity[0]?.field).toBe("total");
    expect(
      result.fieldActivity.findIndex((f) => f.field === "vendor"),
    ).toBeGreaterThan(0);
  });

  it("orders action tallies by count, most frequent first", () => {
    const result = aggregateActionReport([
      event({ action: "sign_in", field: null }),
      event({ action: "receipt_viewed", field: null }),
      event({ action: "receipt_viewed", field: null }),
      event({ action: "receipt_viewed", field: null }),
    ]);
    expect(result.actionTallies[0]?.action).toBe("receipt_viewed");
    expect(result.actionTallies[0]?.count).toBe(3);
  });
});

/**
 * 2026-08-28 (UX-enhancements proposal #4): breaking field_edited events
 * down by parse path - was something actually suggested for this field on
 * this receipt, or not.
 */
describe("aggregateActionReport - parse path breakdown", () => {
  it("classifies an edit as 'suggested' when the heuristic supplied a value", () => {
    const result = aggregateActionReport([
      event({
        field: "total",
        receiptSuggestions: {
          ocrSuggestions: suggestions({ totalCents: 1199 }),
          llmSuggestions: null,
        },
      }),
    ]);
    const row = result.parsePathBreakdown.find(
      (r) => r.field === "total" && r.parsePath === "suggested",
    );
    expect(row?.editedEvents).toBe(1);
  });

  it("classifies an edit as 'suggested' when only the LLM supplied a value (vendor's fallthrough)", () => {
    // Vendor's merge rule (mergedSuggestions.ts) falls through to the LLM
    // when the heuristic found nothing - this is a genuine suggestion the
    // person saw and changed, not an absence.
    const result = aggregateActionReport([
      event({
        field: "vendor",
        receiptSuggestions: {
          ocrSuggestions: suggestions({ vendor: null }),
          llmSuggestions: suggestions({ vendor: "Loblaws" }),
        },
      }),
    ]);
    const row = result.parsePathBreakdown.find(
      (r) => r.field === "vendor" && r.parsePath === "suggested",
    );
    expect(row?.editedEvents).toBe(1);
  });

  it("classifies an edit as 'not_suggested' when the receipt is known but neither parser produced a value", () => {
    const result = aggregateActionReport([
      event({
        field: "hst",
        receiptSuggestions: {
          ocrSuggestions: suggestions(),
          llmSuggestions: suggestions(),
        },
      }),
    ]);
    const row = result.parsePathBreakdown.find(
      (r) => r.field === "hst" && r.parsePath === "not_suggested",
    );
    expect(row?.editedEvents).toBe(1);
  });

  it("classifies an edit as 'unknown_receipt' when the event's receipt reference did not resolve", () => {
    // The weak reference (spec §5, user_events.receipt_id has no foreign
    // key): an offline event can legitimately name a receipt that has not
    // synced yet, or has since been deleted.
    const result = aggregateActionReport([
      event({ field: "subtotal", receiptSuggestions: undefined }),
    ]);
    const row = result.parsePathBreakdown.find(
      (r) => r.field === "subtotal" && r.parsePath === "unknown_receipt",
    );
    expect(row?.editedEvents).toBe(1);
  });

  it("classifies every edit to a field with no suggestion path as 'not_parseable', even with a resolved receipt", () => {
    // otherFees, category, paymentMethod and notes have no suggestion
    // field at all (ocrSuggestions.ts) - editing them is always a person
    // typing from scratch, regardless of what the receipt's other fields
    // carry.
    for (const field of ["otherFees", "category", "paymentMethod", "notes"] as const) {
      const result = aggregateActionReport([
        event({
          field,
          receiptSuggestions: {
            ocrSuggestions: suggestions({ totalCents: 500 }),
            llmSuggestions: null,
          },
        }),
      ]);
      const row = result.parsePathBreakdown.find(
        (r) => r.field === field && r.parsePath === "not_parseable",
      );
      expect(row?.editedEvents).toBe(1);
      expect(
        result.parsePathBreakdown.filter((r) => r.field === field),
      ).toHaveLength(1);
    }
  });

  it("sums editedTotal per (field, parse path), not just editedEvents", () => {
    const result = aggregateActionReport([
      event({
        field: "total",
        count: 3,
        receiptSuggestions: {
          ocrSuggestions: suggestions({ totalCents: 1199 }),
          llmSuggestions: null,
        },
      }),
      event({
        field: "total",
        count: 4,
        receiptSuggestions: {
          ocrSuggestions: suggestions({ totalCents: 500 }),
          llmSuggestions: null,
        },
      }),
    ]);
    const row = result.parsePathBreakdown.find(
      (r) => r.field === "total" && r.parsePath === "suggested",
    );
    expect(row?.editedEvents).toBe(2);
    expect(row?.editedTotal).toBe(7);
  });

  it("keeps 'suggested' and 'not_suggested' edits to the same field apart", () => {
    const result = aggregateActionReport([
      event({
        field: "hst",
        receiptSuggestions: {
          ocrSuggestions: suggestions({ hstCents: 130 }),
          llmSuggestions: null,
        },
      }),
      event({
        field: "hst",
        receiptSuggestions: {
          ocrSuggestions: suggestions(),
          llmSuggestions: suggestions(),
        },
      }),
    ]);
    const suggested = result.parsePathBreakdown.find(
      (r) => r.field === "hst" && r.parsePath === "suggested",
    );
    const notSuggested = result.parsePathBreakdown.find(
      (r) => r.field === "hst" && r.parsePath === "not_suggested",
    );
    expect(suggested?.editedEvents).toBe(1);
    expect(notSuggested?.editedEvents).toBe(1);
  });

  it("only reports parse-path combinations that actually occurred", () => {
    const result = aggregateActionReport([
      event({
        field: "total",
        receiptSuggestions: {
          ocrSuggestions: suggestions({ totalCents: 1199 }),
          llmSuggestions: null,
        },
      }),
    ]);
    expect(result.parsePathBreakdown).toHaveLength(1);
  });

  it("does not let suggestion_accepted/overridden events feed the parse-path breakdown", () => {
    const result = aggregateActionReport([
      event({ action: "suggestion_overridden", field: "total", count: null }),
    ]);
    expect(result.parsePathBreakdown).toHaveLength(0);
  });
});

/**
 * 2026-08-28 (UX-enhancements proposal #4): the repeat-edit distribution -
 * "editing the total repeatedly" is the signal a mean would hide.
 */
describe("aggregateActionReport - edit-count histograms", () => {
  it("buckets a single edit as '1'", () => {
    const result = aggregateActionReport([event({ field: "total", count: 1 })]);
    const total = result.editHistograms.find((h) => h.field === "total");
    expect(total?.buckets).toEqual({ "1": 1, "2": 0, "3-5": 0, "6+": 0 });
  });

  it("treats a null count as a single edit, same as fieldActivity does", () => {
    const result = aggregateActionReport([event({ field: "total", count: null })]);
    const total = result.editHistograms.find((h) => h.field === "total");
    expect(total?.buckets["1"]).toBe(1);
  });

  it("buckets exactly two edits as '2'", () => {
    const result = aggregateActionReport([event({ field: "total", count: 2 })]);
    const total = result.editHistograms.find((h) => h.field === "total");
    expect(total?.buckets).toEqual({ "1": 0, "2": 1, "3-5": 0, "6+": 0 });
  });

  it("buckets three, four and five edits as '3-5'", () => {
    const result = aggregateActionReport([
      event({ field: "total", count: 3 }),
      event({ field: "total", count: 4 }),
      event({ field: "total", count: 5 }),
    ]);
    const total = result.editHistograms.find((h) => h.field === "total");
    expect(total?.buckets).toEqual({ "1": 0, "2": 0, "3-5": 3, "6+": 0 });
  });

  it("buckets six or more edits as '6+', unbounded above", () => {
    const result = aggregateActionReport([
      event({ field: "total", count: 6 }),
      event({ field: "total", count: 15 }),
    ]);
    const total = result.editHistograms.find((h) => h.field === "total");
    expect(total?.buckets).toEqual({ "1": 0, "2": 0, "3-5": 0, "6+": 2 });
  });

  it("distinguishes one receipt edited fifteen times from fifteen receipts edited once - the case a mean hides", () => {
    const repeated = aggregateActionReport([
      event({ field: "total", count: 15 }),
    ]);
    const scattered = aggregateActionReport(
      Array.from({ length: 15 }, () => event({ field: "total", count: 1 })),
    );

    // Both populations sum to the same total edit count...
    const repeatedActivity = repeated.fieldActivity.find((f) => f.field === "total");
    const scatteredActivity = scattered.fieldActivity.find((f) => f.field === "total");
    expect(repeatedActivity?.editedTotal).toBe(15);
    expect(scatteredActivity?.editedTotal).toBe(15);

    // ...but the histograms tell them apart, which is the entire point.
    const repeatedHistogram = repeated.editHistograms.find((h) => h.field === "total");
    const scatteredHistogram = scattered.editHistograms.find((h) => h.field === "total");
    expect(repeatedHistogram?.buckets).toEqual({ "1": 0, "2": 0, "3-5": 0, "6+": 1 });
    expect(scatteredHistogram?.buckets).toEqual({ "1": 15, "2": 0, "3-5": 0, "6+": 0 });
  });

  it("keeps each field's histogram separate", () => {
    const result = aggregateActionReport([
      event({ field: "total", count: 6 }),
      event({ field: "vendor", count: 1 }),
    ]);
    expect(result.editHistograms.find((h) => h.field === "total")?.buckets["6+"]).toBe(1);
    expect(result.editHistograms.find((h) => h.field === "vendor")?.buckets["1"]).toBe(1);
  });

  it("has no histogram entry for a field that was never edited", () => {
    const result = aggregateActionReport([
      event({ action: "suggestion_accepted", field: "hst", count: null }),
    ]);
    expect(result.editHistograms).toHaveLength(0);
  });
});
