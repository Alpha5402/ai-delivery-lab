import { env } from "../config/env.js";
import { z } from "zod";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export type LlmJsonResult<TContent = unknown> = {
  content: TContent;
  rawContent: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type LlmHarnessResult<TContent> = LlmJsonResult<TContent> & {
  attempts: number;
  validationErrors: string[];
};

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("ARK_API_KEY or ARK_MODEL is not configured");
  }
}

export async function callJsonLlm(messages: ChatMessage[]): Promise<LlmJsonResult> {
  const completion = await requestChatCompletion(messages);

  return {
    content: parseJsonContent(completion.rawContent),
    rawContent: completion.rawContent,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    latencyMs: completion.latencyMs,
  };
}

export async function callJsonLlmWithSchema<TContent>(
  messages: ChatMessage[],
  schema: z.ZodType<TContent>,
  options: { maxAttempts?: number; label?: string } = {},
): Promise<LlmHarnessResult<TContent>> {
  const maxAttempts = options.maxAttempts ?? 2;
  const validationErrors: string[] = [];
  let retryMessages = messages;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLatencyMs = 0;
  let lastRawContent = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const completion = await requestChatCompletion(retryMessages);
    totalInputTokens += completion.inputTokens;
    totalOutputTokens += completion.outputTokens;
    totalLatencyMs += completion.latencyMs;
    lastRawContent = completion.rawContent;

    const parsed = parseJsonContentSafely(completion.rawContent);
    if (!parsed.ok) {
      validationErrors.push(parsed.error);
      retryMessages = buildHarnessRetryMessages(messages, completion.rawContent, parsed.error, options.label);
      continue;
    }

    const validated = schema.safeParse(parsed.value);
    if (validated.success) {
      return {
        content: validated.data,
        rawContent: completion.rawContent,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        latencyMs: totalLatencyMs,
        attempts: attempt,
        validationErrors,
      };
    }

    const validationError = formatZodError(validated.error);
    validationErrors.push(validationError);
    retryMessages = buildHarnessRetryMessages(messages, completion.rawContent, validationError, options.label);
  }

  throw new Error(
    [
      `${options.label ?? "LLM"} returned invalid JSON after ${maxAttempts} attempt(s).`,
      ...validationErrors.map((error, index) => `Attempt ${index + 1}: ${error}`),
      `Last raw response: ${lastRawContent}`,
    ].join("\n"),
  );
}

async function requestChatCompletion(messages: ChatMessage[]) {
  if (!env.ARK_API_KEY || !env.ARK_MODEL) {
    throw new LlmNotConfiguredError();
  }

  const startedAt = performance.now();
  const response = await fetch(`${env.ARK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ARK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.ARK_MODEL,
      messages,
      temperature: 0.2,
    }),
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as ChatCompletionResponse;
  const rawContent = payload.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw new Error("LLM response did not include message content");
  }

  return {
    rawContent,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

export function parseJsonContent(rawContent: string) {
  const parsed = parseJsonContentSafely(rawContent);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

function parseJsonContentSafely(rawContent: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = rawContent.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (error) {
    return {
      ok: false,
      error: `LLM response was not valid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
    };
  }
}

export function formatZodError(error: z.ZodError) {
  return JSON.stringify(error.issues, null, 2);
}

export function buildHarnessRetryMessages(
  originalMessages: ChatMessage[],
  invalidRawContent: string,
  validationError: string,
  label = "LLM Harness",
): ChatMessage[] {
  return [
    ...originalMessages,
    {
      role: "assistant",
      content: invalidRawContent,
    },
    {
      role: "user",
      content: [
        `${label} 校验失败，请只重新输出一个满足 schema 的 JSON object。`,
        "不要输出 Markdown，不要解释，不要包裹代码块。",
        "上一次输出不合法，错误如下：",
        validationError,
      ].join("\n"),
    },
  ];
}
