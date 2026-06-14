import type { SkillManifest } from "../skillTypes.js";

/**
 * cross-stack-add-field
 *
 * 匹配跨前后端的新增字段/属性需求（如文章封面图、新增数据列）。
 * 主要影响 code_generation、verification。
 */
export const crossStackAddField: SkillManifest = {
  id: "cross-stack-add-field",
  name: "跨栈新增字段",
  version: "1.0.0",
  requirementPatterns: ["cross-stack"],
  scopes: ["fullstack"],
  match: {
    keywords: [
      "新增字段", "封面图", "字段", "field", "column",
      "添加属性", "数据模型", "新增列", "schema", "migration",
      "数据库", "模型字段", "加一个字段",
    ],
    fileGlobs: ["**/schema**", "**/migration**", "**/models/**", "**/types/**", "**/api/**", "**/components/**"],
    routeHints: ["schema", "migration", "model", "DTO", "type", "field", "column"],
  },
  steps: {
    code_generation: {
      instructionAddon: [
        "  · 跨栈新增字段 Skill 已激活：生成代码必须覆盖三层。",
        "  · 至少包含：1 个数据层任务（migration/model）+ 1 个 API 适配任务 + 1 个前端展示任务。",
        "  · 每个新增字段的跨层一致性检验（字段名/类型/nullable 等）应作为单独校验任务或明确说明。",
        "  · 建议为 migration 回滚路径提供说明。",
        "  · expectedChange 必须说明字段从数据层到 API 再到 UI 的流动。",
        "  · testIntent 必须覆盖字段缺省值、读写往返和前端展示兼容。",
      ].join("\n"),
      outputContractAddon: "每个 task 应标注 coverLayer: data | api | ui。",
    },
    verification: {
      instructionAddon: [
        "  · 跨栈新增字段 Skill 已激活：verification 必须针对三层分别校验。",
      ].join("\n"),
      verificationPolicyAddon: {
        required: ["npm:typecheck", "npm:lint", "npm:test", "npm:build"],
        optional: [],
      },
    },
  },
};
