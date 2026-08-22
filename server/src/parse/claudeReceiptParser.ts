import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  RECEIPT_PARSE_JSON_SCHEMA,
  RECEIPT_PARSE_SYSTEM_PROMPT,
  llmParseResponseSchema,
  validateLlmParseResponse,
} from "../domain/llmSuggestions.js";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";

/**
 * The LLM parse over a receipt's stored OCR text (ruled Aug 7, 2026).
 *
 * Haiku 4.5 deliberately: this is structured extraction over ~30 lines of
 * text, measured at roughly 0.12¢ per receipt on the first real run. The
 * accuracy table arbitrates whether a larger model is ever warranted - not
 * taste.
 */
export const RECEIPT_PARSE_MODEL = "claude-haiku-4-5";

export class LlmParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "LlmParseError";
  }
}

/**
 * The request, built as a pure function so a test can assert what leaves
 * the building: the user content is the receipt's OCR text and nothing
 * else. The owner's ruling on the design was explicit - the model sees what
 * the paper says, never a field a person typed - and a request builder
 * that took the whole receipt row would make that ruling one refactor away
 * from silently false.
 */
export function buildParseRequest(
  ocrRawText: string,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: RECEIPT_PARSE_MODEL,
    // The reply is one small JSON object; the ceiling is headroom, not a
    // target. A response that hits it is treated as a failed parse below.
    max_tokens: 1024,
    system: RECEIPT_PARSE_SYSTEM_PROMPT,
    output_config: {
      format: {
        type: "json_schema",
        schema: RECEIPT_PARSE_JSON_SCHEMA,
      },
    },
    messages: [{ role: "user", content: ocrRawText }],
  };
}

/**
 * One receipt text in, validated suggestions out. Every failure mode is an
 * LlmParseError naming what went wrong: the caller decides whether that
 * fails a script loudly (backfill) or leaves a column null (server parse,
 * later). Nothing here retries beyond the SDK's built-in 429/5xx retries,
 * and nothing here writes anywhere.
 */
export async function parseReceiptText(
  client: Anthropic,
  ocrRawText: string,
): Promise<OcrFieldSuggestions> {
  const response = await client.messages.create(buildParseRequest(ocrRawText));

  if (response.stop_reason !== "end_turn") {
    throw new LlmParseError(
      `Model stopped with ${response.stop_reason ?? "no stop reason"} instead of completing the extraction`,
    );
  }

  const textBlocks = response.content.filter((block) => block.type === "text");
  const textBlock = textBlocks[0];
  if (textBlock === undefined || textBlocks.length !== 1) {
    throw new LlmParseError(
      `Expected exactly one text block in the response, got ${textBlocks.length}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (error) {
    throw new LlmParseError("Model response was not parseable JSON", {
      cause: sanitizedJsonParseCause(error),
    });
  }

  try {
    return validateLlmParseResponse(parsed);
  } catch (error) {
    throw new LlmParseError(
      "Model response did not validate as receipt suggestions",
      { cause: sanitizedValidationCause(error) },
    );
  }
}

/** The `at position 41` V8 appends when it knows where it stopped. */
const JSON_PARSE_POSITION = /\bat position (\d+)\b/;

/**
 * A `JSON.parse` failure's cause, rebuilt so it carries no model output.
 *
 * V8 writes the input it choked on *into the message*: `Unexpected token
 * 'D', "Dr Smith P"... is not valid JSON`. Here that input is the model's
 * reply to the receipt's own OCR text, so those ten characters are receipt
 * contents - and `errorSummary` reproduces a non-database error's whole
 * cause chain verbatim, which is how a vendor name reached the sweep's log
 * (spec §10B, N-2). The narrow fix is here rather than in `errorSummary`:
 * that module redacts every log path in the project, and this is the one
 * throw site that hands it a message it did not write.
 *
 * Kept: the error's name, and the offset it stopped at when V8 reports one.
 * Dropped: the quoted snippet, and V8's prose reason - the reasons that
 * name a cause ("Expected double-quoted property name") are exactly the
 * ones that also carry a position, so the offset stands in for them.
 */
function sanitizedJsonParseCause(error: unknown): Error {
  if (!(error instanceof Error)) {
    // JSON.parse throws SyntaxError and nothing else, so this is unreachable
    // - and the thrown value could be anything, so name its type only.
    return new Error(`non-Error value thrown (${typeof error}) [message withheld]`);
  }
  const position = JSON_PARSE_POSITION.exec(error.message)?.[1];
  const suffix = position === undefined ? "" : ` at position ${position}`;
  return new Error(`${error.name} [message withheld]${suffix}`);
}

/**
 * A validation failure's cause, rebuilt the same way (round 4 §4a's
 * residual). Zod writes the offending object's own keys *into the message*:
 * a `strictObject` refusing `{"Dr Smith session fee": 11300}` says
 * `Unrecognized keys: "Dr Smith session fee"` - and those keys are the
 * model's invention over the receipt's OCR text, so they can carry receipt
 * content the same way the JSON.parse snippet did.
 *
 * Kept: each issue's `code`, and its `path` - guarded structurally rather
 * than trusted: a string segment survives only if it names a key of our own
 * schema (paths into a flat strictObject always do; the guard is what makes
 * that a property instead of an observation about today's zod), numeric
 * segments are array indices, anything else renders withheld. For
 * `unrecognized_keys`, the count survives and the names never do.
 * Dropped: every message zod wrote, including our own refine wording -
 * `custom at purchasedAt` says the same thing without an allowlist to rot.
 */
function sanitizedValidationCause(error: unknown): Error {
  if (!(error instanceof z.ZodError)) {
    // `parsedDate` rethrows non-InvalidDateError failures, so a genuine
    // internal error can land here: keep its class, withhold its message,
    // exactly as the JSON.parse branch does.
    if (error instanceof Error) {
      return new Error(`${error.name} [message withheld]`);
    }
    return new Error(`non-Error value thrown (${typeof error}) [message withheld]`);
  }
  const schemaKeys = new Set(Object.keys(llmParseResponseSchema.shape));
  const issues = error.issues.map((issue) => {
    const path =
      issue.path.length === 0
        ? "(root)"
        : issue.path
            .map((segment) => {
              if (typeof segment === "number") {
                return String(segment);
              }
              return typeof segment === "string" && schemaKeys.has(segment)
                ? segment
                : "(withheld)";
            })
            .join(".");
    const count =
      issue.code === "unrecognized_keys"
        ? ` (${issue.keys.length} key name(s) withheld)`
        : "";
    return `${issue.code} at ${path}${count}`;
  });
  return new Error(`ZodError [messages withheld]: ${issues.join(", ")}`);
}
