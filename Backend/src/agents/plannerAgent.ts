import type { RuntimeMemoryContext } from "../services/workflowMemory.js";
import {
  type ClarificationOutput,
  type RequirementDraft,
  type SolutionDsl,
  solutionDslSchema,
} from "../domain/workflow.js";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";

export type PlannerContext = {
  runtimeMemory?: RuntimeMemoryContext;
};

export async function runPlannerAgent(
  requirement: RequirementDraft,
  clarification: ClarificationOutput,
  context?: PlannerContext,
): Promise<SolutionDsl> {
  const systemLines = [
    "你是 AI Delivery Workspace 的方案生成 AI。",
    "请根据用户需求和确认结果输出 JSON，字段必须为 requirementId, scope, userStory, acceptanceCriteria, dataContract。",
    "scope 只能是 frontend, backend, fullstack。",
    "acceptanceCriteria 使用可验证条目，不要输出 Markdown。",
  ];

  if (context?.runtimeMemory) {
    systemLines.push(
      "你必须优先遵守 runtimeMemory 中用户明确确认/修正的约束。",
      "如果用户反馈与你原计划冲突，以用户反馈为准。",
      "澄清阶段用户确认的决策必须写入 acceptanceCriteria。",
      "不要重新引入已被用户否定的范围或设计。",
    );
  }

  const userPayload: Record<string, unknown> = { requirement, clarification };
  if (context?.runtimeMemory) {
    userPayload.runtimeMemory = context.runtimeMemory.summary;
  }

  const result = await callJsonLlmWithSchema([
    {
      role: "system",
      content: systemLines.join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(userPayload),
    },
  ], solutionDslSchema, { label: "生成方案" });

  recordMetric({
    agent: "生成方案",
    calls: 1,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    estimatedCost: 0,
  });

  return result.content;
}
