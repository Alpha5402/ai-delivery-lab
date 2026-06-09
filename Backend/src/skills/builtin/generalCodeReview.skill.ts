import type { SkillManifest } from "../skillTypes.js";

export const generalCodeReview: SkillManifest = {
  id: "general-code-review",
  name: "普适代码审查",
  version: "1.0.0",
  requirementPatterns: ["frontend-only", "cross-stack", "interaction", "unclear"],
  scopes: ["frontend", "backend", "fullstack"],
  match: {
    keywords: ["修改", "实现", "新增", "修复", "重构", "测试", "单元测试", "接口", "页面", "组件", "API", "schema", "model", "service", "bug", "feature"],
    fileGlobs: ["src/**/*.{ts,tsx,js,jsx}", "backend/**/*.{ts,js}", "frontend/**/*.{ts,tsx,js,jsx}", "**/*.{test,spec}.{ts,tsx,js,jsx}"],
    routeHints: ["src", "components", "routes", "services", "models", "controllers", "utils", "tests"],
  },
  steps: {
    code_review: {
      instructionAddon: [
        "普适代码审查 Skill 已激活：从代码交付质量角度审查生成结果。",
        "必须基于真实 diff / filesChanged 审查，不要凭空评价未变更文件。",
        "优先级：功能正确性 > 数据/接口契约 > 安全和副作用 > 测试覆盖 > 可维护性 > 风格。",
        "检查 testRequired=true 的任务是否有对应测试文件，diff 中是否包含测试。",
        "不要要求无意义的测试；只指出会影响信心的缺口。",
        "blocker/major 需要给出可执行修复建议。",
        "不要输出长源码，不要重复 diff。",
      ].join("\n"),
      outputContractAddon: "findings 必须按严重程度排序。reviewedFiles 必须来自真实变更。decision 只能在无 blocker/major 时 approve。",
      confirmationPolicyAddon: {
        mode: "force-manual",
        reason: "代码审查涉及质量判断，默认需要用户确认。",
        requireHumanWhen: ["risk-present", "writes-files"],
        confidenceFloor: 0.7,
      },
    },
  },
};
