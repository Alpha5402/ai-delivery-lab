import type { WorkflowStepId } from "../domain/workflow.js";

/**
 * 单个 Skill 对某个 workflow step 的注入规格。
 * 最终 prompt = 基础 agentSpec + stepRouter addon + skill addon。
 */
export type SkillStepSpec = {
  /** 追加到该 step 的 LLM instruction 末尾 */
  instructionAddon: string;
  /** 追加到输出契约末（可选） */
  outputContractAddon?: string;
  /** 建议 agent runtime 额外读取的文件 glob */
  contextHints?: string[];
  /** 给 verification 命令策略的附加项 */
  verificationPolicyAddon?: {
    required?: string[];
    optional?: string[];
  };
};

/**
 * Skill 注册清单。
 *
 * 设计原则：
 * - P0 为 repo 内 TypeScript 文件注册，保证可测试、可审计。
 * - P1 再做 UI 管理（GET /api/skills, Workbench 命中展示）。
 * - 不允许用户在 UI 中任意输入代码动态执行。
 */
export type SkillManifest = {
  /** 全局唯一 id，如 "frontend-display-computed-metric" */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 语义版本 */
  version: string;
  /** 该 Skill 匹配的 requirement patterns */
  requirementPatterns: Array<"frontend-only" | "cross-stack" | "interaction" | "unclear">;
  /** 该 Skill 匹配的 solution scopes */
  scopes: Array<"frontend" | "backend" | "fullstack">;
  /** 匹配规则：基于需求文本关键词 / 文件 glob / 路由提示 */
  match: {
    keywords?: string[];
    fileGlobs?: string[];
    routeHints?: string[];
  };
  /** 按 step 拆分的注入规格。仅填写该 Skill 关注的 step 即可。 */
  steps: Partial<Record<WorkflowStepId, SkillStepSpec>>;
};

/** Skill 命中原因的简要描述，用于 UI 展示 */
export type SkillMatchReason = {
  skillId: string;
  skillName: string;
  matchedPattern: string;
  matchedScope?: string;
  hitKeywords: string[];
};
