import {
  type ClarificationOutput,
  type RequirementDraft,
  clarificationOutputSchema,
} from "../domain/workflow.js";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";

export async function runClarifierAgent(requirement: RequirementDraft): Promise<ClarificationOutput> {
  const result = await callJsonLlmWithSchema([
    {
      role: "system",
      content: [
        "你是 Conduit 全栈需求澄清 Agent。",
        "请把 PM 需求整理为 JSON，字段必须为 summary, questions, confidence。",
        "questions 中每项必须包含 id, question, answer, riskIfUnanswered。",
        "如果信息不足，answer 使用空字符串，并解释 unanswered 风险。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(requirement),
    },
  ], clarificationOutputSchema, { label: "Clarifier Agent" });

  recordMetric({
    agent: "Clarifier Agent",
    calls: 1,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    estimatedCost: 0,
  });

  return result.content;
}
