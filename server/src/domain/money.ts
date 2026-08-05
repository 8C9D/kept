/**
 * Money is an integer number of cents, never a float (spec §5). The branded
 * type makes "some number that happens to be money" unrepresentable in the
 * domain layer: a plain number does not typecheck where Cents is required.
 */
export type Cents = number & { readonly __brand: "Cents" };

export class InvalidMoneyError extends Error {
  constructor(value: unknown) {
    super(`Money must be an integer number of cents, got: ${String(value)}`);
    this.name = "InvalidMoneyError";
  }
}

/**
 * Negative values are allowed: a refund receipt is a real receipt.
 */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidMoneyError(value);
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
