import { describe, expect, it } from "vitest";
import {
  buildStructuredFeedbackMessage,
  hasStructuredFeedbackDraft,
  parseDecisionMemoryItems,
  type StructuredFeedbackDraft,
} from "./decisionMemory";

const msg = (content: string) => ({
  id: "m1", role: "user" as const, content, stepId: "clarification" as const, createdAt: "2025-01-01T00:00:00Z",
});

describe("parseDecisionMemoryItems", () => {
  it("parses selection feedback into option-selection card", () => {
    const items = parseDecisionMemoryItems([msg(
      "问题：字数统计规则\n选择：仅统计纯文本，排除所有 Markdown\n说明：包含标题和正文\n自定义补充：注意中文全角空格",
    )]);
    const sel = items.find((i) => i.source === "option-selection");
    expect(sel).toBeDefined();
    expect(sel!.type).toBe("business-rule");
    expect(sel!.content).toContain("仅统计纯文本");

    const note = items.find((i) => i.source === "user-feedback" && i.title.includes("说明"));
    expect(note).toBeDefined();

    const custom = items.find((i) => i.title.includes("自定义"));
    expect(custom).toBeDefined();
    expect(custom!.type).toBe("preference");
  });

  it("parses general feedback", () => {
    const items = parseDecisionMemoryItems([msg("整体补充：接口返回需增加 pagination 字段")]);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].source).toBe("user-feedback");
    expect(items[0].content).toContain("pagination");
  });

  it("fallback raw text is not lost", () => {
    const items = parseDecisionMemoryItems([msg("一段没有格式的普通文字")]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe("other");
    expect(items[0].content).toBe("一段没有格式的普通文字");
  });

  it("classifies display rules", () => {
    const items = parseDecisionMemoryItems([msg("问题：展示位置\n选择：文章标题下方显示")]);
    expect(items[0].type).toBe("display-rule");
  });

  it("skips non-user messages", () => {
    const items = parseDecisionMemoryItems([{
      ...msg("x"), role: "agent" as const,
    }]);
    expect(items).toHaveLength(0);
  });
});

describe("StructuredFeedbackDraft helpers", () => {
  const emptyDraft: StructuredFeedbackDraft = {
    questionFeedback: {}, selectedOptions: {}, generalFeedback: "",
  };

  it("hasStructuredFeedbackDraft returns false for empty draft", () => {
    expect(hasStructuredFeedbackDraft(emptyDraft)).toBe(false);
  });

  it("hasStructuredFeedbackDraft returns true with questionFeedback", () => {
    expect(hasStructuredFeedbackDraft({
      ...emptyDraft, questionFeedback: { q1: "my answer" },
    })).toBe(true);
  });

  it("hasStructuredFeedbackDraft returns true with selectedOptions", () => {
    expect(hasStructuredFeedbackDraft({
      ...emptyDraft, selectedOptions: { q1: ["a"] },
    })).toBe(true);
  });

  it("hasStructuredFeedbackDraft returns true with generalFeedback", () => {
    expect(hasStructuredFeedbackDraft({
      ...emptyDraft, generalFeedback: "overall note",
    })).toBe(true);
  });

  it("buildStructuredFeedbackMessage constructs from draft", () => {
    const msg = buildStructuredFeedbackMessage({
      draft: { questionFeedback: { q1: "custom text" }, selectedOptions: { q1: ["A"] }, generalFeedback: "overall" },
      questions: [{ id: "q1", question: "字数统计规则？" }],
    });
    expect(msg).toContain("问题：字数统计规则？");
    expect(msg).toContain("选择：A");
    expect(msg).toContain("自定义补充：custom text");
    expect(msg).toContain("整体补充：overall");
  });

  it("buildStructuredFeedbackMessage returns null for empty draft", () => {
    expect(buildStructuredFeedbackMessage({ draft: emptyDraft })).toBeNull();
  });
});
