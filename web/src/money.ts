/**
 * Money is integer cents, never floats (CLAUDE.md) - and that rule reaches
 * rendering: everything here is string and integer arithmetic, so no value
 * ever passes through a floating-point dollars representation on its way
 * to or from a person.
 */

/** The sign and the digits of an amount, with no currency attached. */
function amountParts(cents: number): { sign: string; digits: string } {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Not an integer number of cents: ${cents}`);
  }
  const abs = Math.abs(cents);
  const centsPart = abs % 100;
  // Exact: abs - centsPart is divisible by 100, so this division is
  // integer-valued and IEEE 754 represents it without rounding.
  const dollars = (abs - centsPart) / 100;
  return {
    sign: cents < 0 ? "-" : "",
    digits: `${dollars}.${String(centsPart).padStart(2, "0")}`,
  };
}

/**
 * 1234 -> "$12.34", -1234 -> "-$12.34", null -> "".
 *
 * ⚠ The "$" names no currency. This is the form an amount takes in an
 * editable box, where it has to parse back through `parseMoneyInput`; beside
 * a value that could be in any other currency, use `formatMoney`.
 */
export function formatCents(cents: number | null): string {
  if (cents === null) {
    return "";
  }
  const { sign, digits } = amountParts(cents);
  return `${sign}$${digits}`;
}

/**
 * The currency every web-created receipt defaults to, and so the one a bare
 * "$" is allowed to mean. `receipt.currency` is the server's three-letter
 * code (validated `/^[A-Z]{3}$/` on every write), so this compares exactly.
 */
export const HOME_CURRENCY = "CAD";

/**
 * The currency worth stating beside an amount, or null when it is the home
 * currency and stating it would only be noise on every row of a CAD account.
 */
export function foreignCurrency(currency: string): string | null {
  return currency === HOME_CURRENCY ? null : currency;
}

/**
 * An amount in its own currency, for reading: 1234 in CAD -> "$12.34", in
 * USD -> "USD 12.34". Production holds both (2026-09-01), and a USD total
 * under a bare "$" reads as a Canadian one - and worse, invites being added
 * to one, which is the mistake `describeSummary` exists not to make.
 */
export function formatMoney(cents: number | null, currency: string): string {
  const foreign = foreignCurrency(currency);
  if (foreign === null || cents === null) {
    return formatCents(cents);
  }
  const { sign, digits } = amountParts(cents);
  return `${foreign} ${sign}${digits}`;
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
