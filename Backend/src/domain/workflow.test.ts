import { describe, expect, it } from "vitest";
import { clarificationOutputSchema, createWorkflowSchema, solutionDslSchema } from "./workflow.js";

describe("workflow schemas", () => {
  it("accepts valid workflow creation input", () => {
    const parsed = createWorkflowSchema.parse({
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    expect(parsed.targetRepo).toBe("conduit");
    expect(parsed.pattern).toBe("frontend-only");
  });

  it("rejects invalid clarification confidence", () => {
    expect(() => clarificationOutputSchema.parse({
      summary: "需求已澄清",
      questions: [],
      confidence: 2,
    })).toThrow();
  });

  it("validates solution DSL scope", () => {
    const parsed = solutionDslSchema.parse({
      requirementId: "article-reading-count",
      scope: "frontend",
      userStory: "作为读者，我希望看到阅读量。",
      acceptanceCriteria: ["文章卡片展示阅读量。"],
      dataContract: {},
    });

    expect(parsed.scope).toBe("frontend");
  });
});
