import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildHarnessRetryMessages, buildTruncationDiag, formatZodError, parseJsonContent } from "./llmClient.js";

describe("buildTruncationDiag", () => {
  it("detects finish_reason=length", () => {
    const diag = buildTruncationDiag('{"key":', "length", 1000);
    expect(diag).toContain("finish_reason=length");
    expect(diag).toContain("outputTokens=1000");
  });

  it("detects open array bracket", () => {
    const diag = buildTruncationDiag('{"tasks": [', undefined, 200);
    expect(diag).toContain("末尾未闭合");
  });

  it("returns null for complete truncated JSON", () => {
    const diag = buildTruncationDiag('{"strategy": "do X", "tasks": [{"id": "1"}]}', undefined, 200);
    expect(diag).toBeNull();
  });

  it("returns null for valid-looking json", () => {
    const diag = buildTruncationDiag('{"strategy": "ok", "tasks": []}', undefined, 100);
    expect(diag).toBeNull();
  });

  it("returns null for complete content", () => {
    const diag = buildTruncationDiag('  ```json\n{"valid": true}\n```  ');
    expect(diag).toBeNull();
  });
});

describe("parseJsonContent", () => {
  it("parses a plain JSON object", () => {
    expect(parseJsonContent('{"summary":"ok","count":1}')).toEqual({
      summary: "ok",
      count: 1,
    });
  });

  it("parses a fenced JSON object", () => {
    expect(parseJsonContent('```json\n{"summary":"ok"}\n```')).toEqual({
      summary: "ok",
    });
  });

  it("throws a clear error for non-JSON content", () => {
    expect(() => parseJsonContent("summary: ok")).toThrow("LLM response was not valid JSON");
  });
});

describe("LLM harness helpers", () => {
  it("formats schema validation issues for regeneration prompts", () => {
    const schema = z.object({
      sections: z.object({
        architecture: z.string(),
      }),
    });
    const result = schema.safeParse({ sections: [] });

    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toContain('"path"');
      expect(formatted).toContain('"sections"');
      expect(formatted).toContain("Expected object, received array");
    }
  });

  it("builds retry messages with original output and validation error", () => {
    const messages = [
      { role: "system" as const, content: "只输出 JSON" },
      { role: "user" as const, content: "{\"repoName\":\"demo\"}" },
    ];
    const retryMessages = buildHarnessRetryMessages(
      messages,
      "{\"sections\":[]}",
      "Expected object, received array",
      "Repository Context Agent",
    );

    expect(retryMessages).toHaveLength(4);
    expect(retryMessages[2]).toEqual({ role: "assistant", content: "{\"sections\":[]}" });
    expect(retryMessages[3].content).toContain("Repository Context Agent 校验失败");
    expect(retryMessages[3].content).toContain("Expected object, received array");
  });
});
