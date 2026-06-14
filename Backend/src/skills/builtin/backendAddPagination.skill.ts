import type { SkillManifest } from "../skillTypes.js";

/**
 * backend-add-pagination
 *
 * 匹配后端-only 的 API 分页/搜索/列表需求。
 * 主要影响 code_generation、verification。
 */
export const backendAddPagination: SkillManifest = {
  id: "backend-add-pagination",
  name: "后端分页与搜索",
  version: "1.0.0",
  requirementPatterns: ["cross-stack", "interaction", "unclear"],
  scopes: ["backend", "fullstack"],
  match: {
    keywords: [
      "分页", "pagination", "搜索", "search", "过滤", "filter",
      "排序", "sort", "列表", "limit", "offset", "page",
      "query", "查询", "筛选", "cursor",
    ],
    fileGlobs: ["**/routes/**", "**/controllers/**", "**/services/**", "**/repositories/**", "**/models/**"],
    routeHints: ["GET", "list", "findMany", "limit", "offset", "page", "paginate"],
  },
  steps: {
    code_generation: {
      instructionAddon: [
        "  · 后端分页与搜索 Skill 已激活：生成代码需区分以下任务。",
        "  · 参数校验：page/pageSize/sort/order/filters 的 DTO schema",
        "  · 数据查询：带 LIMIT/OFFSET 的 SQL 或 ORM 查询，含 WHERE 过滤 + ORDER BY 排序",
        "  · 响应封装：统一的分页响应结构 { data, pagination: { page, pageSize, total, totalPages } }",
        "  · 边界：空结果、无效分页参数（page<1, pageSize>100）、注入防护（sort 参数白名单）",
        "  · testRequired 对查询逻辑和边界测试必须为 true",
        "  · expectedChange 必须说明参数校验、查询层和响应结构分别如何变化。",
        "  · testIntent 必须覆盖默认分页、非法参数、空结果和排序白名单。",
      ].join("\n"),
    },
    verification: {
      instructionAddon: [
        "  · 后端分页与搜索 Skill 已激活：重点验证分页边界和参数校验。",
      ].join("\n"),
      verificationPolicyAddon: {
        required: ["npm:typecheck", "npm:test"],
        optional: ["npm:lint", "npm:build"],
      },
    },
  },
};
