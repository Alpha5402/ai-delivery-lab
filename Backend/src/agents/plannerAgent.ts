import {
  type ClarificationOutput,
  type RequirementDraft,
  type SolutionDsl,
  solutionDslSchema,
} from "../domain/workflow.js";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";

export async function runPlannerAgent(
  requirement: RequirementDraft,
  clarification: ClarificationOutput,
): Promise<SolutionDsl> {
  const result = await callJsonLlmWithSchema([
    {
      role: "system",
      content: [
        "你是 Conduit 全栈方案设计 Agent。",
        "请根据 PM 需求和澄清结果输出 JSON，字段必须为 requirementId, scope, userStory, acceptanceCriteria, dataContract。",
        "scope 只能是 frontend, backend, fullstack。",
        "acceptanceCriteria 使用可验证条目，不要输出 Markdown。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({ requirement, clarification }),
    },
  ], solutionDslSchema, { label: "Planner Agent" });

  recordMetric({
    agent: "Planner Agent",
    calls: 1,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    estimatedCost: 0,
  });

  return result.content;
}
