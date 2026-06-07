import type { SkillManifest } from "../skillTypes.js";

/**
 * frontend-display-computed-metric
 *
 * 匹配前端-only 的计算指标展示需求（如字数统计、阅读时长、阅读量展示）。
 * 影响 module_mapping、code_generation、verification 三个 step 的 prompt。
 */
export const frontendDisplayComputedMetric: SkillManifest = {
  id: "frontend-display-computed-metric",
  name: "前端计算指标展示",
  version: "1.0.0",
  requirementPatterns: ["frontend-only"],
  scopes: ["frontend"],
  match: {
    keywords: [
      "字数统计", "阅读时长", "阅读量", "统计", "计数",
      "展示", "指标", "computed", "metric", "view count",
      "like count", "点赞数", "评论数", "字符数",
    ],
    fileGlobs: ["src/components/**/*.tsx", "src/routes/**/*.tsx", "src/hooks/**", "src/utils/**"],
    routeHints: ["Article", "Post", "文章", "body", "markdown", "page", "component"],
  },
  steps: {
    module_mapping: {
      instructionAddon: [
        "  · 前端计算指标展示 Skill 已激活：优先定位以下模式。",
        "    1. 展示组件：渲染指标值的 UI 组件",
        "    2. 计算逻辑：hook/util 中的纯计算函数（不要重复实现）",
        "    3. 数据源：API 响应字段 / store selector / props",
        "  · 确认计算逻辑与展示逻辑是否分离，如未分离建议在 reason 中提出重构方向。",
      ].join("\n"),
    },
    code_generation: {
      instructionAddon: [
        "  · 前端计算指标展示 Skill 已激活：准备修改需区分三类任务。",
        "  · UI 渲染：组件展示指标值 + 加载/空/错误状态",
        "  · 纯逻辑：计算函数（字数、阅读时长等），要求纯函数且可测试",
        "  · 边界：空字符串、超长文本、特殊字符（Markdown 标记/HTML 标签）的处理",
        "  · testRequired 对纯逻辑任务必须为 true。",
      ].join("\n"),
    },
    verification: {
      instructionAddon: [
        "  · 前端计算指标展示 Skill 已激活：重点验证计算逻辑边界。",
      ].join("\n"),
      verificationPolicyAddon: {
        required: ["npm:typecheck", "npm:lint", "npm:test"],
        optional: ["npm:build"],
      },
    },
  },
};
