import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildHarnessRetryMessages, formatZodError, parseJsonContent } from "./llmClient.js";

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
