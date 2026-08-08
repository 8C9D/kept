# Kept - agent instructions

The spec is `docs/Kept-Build-Spec.md`.
It is the authority for the entire project.

## The success test

A receipt is captured in under a minute and never thought about again.
Every design decision is subordinate to this sentence.

## The four constraints that do not move

1. HST is its own field, never folded into the total, plus the supplier's GST/HST registration number.
2. No OCR value saves without a human confirming it.
   Extracted fields are suggestions in an editable form.
3. Business-vs-personal is set at capture time, never as cleanup.
4. Full per-user isolation.
   Each user sees only their own receipts.

## Engineering rules

- `user_id` always comes from the session token, never from a request parameter.
  An endpoint accepting a user id as input is a bug.
- Money is integer cents.
  Never floats.
- `category` is free text.
  Never introduce an enum, taxonomy, or CRA line mapping.
- `is_business` has no default value at any layer.
- Nothing with `status = 'pending'` may appear in an export.
- No secrets in the repo.
  `.env.local` is gitignored and the owner handles its contents.
- Never weaken, skip, or delete a failing test to make a suite pass.
  A failing test is a finding - report it.
- Verify artifacts, not reports.
  Inspect the database, open the generated file, read `git log`.
  An exit code is not evidence.
- Predict before verifying.
  State in writing what you expect an artifact to look like, then look at it, then note the gap.
- Every gate starts the real server the real way before it closes: the production entrypoint (`npm run dev` or the platform equivalent), from a clean checkout, config loaded as an operator would load it, then one real request against it.
  A test suite that injects its configuration can be fully green while the entry point cannot start - that happened at wave 3.

## Doc ownership

- When a decision is appended to `docs/DECISIONS.md`, `docs/Kept-Build-Spec.md` is amended in the same commit.
  `DECISIONS.md` is the append-only log of how we got here; the spec is the current state.
  Neither is optional and neither substitutes for the other.
  The failure mode this exists to prevent: a prompt that says "append a DECISIONS entry" without saying "amend the spec" must still produce both - the Aug 7-8 LLM-parse decisions reached the log while the spec went on describing a path not taken for three days.
- `docs/DECISIONS.md` is ordered newest-first by decision date: a new entry is inserted at the top of the file, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.

## Review discipline

When reviewing your own or generated code, explicitly hunt duplication and error-masking: catch blocks that swallow signal, empty error handlers, silently-defaulted values.
