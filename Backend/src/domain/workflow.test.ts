import { describe, expect, it } from "vitest";
import { clarificationOutputSchema, codeReviewResultSchema, createWorkflowSchema, solutionDslSchema } from "./workflow.js";

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

  it("normalizes common code review field aliases from LLM output", () => {
    const parsed = codeReviewResultSchema.parse({
      summary: "存在问题，需要修改。",
      decision: "request-changes",
      findings: [
        {
          id: "F001",
          title: "字数统计逻辑不符合需求规则",
          severity: "major",
          path: "frontend/src/routes/Article/Article.jsx",
          lines: "12-20",
          detail: "当前实现无法正确统计中文字符。",
          suggestion: "改为匹配汉字、字母、数字后计数。",
        },
      ],
      checklist: [
        { id: "C001", status: "passed", message: "仅修改前端 Article 页面" },
        "需要补充单元测试",
      ],
      reviewedFiles: ["frontend/src/routes/Article/Article.jsx"],
      riskAreas: ["中文字数统计错误"],
    });

    expect(parsed.findings[0].file).toBe("frontend/src/routes/Article/Article.jsx");
    expect(parsed.findings[0].line).toBe(12);
    expect(parsed.findings[0].recommendation).toBe("改为匹配汉字、字母、数字后计数。");
    expect(parsed.checklist[0].label).toBe("仅修改前端 Article 页面");
    expect(parsed.checklist[1]).toMatchObject({ id: "C002", label: "需要补充单元测试", status: "warning" });
  });
});
