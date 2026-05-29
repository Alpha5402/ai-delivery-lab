import type { SkillManifest } from "../skillTypes.js";

/**
 * cross-stack-add-field
 *
 * 匹配跨前后端的新增字段/属性需求（如文章封面图、新增数据列）。
 * 影响 module_mapping、code_generation、verification 三个 step 的 prompt。
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
  },
  steps: {
    module_mapping: {
      instructionAddon: [
        "  · 跨栈新增字段 Skill 已激活：必须同时定位以下三层。",
        "    1. 数据层：DB schema / migration 文件 / ORM 模型定义",
        "    2. API 层：路由 handler / DTO / 序列化层",
        "    3. 展示层：前端组件 / 类型定义 / API 调用",
        "  · 如果某层找不到对应文件，必须在 reason 中明确说明并标注为「需新增」。",
      ].join("\n"),
    },
    code_generation: {
      instructionAddon: [
        "  · 跨栈新增字段 Skill 已激活：代码计划必须覆盖三层。",
        "  · 至少包含：1 个数据层任务（migration/model）+ 1 个 API 适配任务 + 1 个前端展示任务。",
        "  · 每个新增字段的跨层一致性检验（字段名/类型/nullable 等）应作为单独校验任务或明确说明。",
        "  · 建议为 migration 回滚路径提供说明。",
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
