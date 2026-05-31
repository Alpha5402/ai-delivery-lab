import { z } from "zod";

/**
 * Step 确认策略：
 * - automatic: 该 step 产出后质量门通过即自动推进
 * - manual-confirmation: 该 step 产出后无论质量门结果都停等人工确认
 */
export const stepConfirmationPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }),
  z.object({ mode: z.literal("manual-confirmation"), reason: z.string().optional() }),
]);

export type StepConfirmationPolicy = z.infer<typeof stepConfirmationPolicySchema>;

/**
 * 单步定义：描述 workflow 中一个 step 的元信息。
 * agentProfileId / verifierProfileId 引用 AgentProfile 和 VerifierProfile（PR3 实现）。
 * PR1 阶段这些 id 仅作为 metadata 存在，实际执行仍走硬编码。
 */
export const workflowStepDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  agent: z.string().min(1),
  agentProfileId: z.string().min(1),
  verifierProfileId: z.string().min(1),
  outputSchemaId: z.string().min(1),
  defaultExecutionMode: z.enum(["automatic", "manual-confirmation"]),
  confirmationPolicy: stepConfirmationPolicySchema.optional(),
  /** 依赖的前置 step id 列表，为空表示无依赖 */
  inputRefs: z.array(z.string()).default([]),
});

export type WorkflowStepDefinition = z.infer<typeof workflowStepDefinitionSchema>;

/**
 * WorkflowTemplate：声明流程步骤顺序、默认审核策略、输入输出元信息。
 * PR1 只做 metadata，实际编排仍在 workflowService。
 */
export const workflowTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.number().int().positive(),
  steps: z.array(workflowStepDefinitionSchema).min(1),
});

export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
