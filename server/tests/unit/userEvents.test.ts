import { describe, expect, it } from "vitest";
import {
  EVENT_RETENTION_DAYS,
  eventRetentionCutoff,
  isOccurredAtInBounds,
} from "../../src/domain/userEvents.js";

describe("eventRetentionCutoff", () => {
  it("is exactly the retention window before now", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const cutoff = eventRetentionCutoff(now);
    const days =
      (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(EVENT_RETENTION_DAYS);
    expect(cutoff.toISOString()).toBe("2026-03-01T12:00:00.000Z");
  });
});

describe("isOccurredAtInBounds", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("accepts a normal recent event", () => {
    expect(isOccurredAtInBounds(new Date("2026-08-28T11:59:00.000Z"), now)).toBe(
      true,
    );
  });

  it("accepts an old event, on the reasoning that offline batches can be old", () => {
    // Months in the outbox before the phone ever finds a network - the
    // whole reason occurred_at and received_at are tracked separately.
    expect(isOccurredAtInBounds(new Date("2026-01-01T00:00:00.000Z"), now)).toBe(
      true,
    );
  });

  it("accepts an event within the future clock-skew allowance", () => {
    expect(
      isOccurredAtInBounds(new Date("2026-08-29T11:00:00.000Z"), now),
    ).toBe(true);
  });

  it("refuses an event more than a day in the future", () => {
    expect(
      isOccurredAtInBounds(new Date("2026-08-30T00:00:01.000Z"), now),
    ).toBe(false);
  });

  it("refuses a far-future placeholder date", () => {
    expect(isOccurredAtInBounds(new Date("2099-01-01T00:00:00.000Z"), now)).toBe(
      false,
    );
  });

  it("refuses a date before Kept could possibly have produced one", () => {
    expect(isOccurredAtInBounds(new Date("2019-12-31T23:59:59.000Z"), now)).toBe(
      false,
    );
  });

  it("refuses the Unix epoch - the classic uninitialized-clock value", () => {
    expect(isOccurredAtInBounds(new Date(0), now)).toBe(false);
  });

  it("refuses an unparseable date", () => {
    expect(isOccurredAtInBounds(new Date("not a date"), now)).toBe(false);
  });
});
