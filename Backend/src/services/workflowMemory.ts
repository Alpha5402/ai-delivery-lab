import type { InterventionMessage, WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import { stepOrder } from "../domain/workflow.js";

export type RuntimeMemoryEntry = {
  stepId: WorkflowStepId;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: string;
};

export type RuntimeMemoryContext = {
  /** 当前 step 的全部介入记录，按时间排序 */
  currentStepMemory: RuntimeMemoryEntry[];
  /** 当前 step 之前所有 step 的 user/system 介入，按 step 顺序 + 时间排序 */
  upstreamMemory: RuntimeMemoryEntry[];
  /** 所有 role=user 的介入（全 workflow） */
  allUserDecisions: RuntimeMemoryEntry[];
  /** 短文本摘要，可直接塞入 Agent prompt */
  summary: string;
};

/**
 * 构建 Agent 运行时可用的 Runtime Memory 上下文。
 * 优先使用模块内统一的 functions，各 Agent 直接调用即可。
 */
export function buildRuntimeMemoryContext(
  run: WorkflowRun,
  currentStepId: WorkflowStepId,
): RuntimeMemoryContext {
  const currentIndex = stepOrder.indexOf(currentStepId);

  const currentStepMemory: RuntimeMemoryEntry[] = [];
  const upstreamMemory: RuntimeMemoryEntry[] = [];
  const allUserDecisions: RuntimeMemoryEntry[] = [];

  for (const step of run.steps) {
    const stepIndex = stepOrder.indexOf(step.id);
    if (!step.interventions) continue;

    for (const m of step.interventions) {
      const entry: RuntimeMemoryEntry = {
        stepId: step.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      };

      if (step.id === currentStepId) {
        currentStepMemory.push(entry);
      } else if (stepIndex < currentIndex) {
        upstreamMemory.push(entry);
      }

      if (m.role === "user") {
        allUserDecisions.push(entry);
      }
    }
  }

  // 构建短文本摘要（deterministic 拼接，不调用 LLM）
  const summaryLines: string[] = [];

  if (upstreamMemory.length > 0) {
    summaryLines.push("## 上游已确认/修正的运行记忆");
    for (const m of upstreamMemory) {
      if (m.role === "user") {
        const preview = m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content;
        summaryLines.push(`- [${m.stepId}] ${preview}`);
      }
    }
  }

  if (currentStepMemory.length > 0) {
    summaryLines.push("");
    summaryLines.push("## 当前步骤的历史反馈");
    for (const m of currentStepMemory) {
      if (m.role === "user") {
        const preview = m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content;
        summaryLines.push(`- [${m.stepId}] ${preview}`);
      }
    }
  }

  if (summaryLines.length === 0) {
    summaryLines.push("（暂无用户反馈）");
  }

  return {
    currentStepMemory,
    upstreamMemory,
    allUserDecisions,
    summary: summaryLines.join("\n"),
  };
}
