import {
  type ClarificationOutput,
  type RequirementDraft,
  clarificationOutputSchema,
} from "../domain/workflow.js";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";

export type ClarifierFollowUpInput = {
  /** 上一轮 confidence 不足时,把上次产出与未答问题一并塞回让 LLM 提出新一轮澄清。 */
  previousOutput: ClarificationOutput;
  reasons: string[];
};

export async function runClarifierAgent(
  requirement: RequirementDraft,
  followUp?: ClarifierFollowUpInput,
): Promise<ClarificationOutput> {
  const systemLines = [
    "你是 Conduit 全栈需求澄清 Agent。",
    "请把 PM 需求整理为 JSON,字段必须为 summary, questions, confidence。",
    "questions 中每项必须包含 id, question, answer, riskIfUnanswered。",
    "如果信息不足,answer 使用空字符串,并解释 unanswered 风险。",
  ];
  if (followUp) {
    systemLines.push(
      "本次为追问轮:上一轮 confidence 不足或存在高风险未回答问题,请基于以下上下文重新生成澄清结果,可以保留或更新原有问题,补充新的关键问题,提高 confidence。",
    );
  }

  const userPayload: Record<string, unknown> = { requirement };
  if (followUp) {
    userPayload.previousClarification = followUp.previousOutput;
    userPayload.gateReasons = followUp.reasons;
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
  ], clarificationOutputSchema, { label: followUp ? "Clarifier Agent (follow-up)" : "Clarifier Agent" });

  recordMetric({
    agent: followUp ? "Clarifier Agent (follow-up)" : "Clarifier Agent",
    calls: 1,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    estimatedCost: 0,
  });

  return result.content;
}
