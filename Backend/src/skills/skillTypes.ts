import { z } from "zod";
import type { WorkflowStepId } from "../domain/workflow.js";
import { workflowStepIdSchema } from "../domain/workflow.js";

/**
 * 单个 Skill 对某个 workflow step 的注入规格。
 * 最终 prompt = 基础 agentSpec + stepRouter addon + skill addon。
 */
export type SkillStepSpec = {
  /** 追加到该 step 的 LLM instruction 末尾 */
  instructionAddon?: string;
  /** 追加到输出契约末（可选） */
  outputContractAddon?: string;
  /** 建议 agent runtime 额外读取的文件 glob */
  contextHints?: string[];
  /** 给 verification 命令策略的附加项 */
  verificationPolicyAddon?: {
    required?: string[];
    optional?: string[];
  };
  /** 确认策略增强（PR2 只注册透传，PR3 执行） */
  confirmationPolicyAddon?: ConfirmationPolicyAddon;
};

// ---- Zod schemas (供 JSON Skill 校验) ----

const verificationPolicyAddonSchema = z.object({
  required: z.array(z.string()).optional(),
  optional: z.array(z.string()).optional(),
}).optional();

export const confirmationPolicyAddonSchema = z.object({
  mode: z.enum(["force-manual", "allow-auto", "inherit"]).optional(),
  reason: z.string().optional(),
  requireHumanWhen: z.array(z.enum([
    "open-questions",
    "low-confidence",
    "risk-present",
    "writes-files",
    "touches-api-contract",
    "touches-data-model",
  ])).optional(),
  confidenceFloor: z.number().min(0).max(1).optional(),
}).optional();

const skillStepSpecSchema = z.object({
  instructionAddon: z.string().optional(),
  outputContractAddon: z.string().optional(),
  contextHints: z.array(z.string()).optional(),
  verificationPolicyAddon: verificationPolicyAddonSchema,
  confirmationPolicyAddon: confirmationPolicyAddonSchema,
});

const skillStepsSchema = z.record(workflowStepIdSchema, skillStepSpecSchema).optional();

const skillTagArraySchema = z.preprocess(
  (value) => {
    if (!Array.isArray(value)) return value;
    return Array.from(new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : item))
        .filter((item): item is string => typeof item === "string" && item.length > 0),
    ));
  },
  z.array(z.string().min(1)).min(1),
);

export const skillManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().min(1),
  requirementPatterns: skillTagArraySchema,
  scopes: skillTagArraySchema,
  match: z.object({
    keywords: z.array(z.string()).optional(),
    fileGlobs: z.array(z.string()).optional(),
    routeHints: z.array(z.string()).optional(),
  }),
  steps: skillStepsSchema,
});

// ---- 原始 TypeScript 类型（向后兼容，同时从 schema 派生） ----

export type ConfirmationPolicyAddon = z.infer<typeof confirmationPolicyAddonSchema>;

/**
 * Skill 注册清单。
 *
 * 设计原则：
 * - P0 为 repo 内 TypeScript 文件注册，保证可测试、可审计。
 * - P1 再做 UI 管理（GET /api/skills, Workbench 命中展示）。
 * - P2 支持 JSON 声明式注册，Zod 校验。
 * - 不允许用户在 UI 中任意输入代码动态执行。
 */
export type SkillManifest = z.infer<typeof skillManifestSchema> & {
  /** 注册来源 */
  source?: "builtin" | "json";
};

/** Skill 命中原因的简要描述，用于 UI 展示 */
export type SkillMatchReason = {
  skillId: string;
  skillName: string;
  matchedPattern: string;
  matchedScope?: string;
  hitKeywords: string[];
  /** fileGlobs 匹配命中的 pattern */
  hitFileGlobs?: string[];
  /** fileGlobs 匹配命中的具体文件路径（截断到 10） */
  hitFiles?: string[];
  /** routeHints 匹配命中的 hint */
  hitRouteHints?: string[];
  score?: number;
};
