/**
 * Money is an integer number of cents, never a float (spec §5). The branded
 * type makes "some number that happens to be money" unrepresentable in the
 * domain layer: a plain number does not typecheck where Cents is required.
 */
export type Cents = number & { readonly __brand: "Cents" };

export class InvalidMoneyError extends Error {
  constructor(value: unknown, reason: string) {
    super(`${reason}, got: ${String(value)}`);
    this.name = "InvalidMoneyError";
  }
}

/**
 * The range a money value can actually be stored in: every money column is
 * a Postgres `integer` (db/schema.ts), so int4's bounds are the domain's
 * bounds too.
 *
 * The domain accepted any safe integer until the August 2026 security
 * audit, on the reasoning that the domain should not know about storage.
 * That was wrong in a way worth recording: a value this type says is valid
 * money and the database cannot store is not a storage detail, it is a
 * contradiction that has to surface somewhere - and where it surfaced was
 * an insert failing mid-transaction, rendered as a 500, whose unhandled-
 * error log printed every bound parameter of the statement in plaintext.
 * A domain type whose range exceeds its storage is a promise nothing keeps.
 *
 * $21 474 836.47 is not a real receipt, so nothing legitimate is refused.
 */
export const MAX_STORABLE_CENTS = 2_147_483_647;
export const MIN_STORABLE_CENTS = -2_147_483_648;

/**
 * Negative values are allowed: a refund receipt is a real receipt.
 */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidMoneyError(value, "Money must be an integer number of cents");
  }
  if (value < MIN_STORABLE_CENTS || value > MAX_STORABLE_CENTS) {
    throw new InvalidMoneyError(
      value,
      "Money is outside the storable amount range",
    );
  }
  return value as Cents;
}

/**
 * Render cents as a decimal currency string ("11300" → "113.00") for the
 * export files (spec §8). Pure integer arithmetic and string assembly - the
 * value never passes through a float.
 */
export function centsToDecimalString(value: Cents): string {
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  const dollars = Math.floor(magnitude / 100);
  const remainder = String(magnitude % 100).padStart(2, "0");
  return `${sign}${dollars}.${remainder}`;
}
