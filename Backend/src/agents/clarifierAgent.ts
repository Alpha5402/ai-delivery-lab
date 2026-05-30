import {
  type ClarificationOutput,
  type RequirementDraft,
  clarificationOutputSchema,
} from "../domain/workflow.js";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";

import type { RuntimeMemoryContext } from "../services/workflowMemory.js";

export type ClarifierFollowUpInput = {
  /** 上一轮产出，带进 prompt 让 LLM 知道已经问过什么、用户回答了什么 */
  previousOutput?: ClarificationOutput;
  /** quality gate 的失败原因（repair 场景） */
  reasons?: string[];
  /** 用户在前端提交的反馈——选择 + 自定义文本 */
  userInterventions?: string[];
  /** 统一 Runtime Memory 上下文 */
  runtimeMemory?: RuntimeMemoryContext;
};

export async function runClarifierAgent(
  requirement: RequirementDraft,
  followUp?: ClarifierFollowUpInput,
): Promise<ClarificationOutput> {
  const systemLines = [
    "你是 Conduit 全栈需求澄清 Agent。请分析 PM 需求并输出 JSON。",
    "",
    "## 输出字段",
    "必须包含 summary, decisions, questions, clarificationComplete, confidence。",
    "",
    "### decisions[] — 已解决的规则/决策",
    "每项含 id, title, question, finalAnswer, source。",
    "  - source: \"agent-inferred\"（Agent 自行推断）或 \"user-confirmed\"（用户反馈确认）",
    "  - 这些决策将传递给 solution_design 使用，不会显示给用户再次审核",
    "",
    "### questions[] — 仍需用户审核的开放问题",
    "每项含 id, title, question, answer, riskIfUnanswered, status。",
    "  - status: \"open\"（仍需审核）或 \"resolved\"（已解决，兼容用）",
    "  - title: 4-12 个中文字符的短标题，概括业务决策点",
    "  - 不要输出 status=\"resolved\" 的问题——已解决的放 decisions，不要放 questions",
    "  - responseControl (可选): 选择题控制",
    "    - type: \"single\"(单选) 或 \"multiple\"(多选)",
    "    - options: 2-4 个选项，每项含 id, label, description(可选)",
    "    - 互斥决策用 single, 可组合约束用 multiple",
    "",
    "### clarificationComplete",
    "  - true: 所有核心规则已清楚，不需要继续追问",
    "  - false: 仍存在需要用户决策的开放问题",
    "",
    "### confidence",
    "  - 0-1 之间，表示对当前澄清结果的信心",
    "  - clarificationComplete=true 时 confidence 应 ≥ 0.8",
    "",
    "## 核心规则",
    "1. 能从 PM 需求直接推断的规则 → decisions[]，source=\"agent-inferred\"",
    "2. 需要用户决策的问题 → questions[]",
    "3. 已解决的问题不要继续放 questions[]——提取为 decisions[]",
    "4. 如果用户反馈中已明确回答某个问题 → 该问题进入 decisions[]，question 保留原问题，finalAnswer 记录用户回答",
    "5. 不要原样复制上一轮 questions 到本轮",
    "",
    "## 示例",
    `{
      "summary": "用户要求文章展示字数统计，需确认统计规则和展示方式",
      "decisions": [
        {"id": "d1", "title": "统计目标", "question": "字数统计针对什么内容？", "finalAnswer": "文章正文内容", "source": "agent-inferred"}
      ],
      "questions": [{
        "id": "q1", "title": "字数统计规则", "question": "是否排除 Markdown 标记？",
        "answer": "", "riskIfUnanswered": "统计结果不准确", "status": "open",
        "responseControl": {"type": "single", "options": [
          {"id": "a", "label": "仅统计纯文本"},
          {"id": "b", "label": "包含全部字符"}
        ]}
      }],
      "clarificationComplete": false,
      "confidence": 0.8
    }`,
  ];
  if (followUp) {
    systemLines.push(
      "## 追问轮",
      "本次是追问轮。用户已经审阅了上一轮的澄清结果并提交了反馈。",
      "请基于用户的反馈重新生成澄清结果。",
      "重要规则：",
      "  - 已被用户选择/回答的问题视为已解决，将其答案沉淀到 answer 字段，不要再重复追问",
      "  - 用户在自定义补充中明确指定了约束的，直接采纳到 answer 或用于调整问题",
      "  - 只追问用户尚未明确答复的剩余问题",
      "  - 如果用户的反馈解决了大部分问题，confidence 应显著提高（≥0.85）",
      "  - 可以调整已有问题的 title/question 使其更聚焦，但保留原来的 id 以便前端追踪",
      "  - 上一轮已确认的问题如果用户反馈没有异议，保留即可",
    );
    if (followUp.reasons && followUp.reasons.length > 0) {
      systemLines.push(`上一轮 quality gate 未通过原因: ${followUp.reasons.join("; ")}`);
    }
  }

  const userPayload: Record<string, unknown> = { requirement };
  if (followUp) {
    if (followUp.previousOutput) {
      userPayload.previousClarification = followUp.previousOutput;
    }
    if (followUp.userInterventions && followUp.userInterventions.length > 0) {
      userPayload.userInterventions = followUp.userInterventions;
    }
    if (followUp.runtimeMemory) {
      userPayload.runtimeMemory = followUp.runtimeMemory.summary;
    }
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

  // Zod .default() 的 TS 类型推断有时给 input type；safeParse 保证 output fields 已 fill
  return result.content as ClarificationOutput;
}
