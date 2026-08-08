import Anthropic from "@anthropic-ai/sdk";
import {
  RECEIPT_PARSE_JSON_SCHEMA,
  RECEIPT_PARSE_SYSTEM_PROMPT,
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
      cause: error,
    });
  }

  try {
    return validateLlmParseResponse(parsed);
  } catch (error) {
    throw new LlmParseError(
      "Model response did not validate as receipt suggestions",
      { cause: error },
    );
  }
}
