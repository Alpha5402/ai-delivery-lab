import { describe, expect, it } from "vitest";
import { formatJson, hasRequiredKeys, parseJson } from "./jsonValidation";

describe("jsonValidation", () => {
  it("parses valid JSON", () => {
    expect(parseJson('{"step":"clarification"}')).toEqual({ ok: true, value: { step: "clarification" } });
  });

  it("returns an error for invalid JSON", () => {
    const result = parseJson("{bad");
    expect(result.ok).toBe(false);
  });

  it("checks required keys", () => {
    expect(hasRequiredKeys({ title: "x", rawText: "y" }, ["title", "rawText"])).toBe(true);
    expect(hasRequiredKeys({ title: "x" }, ["title", "rawText"])).toBe(false);
  });

  it("formats JSON with two-space indentation", () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
