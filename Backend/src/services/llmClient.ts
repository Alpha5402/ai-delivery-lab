import { AsyncLocalStorage } from "node:async_hooks";
import { getLlmRuntimeSettings } from "./llmSettingsService.js";
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
    finish_reason?: string;
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
  finishReason?: string;
};

export type LlmHarnessResult<TContent> = LlmJsonResult<TContent> & {
  attempts: number;
  validationErrors: string[];
};

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export class LlmUsageError extends Error {
  usage: LlmUsage;

  constructor(message: string, usage: LlmUsage, options?: { cause?: unknown }) {
    super(message);
    this.name = "LlmUsageError";
    this.usage = usage;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function getLlmUsageFromError(error: unknown): LlmUsage | null {
  if (error instanceof LlmUsageError) {
    return error.usage;
  }
  return null;
}

/**
 * 可注入的 LLM transport，用于测试时替换真实 HTTP 调用。
 * 生产代码不注入，自动走 Volcengine Ark fetch 路径。
 */
export type LlmTransport = (messages: ChatMessage[]) => Promise<{
  rawContent: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  finishReason?: string;
}>;

let _transport: LlmTransport | null = null;
const llmProjectContext = new AsyncLocalStorage<{ projectId?: string }>();

/** 注入自定义 transport。传 null 恢复默认 HTTP transport。 */
export function setLlmTransport(transport: LlmTransport | null): void {
  _transport = transport;
}

export function withLlmProjectContext<T>(projectId: string | undefined, fn: () => Promise<T>) {
  return llmProjectContext.run({ projectId }, fn);
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

export async function callTextLlm(messages: ChatMessage[]): Promise<LlmJsonResult<string>> {
  const completion = await requestChatCompletion(messages);

  return {
    content: completion.rawContent,
    rawContent: completion.rawContent,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    latencyMs: completion.latencyMs,
    finishReason: completion.finishReason,
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
    let completion: Awaited<ReturnType<typeof requestChatCompletion>>;
    try {
      completion = await requestChatCompletion(retryMessages);
    } catch (error) {
      const failedUsage = getLlmUsageFromError(error);
      throw new LlmUsageError(
        error instanceof Error ? error.message : `${options.label ?? "LLM"} request failed`,
        {
          inputTokens: totalInputTokens + (failedUsage?.inputTokens ?? 0),
          outputTokens: totalOutputTokens + (failedUsage?.outputTokens ?? 0),
          latencyMs: totalLatencyMs + (failedUsage?.latencyMs ?? 0),
        },
        { cause: error },
      );
    }

    totalInputTokens += completion.inputTokens;
    totalOutputTokens += completion.outputTokens;
    totalLatencyMs += completion.latencyMs;
    lastRawContent = completion.rawContent;

    const parsed = parseJsonContentSafely(completion.rawContent);
    if (!parsed.ok) {
      let errorMsg = parsed.error;
      const truncDiag = buildTruncationDiag(completion.rawContent, completion.finishReason, completion.outputTokens);
      if (truncDiag) {
        errorMsg = truncDiag + ": " + parsed.error;
      }
      validationErrors.push(errorMsg);
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

  throw new LlmUsageError(
    [
      `${options.label ?? "LLM"} returned invalid JSON after ${maxAttempts} attempt(s).`,
      ...validationErrors.map((error, index) => `Attempt ${index + 1}: ${error}`),
      `Last raw response: ${lastRawContent}`,
    ].join("\n"),
    {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      latencyMs: totalLatencyMs,
    },
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

  const llmSettings = getLlmRuntimeSettings(llmProjectContext.getStore()?.projectId);
  if (!llmSettings.apiKey || !llmSettings.modelName) {
    throw new LlmNotConfiguredError();
  }

  let lastError: Error | undefined;
  let totalLatencyMs = 0;

  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const startedAt = performance.now();
    let latencyRecorded = false;
    try {
      const response = await fetch(`${llmSettings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${llmSettings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: llmSettings.modelName,
          messages,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const latencyMs = Math.round(performance.now() - startedAt);
        totalLatencyMs += latencyMs;
        latencyRecorded = true;
        clearTimeout(timeoutId);
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
      const finishReason = payload.choices?.[0]?.finish_reason;
      const latencyMs = Math.round(performance.now() - startedAt);
      totalLatencyMs += latencyMs;
      latencyRecorded = true;
      clearTimeout(timeoutId);

      if (!rawContent) {
        throw new Error("LLM response did not include message content");
      }

      return {
        rawContent,
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        latencyMs: totalLatencyMs,
        finishReason,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (!latencyRecorded) {
        const failedLatencyMs = Math.round(performance.now() - startedAt);
        totalLatencyMs += failedLatencyMs;
      }
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
      throw new LlmUsageError(
        lastError?.message ?? (error instanceof Error ? error.message : "LLM request failed"),
        { inputTokens: 0, outputTokens: 0, latencyMs: totalLatencyMs },
        { cause: lastError ?? error },
      );
    }
  }

  throw new LlmUsageError(
    lastError?.message ?? "LLM request failed after all retries",
    { inputTokens: 0, outputTokens: 0, latencyMs: totalLatencyMs },
    { cause: lastError },
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构建截断诊断提示。finishReason="length" 或末尾未闭合 → 返回诊断文本，否则 null。 */
export function buildTruncationDiag(rawContent: string, finishReason?: string, outputTokens?: number): string | null {
  const tokensInfo = outputTokens != null ? `outputTokens=${outputTokens}` : "";
  if (finishReason === "length") {
    return `模型输出疑似被截断 (finish_reason=length, ${tokensInfo})`;
  }
  const trimmed = rawContent.trimEnd();
  if (/[{\[]\s*$/.test(trimmed) || (trimmed.endsWith(":") && !trimmed.endsWith("::"))) {
    // 末尾是未闭合的括号/引号/冒号
    return `JSON 解析失败且末尾未闭合 (可能被截断, ${tokensInfo})`;
  }
  // 检查是否以中间状态结束（如逗号后、键名后无值）
  if (truncatedAtIncompleteSlot(trimmed)) {
    return `JSON 解析失败，输出可能在字段值中间被截断 (${tokensInfo})`;
  }
  return null;
}

function truncatedAtIncompleteSlot(text: string): boolean {
  // 末尾是 `"key":` 后面无值，或 `"key": "val` 未闭合引号
  return /"[^"]*"\s*:\s*$/.test(text) || /"\s*:\s*"[^"]*$/.test(text);
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
