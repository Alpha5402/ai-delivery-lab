import type { SkillManifest } from "../skillTypes.js";

/**
 * frontend-display-computed-metric
 *
 * 匹配前端-only 的计算指标展示需求（如字数统计、阅读时长、阅读量展示）。
 * 主要影响 code_generation、verification。
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
    fileGlobs: [
      "src/components/**/*.js",
      "src/components/**/*.jsx",
      "src/components/**/*.ts",
      "src/components/**/*.tsx",
      "src/routes/**/*.js",
      "src/routes/**/*.jsx",
      "src/routes/**/*.ts",
      "src/routes/**/*.tsx",
      "src/hooks/**",
      "src/utils/**",
      "src/helpers/**",
    ],
    routeHints: ["Article", "Post", "文章", "body", "markdown", "page", "component"],
  },
  steps: {
    code_generation: {
      instructionAddon: [
        "  · 前端计算指标展示 Skill 已激活：生成代码需区分三类任务。",
        "  · UI 渲染：组件展示指标值 + 加载/空/错误状态",
        "  · 纯逻辑：计算函数（字数、阅读时长等），要求纯函数且可测试",
        "  · 边界：空字符串、超长文本、特殊字符（Markdown 标记/HTML 标签）的处理",
        "  · testRequired 对纯逻辑任务必须为 true。",
        "  · expectedChange 必须分别说明计算逻辑如何接入数据源、UI 展示位置、边界处理方式。",
        "  · 页面展示必须接入现有路由真实使用的页面组件；如果已有 routes/Article/Article.jsx，不要新增 routes/Article.jsx 这种平行页面。",
        "  · 新增 helper/component 后，必须在真实页面组件中 import 并使用，否则视为未完成接入。",
        "  · testIntent 必须覆盖纯函数边界，而不是只写组件能渲染。",
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
