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

/**
 * 可注入的 LLM transport，用于测试时替换真实 HTTP 调用。
 * 生产代码不注入，自动走 Volcengine Ark fetch 路径。
 */
export type LlmTransport = (messages: ChatMessage[]) => Promise<{
  rawContent: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}>;

let _transport: LlmTransport | null = null;

/** 注入自定义 transport。传 null 恢复默认 HTTP transport。 */
export function setLlmTransport(transport: LlmTransport | null): void {
  _transport = transport;
}

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

/** LLM 请求超时（毫秒） */
const LLM_TIMEOUT_MS = 60_000;
/** 网络级重试次数（仅对超时 / 5xx 重试，4xx 或解析错误不重试） */
const LLM_MAX_RETRIES = 2;
/** 重试间隔基数（毫秒），每次翻倍 */
const LLM_RETRY_BASE_MS = 2_000;

async function requestChatCompletion(messages: ChatMessage[]) {
  if (_transport) return _transport(messages);

  if (!env.ARK_API_KEY || !env.ARK_MODEL) {
    throw new LlmNotConfiguredError();
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const startedAt = performance.now();
    try {
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
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const latencyMs = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const error = new Error(`LLM request failed: ${response.status} ${errorBody}`);
        // 仅对 5xx / 429 重试
        if (response.status >= 500 || response.status === 429) {
          lastError = error;
          await sleep(LLM_RETRY_BASE_MS * attempt);
          continue;
        }
        throw error;
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
    } catch (error) {
      clearTimeout(timeoutId);
      const isAbort = error instanceof Error && error.name === "AbortError";
      const isNetwork = error instanceof TypeError; // fetch network error
      if (isAbort || isNetwork) {
        lastError = new Error(
          isAbort
            ? `LLM request timed out after ${LLM_TIMEOUT_MS}ms (attempt ${attempt}/${LLM_MAX_RETRIES})`
            : `LLM network error: ${(error as Error).message} (attempt ${attempt}/${LLM_MAX_RETRIES})`,
        );
        if (attempt < LLM_MAX_RETRIES) {
          await sleep(LLM_RETRY_BASE_MS * attempt);
          continue;
        }
      }
      throw lastError ?? error;
    }
  }

  throw lastError ?? new Error("LLM request failed after all retries");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
