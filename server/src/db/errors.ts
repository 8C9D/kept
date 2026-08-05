/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505) for one
 * specific named constraint. Drizzle may wrap the pg error, so the cause
 * chain is walked. Matching on the constraint name keeps the check precise:
 * an unexpected violation elsewhere still surfaces as a 500, not a
 * misleading 409.
 */
export function isUniqueViolation(
  error: unknown,
  constraintName: string,
): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as Error & {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      candidate.code === "23505" &&
      candidate.constraint === constraintName
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
