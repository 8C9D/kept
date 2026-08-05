# Wave-0 gate report

Backfilled 2026-08-05 from the printed report, per the wave-1 kickoff's rule that gate reports live in `docs/gates/`.

## Prediction versus reality

The full schema prediction (tables, all columns with type/nullability/default, indexes, uniques, seed rows) was written before inspection.
Reality matched on every point; no gaps.
Noted caveat: agreement mostly confirms the migration was faithful to the schema file, since the prediction included judgment calls rather than only facts read from the spec.

## Judgment calls

- Timestamp columns got `DEFAULT now()` and uuid PKs got `gen_random_uuid()`; the spec was silent.
- `status` was given no default, reading the spec as-written; flagged `DEFAULT 'pending'` as the better fail-closed choice (later accepted).
- Columns not marked nullable became NOT NULL, including `vendor` (later reversed) and `purchased_at`, `captured_at`.
- FKs are plain NO ACTION, consistent with soft delete.
- drizzle-orm bumped to 0.45.2 for a high-severity SQL-injection advisory; four moderate advisories remain in drizzle-kit's dev-time esbuild chain, flagged not fixed.
- Compose uses synthetic `kept/kept` local credentials with `DATABASE_URL` as override.

## Spec defects reported

1. Soft delete had an endpoint (§6) and a retention requirement (§10B) but no schema column.
2. Unique `(receipt_id, sha256)` could not deliver its stated duplicate-catching guarantee; user-scoped uniqueness needs `user_id` on the table.
3. Minor: repo layout showed the spec at the root while the kickoff said `docs/`.

Both substantive defects were accepted in the wave-0 gate review and are now in the spec (see `DECISIONS.md`).
