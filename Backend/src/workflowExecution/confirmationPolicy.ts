import type { ClarificationOutput, QualityGateResult, StepExecutionMode, StepRun, WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import type { ConfirmationPolicyAddon } from "../skills/skillTypes.js";

export type ConfirmationDecision = {
  shouldAutoContinue: boolean;
  nextStatus: StepRun["status"];
  reasons: string[];
  appliedPolicy?: {
    source: "settings" | "quality-gate" | "skill" | "clarification-complete";
    mode?: string;
  };
};

export type ResolveConfirmationDecisionInput = {
  run: WorkflowRun;
  stepId: WorkflowStepId;
  output: unknown;
  qualityGate: QualityGateResult;
  executionMode: StepExecutionMode;
  skillConfirmationPolicyAddon?: ConfirmationPolicyAddon;
};

/**
 * 集中决策 step 完成后应 auto-continue 还是 waiting-human/failed。
 *
 * 规则优先级（从高到低）：
 * 1. quality gate 非 auto-continue → 不自动推进（need-human / failed / block）
 * 2. Skill force-manual → waiting-human（覆盖一切自动规则）
 * 3. clarificationComplete 特殊规则 → auto
 * 4. Skill allow-auto → 在 manual 模式 + gate 通过时允许自动
 * 5. 默认：automatic + gate 通过 → auto, manual + gate 通过 → waiting-human
 */
export function resolveConfirmationDecision(
  input: ResolveConfirmationDecisionInput,
): ConfirmationDecision {
  const { stepId, output, qualityGate, executionMode, skillConfirmationPolicyAddon } = input;
  const gateDecision = qualityGate.decision;
  const addon = skillConfirmationPolicyAddon;
  const reasons: string[] = [];

  // ---- 基础 gate 不通过 → 不自动推进 ----
  if (gateDecision !== "auto-continue") {
    return {
      shouldAutoContinue: false,
      nextStatus: gateDecision === "block" ? "failed" : "waiting-human",
      reasons: [`quality gate: ${gateDecision}`],
      appliedPolicy: { source: "quality-gate" },
    };
  }

  // ---- compute requireHumanWhen checks ----
  const requireHumanReasons: string[] = [];
  if (addon?.requireHumanWhen && addon.requireHumanWhen.length > 0) {
    const outputRec = output as Record<string, unknown>;

    if (addon.requireHumanWhen.includes("open-questions")) {
      const questions = outputRec.questions as Array<{ status?: string }> | undefined;
      if (questions?.some((q) => q.status !== "resolved")) {
        requireHumanReasons.push("open-questions: 仍有未解决的问题");
      }
    }

    if (addon.requireHumanWhen.includes("low-confidence")) {
      const floor = addon.confidenceFloor ?? 0.7;
      const confidence = outputRec.confidence as number | undefined;
      if (confidence !== undefined && confidence < floor) {
        requireHumanReasons.push(`low-confidence: ${confidence} < ${floor}`);
      }
    }

    if (addon.requireHumanWhen.includes("risk-present")) {
      const questions = outputRec.questions as Array<{ riskIfUnanswered?: string; status?: string }> | undefined;
      if (questions?.some((q) => q.riskIfUnanswered && q.riskIfUnanswered.trim() && q.status !== "resolved")) {
        requireHumanReasons.push("risk-present: 存在未解决的高风险项");
      }
    }

    if (addon.requireHumanWhen.includes("writes-files")) {
      if (
        stepId === "repo_write" ||
        outputRec.appliedChanges != null ||
        outputRec.filesChanged != null ||
        outputRec.patches != null
      ) {
        requireHumanReasons.push("writes-files: 将修改文件");
      }
    }

    // TODO(PR3): "touches-api-contract" / "touches-data-model" 暂不做脆弱启发式
  }

  // ---- Skill force-manual → 最高优先中断自动推进（除 gate 失败外） ----
  if (addon?.mode === "force-manual") {
    reasons.push("Skill force-manual: 强制人工审核");
    if (requireHumanReasons.length > 0) reasons.push(...requireHumanReasons);
    return {
      shouldAutoContinue: false,
      nextStatus: "waiting-human",
      reasons,
      appliedPolicy: { source: "skill", mode: "force-manual" },
    };
  }

  // ---- requireHumanWhen → 即使 gate 通过也等待（force-manual 已在上面处理） ----
  if (requireHumanReasons.length > 0) {
    reasons.push(...requireHumanReasons);
    return {
      shouldAutoContinue: false,
      nextStatus: "waiting-human",
      reasons,
      appliedPolicy: { source: "skill" },
    };
  }

  // ---- clarificationComplete 特殊规则 ----
  const isClarificationComplete =
    stepId === "clarification" &&
    (output as ClarificationOutput).clarificationComplete === true;

  if (isClarificationComplete) {
    reasons.push("clarificationComplete: 澄清已完成");
    return {
      shouldAutoContinue: true,
      nextStatus: "success",
      reasons,
      appliedPolicy: { source: "clarification-complete" },
    };
  }

  // ---- pull_request Phase 2 已经完成真实 push / PR 创建，不需要再二次确认 ----
  if (stepId === "pull_request") {
    const outputRec = output as Record<string, unknown>;
    if (outputRec.status === "ready" || outputRec.pushed === true) {
      return {
        shouldAutoContinue: true,
        nextStatus: "success",
        reasons: ["pull_request completed"],
        appliedPolicy: { source: "quality-gate" },
      };
    }
  }

  // ---- Skill allow-auto → 覆盖 manual 模式 ----
  if (addon?.mode === "allow-auto") {
    reasons.push("Skill allow-auto: 允许自动推进");
    return {
      shouldAutoContinue: true,
      nextStatus: "success",
      reasons,
      appliedPolicy: { source: "skill", mode: "allow-auto" },
    };
  }

  // ---- 默认：execution mode 决定 ----
  if (executionMode === "automatic") {
    return {
      shouldAutoContinue: true,
      nextStatus: "success",
      reasons: ["automatic mode + gate passed"],
      appliedPolicy: { source: "settings" },
    };
  }

  reasons.push("manual-confirmation mode");
  return {
    shouldAutoContinue: false,
    nextStatus: "waiting-human",
    reasons,
    appliedPolicy: { source: "settings" },
  };
}
