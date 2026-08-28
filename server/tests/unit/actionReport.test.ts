import { describe, expect, it } from "vitest";
import {
  aggregateActionReport,
  type RawEvent,
} from "../../src/domain/actionReport.js";
import { EVENT_ACTIONS, EVENT_FIELDS } from "../../src/domain/userEvents.js";

function event(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    action: "field_edited",
    field: "total",
    count: null,
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
