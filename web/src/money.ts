/**
 * Money is integer cents, never floats (CLAUDE.md) - and that rule reaches
 * rendering: everything here is string and integer arithmetic, so no value
 * ever passes through a floating-point dollars representation on its way
 * to or from a person.
 */

/** 1234 -> "$12.34", -1234 -> "-$12.34", null -> "". */
export function formatCents(cents: number | null): string {
  if (cents === null) {
    return "";
  }
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Not an integer number of cents: ${cents}`);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const centsPart = abs % 100;
  // Exact: abs - centsPart is divisible by 100, so this division is
  // integer-valued and IEEE 754 represents it without rounding.
  const dollars = (abs - centsPart) / 100;
  return `${sign}$${dollars}.${String(centsPart).padStart(2, "0")}`;
}

/**
 * int4 bounds, mirrored from the server's own domain/money.ts
 * (`MAX_STORABLE_CENTS`/`MIN_STORABLE_CENTS`): every money column is a
 * Postgres `integer`, so a value outside this range is one the server would
 * refuse to store no matter how it got there. Used only by ReceiptForm.tsx's
 * `deriveMissingAmount` mirror (proposal #1, 2026-08-28) - this client still
 * never decides on its own what is storable (the PATCH is still the real
 * enforcement), but the live derivation that offers a one-tap fill must not
 * offer a number the server would 400 on the moment it landed.
 */
export const MAX_STORABLE_CENTS = 2_147_483_647;
export const MIN_STORABLE_CENTS = -2_147_483_648;

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyParseError";
  }
}

const MONEY_INPUT = /^(-)?\$?\s*(\d+)(?:\.(\d{1,2}))?$/;

/**
 * "12.34", "$12.34", "-3", "3.5" -> cents. Empty input is null - the
 * stated "not on this receipt" - and anything else is a MoneyParseError,
 * never a rounded or truncated guess. Parsing is textual: "3.5" means 350
 * because the person wrote tenths of a dollar, and no float is involved in
 * deciding that.
 */
export function parseMoneyInput(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  const match = MONEY_INPUT.exec(trimmed);
  if (match === null) {
    throw new MoneyParseError(
      `"${trimmed}" is not an amount like 12.34 or -3.50`,
    );
  }
  const [, sign, dollarsText, centsText] = match;
  const dollars = Number(dollarsText);
  const cents = Number((centsText ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(dollars * 100 + cents)) {
    throw new MoneyParseError(`"${trimmed}" is too large to store`);
  }
  const total = dollars * 100 + cents;
  return sign === "-" ? -total : total;
}
