import { randomUUID } from "node:crypto";
import { runClarifierAgent } from "../agents/clarifierAgent.js";
import { runPlannerAgent } from "../agents/plannerAgent.js";
import { runWorkflowStepAgent } from "../agents/workflowStepAgent.js";
import {
  type ClarificationOutput,
  type InterventionMessage,
  type QualityGateResult,
  type RequirementDraft,
  type StepCheck,
  type StepRun,
  type WorkflowRun,
  type WorkflowStepId,
  stepAgents,
  stepLabels,
  stepOrder,
} from "../domain/workflow.js";
import { getCurrentWorkspace } from "./workspaceService.js";
import { deleteWorkflowRunFromStore, getStoredWorkflowRun, saveWorkflowRunToStore } from "./workspaceStore.js";
import { workflowEventBus } from "./workflowEvents.js";
import { getStepExecutionMode } from "./workflowSettingsService.js";
import { runStepVerifier, type VerifierResult } from "./stepVerifiers.js";

const runs = new Map<string, WorkflowRun>();

/**
 * 标记某个 run 是否正在被后台 promise 推进，避免并发 autoContinue 重入。
 */
const advancing = new Set<string>();

/** 读缓存 TTL：5 分钟未访问则从内存淘汰 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cacheTimestamps = new Map<string, number>();

function touchCache(runId: string) {
  cacheTimestamps.set(runId, Date.now());
}

/** 定期淘汰过期缓存条目（每分钟执行一次） */
setInterval(() => {
  const threshold = Date.now() - CACHE_TTL_MS;
  for (const [runId, ts] of cacheTimestamps.entries()) {
    if (ts < threshold && !advancing.has(runId)) {
      runs.delete(runId);
      cacheTimestamps.delete(runId);
    }
  }
}, 60_000).unref();

function now() {
  return new Date().toISOString();
}

function createSteps(requirement: RequirementDraft): StepRun[] {
  return stepOrder.map((stepId, index) => ({
    id: stepId,
    label: stepLabels[stepId],
    agent: stepAgents[stepId],
    status: index === 0 ? "success" : "idle",
    input: index === 0 ? { source: "pm" } : undefined,
    output: index === 0 ? requirement : undefined,
    startedAt: index === 0 ? now() : undefined,
    finishedAt: index === 0 ? now() : undefined,
    logs: index === 0 ? ["PM 需求已接收", "Runtime Trigger 已创建，自动进入 Clarifier Agent"] : [],
    interventions: index === 0 ? [{
      id: `${stepId}-agent-${Date.now()}`,
      stepId,
      role: "agent",
      content: "已接收需求，Runtime 将自动进入下一个 Agent Step。",
      createdAt: now(),
    }] : [],
    replayCount: 0,
    history: [],
  }));
}

/**
 * 对一个有 output 的 step 进行快照（记录当前状态到 history）。
 * 如果 step 没有 output（idle 状态），返回 null 不做快照。
 */
function snapshotStep(step: StepRun, reason: "replay" | "regenerate") {
  if (!step.output) return null;
  return {
    id: `snapshot-${randomUUID()}`,
    output: step.output,
    logs: [...step.logs],
    interventions: step.interventions ? [...step.interventions] : undefined,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    createdAt: now(),
    reason,
  };
}

function persistRun(run: WorkflowRun) {
  const projectId = run.projectId ?? getCurrentWorkspace()?.id;
  if (projectId) {
    saveWorkflowRunToStore(projectId, { ...run, projectId });
  }
}

/**
 * 统一的"持久化 → 缓存写回 → SSE 广播"出口。
 * SQLite 是 source-of-truth，内存 Map 仅为读缓存。
 * 任何 mutate 完成后必须调用一次。
 */
function commitRun(run: WorkflowRun) {
  run.updatedAt = now();
  // 1. 尝试写 SQLite（source-of-truth），失败记录日志但不阻断内存状态机。
  //    内存缓存 + SSE 广播仍正常进行，避免持久化瞬时故障导致整个 workflow 卡死。
  try {
    persistRun(run);
  } catch (err) {
    console.error(
      JSON.stringify({
        scope: "workflow",
        event: "persist.degraded",
        runId: run.id,
        message: err instanceof Error ? err.message : "unknown SQLite write error",
        timestamp: new Date().toISOString(),
      }),
    );
    // 标记本次 commit 持久化降级，方便调试和运维排查
    (run as Record<string, unknown>)._persistDegraded = true;
  }
  // 2. 再更新内存缓存
  runs.set(run.id, run);
  touchCache(run.id);
  // 3. 广播 SSE
  workflowEventBus.emitUpdate(run);
  return run;
}

export function getWorkflowRun(runId: string) {
  // 1. 读缓存
  const cached = runs.get(runId);
  if (cached) {
    touchCache(runId);
    return cached;
  }

  // 2. Cache miss → 从 SQLite 加载
  const stored = getStoredWorkflowRun(runId) ?? undefined;
  if (stored) {
    runs.set(stored.id, stored);
    touchCache(stored.id);
  }

  return stored;
}

export async function createWorkflowRun(input: RequirementDraft & { projectId?: string }) {
  const timestamp = now();
  const run: WorkflowRun = {
    id: `run-${randomUUID()}`,
    title: input.title,
    createdAt: timestamp,
    updatedAt: timestamp,
    projectId: input.projectId ?? getCurrentWorkspace()?.id,
    activeStepId: "clarification",
    steps: createSteps(input),
  };

  commitRun(run);

  // 立即返回快照，autoContinue 在后台推进；前端通过 SSE 拿到增量。
  void scheduleAutoContinue(run.id);

  return run;
}

export function updateStepOutput(runId: string, stepId: WorkflowStepId, output: unknown) {
  const run = getExistingRun(runId);
  const stepIndex = stepOrder.indexOf(stepId);

  run.steps = run.steps.map((step) => {
    if (step.id === stepId) {
      return { ...step, output, logs: [...step.logs, "人工修订了 Step JSON 输出"] };
    }
    return step;
  });

  // 向下传播：刷新下一步的 input 保持前端展示与后端 resolveStepOutput 一致。
  run.steps = propagateInputDownstream(run.steps, stepIndex, output);

  return commitRun(run);
}

export function replayFromStep(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const replayIndex = stepOrder.indexOf(stepId);
  run.activeStepId = stepId;
  run.steps = run.steps.map((step, index) => {
    if (index < replayIndex) {
      return step;
    }

    // 快照当前状态（仅有 output 时才快照，避免记录空 step）
    const snapshot = snapshotStep(step, "replay");
    const updatedHistory = snapshot ? [...(step.history ?? []), snapshot] : (step.history ?? []);
    const updatedCount = snapshot ? (step.replayCount ?? 0) + 1 : (step.replayCount ?? 0);

    if (index === replayIndex) {
      return {
        ...step,
        status: "idle",
        output: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        logs: [...step.logs, "从这里开始重放下游流程", "Runtime 将根据 Step 模式自动继续，直到需要人工介入"],
        replayCount: updatedCount,
        history: updatedHistory,
      };
    }

    return {
      ...step,
      status: "idle",
      output: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      logs: [],
      replayCount: updatedCount,
      history: updatedHistory,
    };
  });
  commitRun(run);

  // 立即触发后台续跑（保留 replay 语义，但状态机由 runStep 接管）。
  void scheduleAutoContinue(run.id, stepId);
  return run;
}

/**
 * 显式确认某个处于 waiting-human 的步骤，并触发后续 autoContinue。
 * 与 runStep（"重新生成"）严格区分，避免之前两种语义共用一个入口的歧义。
 */
export function confirmStep(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const stepIndex = stepOrder.indexOf(stepId);
  const step = run.steps[stepIndex];
  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  if (step.status !== "waiting-human") {
    throw new Error(`Step ${stepId} is not waiting for confirmation (status=${step.status})`);
  }

  if (step.output === undefined) {
    throw new Error(`Step ${stepId} has no output to confirm`);
  }

  const nextStepId = stepOrder[stepIndex + 1] ?? stepId;
  run.activeStepId = nextStepId;
  run.steps = run.steps.map((current) => {
    if (current.id === stepId) {
      return {
        ...current,
        status: "success",
        finishedAt: current.finishedAt ?? now(),
        logs: [...current.logs, "User confirmed; Runtime auto-continue resumed"],
      };
    }
    return current;
  });
  run.steps = propagateInputDownstream(run.steps, stepIndex, step.output);
  commitRun(run);

  workflowEventBus.emitStepEvent({
    type: "step",
    runId: run.id,
    stepId,
    phase: "completed",
    message: "user-confirmed",
  });

  void scheduleAutoContinue(run.id);
  return run;
}

/**
 * 总是"重新生成当前 step 的 output"。
 *
 * 进入此函数时无论 step 当前是什么状态，都会：
 * - 立即写入 running 快照并广播；
 * - 在后台 promise 中调用对应 Agent；
 * - 完成后根据执行模式（automatic vs manual-confirmation）决定是否继续推进；
 * - 失败则把 step 标 failed 并广播。
 */
export async function runStep(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const stepIndex = stepOrder.indexOf(stepId);
  const step = run.steps[stepIndex];

  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  // 显式 reset：消除旧的 waiting-human / failed 等状态，确保语义清晰。
  // 在 reset 前快照当前 step（仅有 output 时）以保留重跑历史。
  run.activeStepId = stepId;
  run.steps = run.steps.map((current) => {
    if (current.id !== stepId) return current;
    const snapshot = snapshotStep(current, "regenerate");
    return {
      ...current,
      status: "running",
      output: undefined,
      startedAt: now(),
      finishedAt: undefined,
      logs: [...current.logs, `${current.agent} started`],
      replayCount: snapshot ? (current.replayCount ?? 0) + 1 : (current.replayCount ?? 0),
      history: snapshot ? [...(current.history ?? []), snapshot] : (current.history ?? []),
    };
  });
  commitRun(run);

  workflowEventBus.emitStepEvent({
    type: "step",
    runId: run.id,
    stepId,
    phase: "started",
  });

  // 后台异步推进；调用方拿到的是"刚切到 running"的快照。
  void executeStepAndAdvance(run.id, stepId);

  return runs.get(run.id) ?? run;
}

async function executeStepAndAdvance(runId: string, stepId: WorkflowStepId) {
  const stepIndex = stepOrder.indexOf(stepId);
  const MAX_REPAIR_ATTEMPTS = 1;

  try {
    const run = getExistingRun(runId);

    // ---- 先切换到 running，让 SSE 前端立刻看到进度 ----
    run.steps = run.steps.map((current) =>
      current.id === stepId
        ? { ...current, status: "running" as const, startedAt: current.startedAt ?? now() }
        : current,
    );
    commitRun(run);
    workflowEventBus.emitStepEvent({
      type: "step",
      runId,
      stepId,
      phase: "started",
    });

    // ---- 生成 → 校验 → (可选)修复一次 ----
    let output = await resolveStepOutput(run, stepId);
    const workspace = getCurrentWorkspace() ?? undefined;
    let verifier: VerifierResult = runStepVerifier(stepId, output, workspace);
    let repairAttempts = 0;
    const repairLogs: string[] = [];

    while (
      verifier.qualityGate.decision === "repair" &&
      repairAttempts < MAX_REPAIR_ATTEMPTS
    ) {
      repairAttempts += 1;
      repairLogs.push(`触发自动修复 (attempt ${repairAttempts}/${MAX_REPAIR_ATTEMPTS})`);
      for (const reason of verifier.qualityGate.reasons) {
        repairLogs.push(`  · 待修复: ${reason}`);
      }
      // 简化版 repair 策略:把上一轮 output + reasons 作为 followUp 上下文塞回 agent。
      // clarification 走 ClarifierAgent 的 follow-up 分支;其他 step 暂时直接重跑(由 LLM 自身在新 prompt 中重试)。
      try {
        const followUp = stepId === "clarification"
          ? { previousOutput: output, reasons: verifier.qualityGate.reasons }
          : undefined;
        output = await resolveStepOutput(run, stepId, followUp ? { followUp } : undefined);
        verifier = runStepVerifier(stepId, output, workspace);
        verifier.qualityGate.repairAttempts = repairAttempts;
      } catch (error) {
        repairLogs.push(`修复执行失败: ${error instanceof Error ? error.message : "unknown"}`);
        break;
      }
    }

    const latest = getExistingRun(runId);
    const mode = getStepExecutionMode(stepId);
    const gateDecision = verifier.qualityGate.decision;

    // 真正决定是否自动续跑的复合条件:
    //  - 配置允许 automatic
    //  - 且 quality gate 判定 auto-continue
    const shouldAutoContinue = mode === "automatic" && gateDecision === "auto-continue";

    // gate 即使配置 automatic,只要不是 auto-continue 就要落到对应中间态:
    //  - need-human / repair / block → waiting-human(repair 由专门循环处理,见 P1.4)
    const nextStatus: StepRun["status"] = shouldAutoContinue
      ? "success"
      : gateDecision === "block"
        ? "failed"
        : "waiting-human";

    const nextStepId = stepOrder[stepIndex + 1] ?? stepId;
    latest.activeStepId = shouldAutoContinue ? nextStepId : stepId;

    const gateLogs = buildGateLogs(verifier.qualityGate, mode);

    latest.steps = latest.steps.map((current, index) => {
      if (current.id === stepId) {
        const repairPhases = repairAttempts > 0 ? [{
          id: `${stepId}-repair-${Date.now()}`,
          kind: "repair" as const,
          name: `自动修复 ${repairAttempts} 次`,
          status: gateDecision === "auto-continue" ? "success" as const : "failed" as const,
          finishedAt: now(),
          message: repairLogs.join("; "),
        }] : [];
        return {
          ...current,
          status: nextStatus,
          output,
          finishedAt: now(),
          checks: verifier.checks,
          qualityGate: verifier.qualityGate,
          repairAttempts: (current.repairAttempts ?? 0) + repairAttempts,
          phases: [
            ...(current.phases ?? []),
            {
              id: `${stepId}-generate-${Date.now()}`,
              kind: "generate",
              name: `${stepAgents[stepId]} 生成产物`,
              status: "success",
              finishedAt: now(),
            },
            ...repairPhases,
            {
              id: `${stepId}-gate-${Date.now()}`,
              kind: "gate",
              name: "Quality Gate 决策",
              status: gateDecision === "auto-continue" ? "success" : "failed",
              finishedAt: now(),
              message: verifier.qualityGate.reasons.join("; "),
            },
          ],
          logs: [
            ...current.logs,
            `${current.agent} finished`,
            ...repairLogs,
            ...gateLogs,
          ],
          interventions: nextStatus === "waiting-human"
            ? [...(current.interventions ?? []), {
              id: `${stepId}-agent-${Date.now()}`,
              stepId,
              role: "agent",
              content: buildGateInterventionMessage(verifier.qualityGate),
              createdAt: now(),
            }]
            : current.interventions,
        };
      }

      if (shouldAutoContinue && index === stepIndex + 1) {
        return { ...current, input: output };
      }

      return current;
    });
    commitRun(latest);

    workflowEventBus.emitStepEvent({
      type: "step",
      runId,
      stepId,
      phase: nextStatus === "success"
        ? "completed"
        : nextStatus === "failed"
          ? "failed"
          : "waiting-human",
      message: verifier.qualityGate.reasons[0],
    });

    if (shouldAutoContinue) {
      await advanceWorkflow(runId);
    }
  } catch (error) {
    const latest = getWorkflowRun(runId);
    if (!latest) {
      return;
    }

    latest.steps = latest.steps.map((current) => current.id === stepId ? {
      ...current,
      status: "failed",
      finishedAt: now(),
      logs: [...current.logs, error instanceof Error ? error.message : "Agent 执行失败"],
    } : current);
    commitRun(latest);

    workflowEventBus.emitStepEvent({
      type: "step",
      runId,
      stepId,
      phase: "failed",
      message: error instanceof Error ? error.message : undefined,
    });
  }
}

function buildGateLogs(gate: QualityGateResult, mode: "automatic" | "manual-confirmation"): string[] {
  const decisionLabel: Record<QualityGateResult["decision"], string> = {
    "auto-continue": "Quality Gate: auto-continue ✓",
    "need-human": "Quality Gate: 需要人工确认 ⚠",
    "repair": "Quality Gate: 触发自动修复 ↻",
    "block": "Quality Gate: 阻断 ✗",
  };
  const out = [decisionLabel[gate.decision]];
  for (const reason of gate.reasons) {
    out.push(`  · ${reason}`);
  }
  if (mode === "automatic" && gate.decision !== "auto-continue") {
    out.push("配置为 automatic,但 Quality Gate 未通过,改为等待人工确认");
  }
  return out;
}

function buildGateInterventionMessage(gate: QualityGateResult): string {
  if (gate.decision === "auto-continue") {
    return "我已生成当前 Step 的结构化结果,Quality Gate 通过,等待人工确认或自动续跑。";
  }
  if (gate.decision === "block") {
    return `当前 Step 被阻断: ${gate.reasons.join("; ")}`;
  }
  if (gate.decision === "repair") {
    return `当前 Step 校验未通过,准备触发一次自动修复: ${gate.reasons.join("; ")}`;
  }
  return `当前 Step 校验需要人工确认: ${gate.reasons.join("; ")}`;
}

export async function addInterventionAndRegenerate(runId: string, stepId: WorkflowStepId, message: string) {
  const run = getExistingRun(runId);
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  const userMessage: InterventionMessage = {
    id: `${stepId}-user-${Date.now()}`,
    stepId,
    role: "user",
    content: message,
    createdAt: now(),
  };
  const agentMessage: InterventionMessage = {
    id: `${stepId}-agent-intervention-${Date.now()}`,
    stepId,
    role: "agent",
    content: "已记录你的修正，将基于这段 Runtime Memory 重新生成当前 Step。",
    createdAt: now(),
  };

  // TODO 3：显式 reset，避免 runStep 误进 confirm 分支（旧逻辑会把"提了介入"解释成"确认通过"）。
  run.steps = run.steps.map((current) => current.id === stepId
    ? {
      ...current,
      status: "idle",
      output: undefined,
      finishedAt: undefined,
      interventions: [...(current.interventions ?? []), userMessage, agentMessage],
      logs: [...current.logs, "User intervention submitted", "Regenerating current step"],
    }
    : current);
  commitRun(run);

  return runStep(runId, stepId);
}

export function getStepHistory(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const step = run.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Step not found: ${stepId}`);
  return step.history ?? [];
}

export function restoreStepSnapshot(runId: string, stepId: WorkflowStepId, snapshotId: string, replayDownstream = false) {
  const run = getExistingRun(runId);
  const stepIndex = stepOrder.indexOf(stepId);
  const step = run.steps[stepIndex];
  if (!step) throw new Error(`Step not found: ${stepId}`);

  const snapshot = (step.history ?? []).find((s) => s.id === snapshotId);
  if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

  run.steps = run.steps.map((current, index) => {
    if (current.id === stepId) {
      return {
        ...current,
        output: snapshot.output,
        status: "waiting-human" as const,
        logs: [...current.logs, `已还原历史版本 (${snapshot.reason}, ${snapshot.createdAt})`],
      };
    }

    if (replayDownstream && index > stepIndex) {
      return {
        ...current,
        status: "idle" as const,
        output: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        logs: [],
      };
    }

    return current;
  });

  run.activeStepId = stepId;
  run.steps = propagateInputDownstream(run.steps, stepIndex, snapshot.output);
  return commitRun(run);
}

export function deleteWorkflowRun(runId: string) {
  runs.delete(runId);
  cacheTimestamps.delete(runId);
  deleteWorkflowRunFromStore(runId);
}

export function evictWorkflowRunsForProject(projectId: string) {
  for (const [runId, run] of runs.entries()) {
    if (run.projectId === projectId) {
      runs.delete(runId);
      cacheTimestamps.delete(runId);
    }
  }
}

/**
 * 后台调度 autoContinue：保证同一 run 同时只有一个推进 promise 在跑。
 * 入参 `from`：可选地把 activeStep 临时跳到某个 step（用于 replay 后立即从该 step 重跑）。
 */
function scheduleAutoContinue(runId: string, from?: WorkflowStepId) {
  if (advancing.has(runId)) {
    return;
  }
  advancing.add(runId);

  void (async () => {
    try {
      if (from) {
        // 从 replay 起点重新跑当前 step（runStep 内部会广播 running）。
        await runStep(runId, from);
      } else {
        await advanceWorkflow(runId);
      }
    } finally {
      advancing.delete(runId);
    }
  })();
}

/**
 * 顺序推进当前 activeStep，直到遇到 manual-confirmation 卡点 / waiting-human / failed。
 * 注意：因为 runStep 是异步触发后台 promise，所以这里也只在 automatic 续跑路径上调用。
 */
async function advanceWorkflow(runId: string) {
  let guard = 0;

  while (guard < stepOrder.length) {
    guard += 1;
    const run = getWorkflowRun(runId);
    if (!run) return;

    const step = run.steps.find((item) => item.id === run.activeStepId);
    if (!step) return;

    if (step.status === "waiting-human" || step.status === "failed") {
      return;
    }

    if (step.status === "running") {
      // 已有 in-flight，等下一次 commitRun 触发再决定。
      return;
    }

    // 进入此 step 的执行（同步等待，确保串行推进）。
    if (getStepExecutionMode(step.id) === "automatic" || !step.output) {
      await executeStepAndAdvance(runId, step.id);
      // executeStepAndAdvance 内部已经处理了 activeStepId / status，进入下一轮。
      continue;
    }

    return;
  }
}

async function resolveStepOutput(
  run: WorkflowRun,
  stepId: WorkflowStepId,
  options?: { followUp?: { previousOutput: unknown; reasons: string[] } },
) {
  if (stepId === "requirement_intake") {
    return getStepOutput<RequirementDraft>(run, "requirement_intake");
  }

  if (stepId === "clarification") {
    const requirement = getStepOutput<RequirementDraft>(run, "requirement_intake");
    if (options?.followUp) {
      return runClarifierAgent(requirement, {
        previousOutput: options.followUp.previousOutput as ClarificationOutput,
        reasons: options.followUp.reasons,
      });
    }
    return runClarifierAgent(requirement);
  }

  if (stepId === "solution_design") {
    const requirement = getStepOutput<RequirementDraft>(run, "requirement_intake");
    const clarification = getStepOutput<ClarificationOutput>(run, "clarification");
    return runPlannerAgent(requirement, clarification);
  }

  return runWorkflowStepAgent(stepId, run);
}

function getStepOutput<T>(run: WorkflowRun, stepId: WorkflowStepId) {
  const output = run.steps.find((step) => step.id === stepId)?.output;

  if (!output) {
    throw new Error(`Step output not found: ${stepId}`);
  }

  return output as T;
}

function getExistingRun(runId: string) {
  const run = getWorkflowRun(runId);

  if (!run) {
    throw new Error(`Workflow run not found: ${runId}`);
  }

  return run;
}

/**
 * 将 step 的 output 向下传播到下一步的 input。
 * 仅在下一步处于 idle/failed 时覆盖，避免干扰正在执行的步骤。
 */
function propagateInputDownstream(steps: StepRun[], stepIndex: number, output: unknown): StepRun[] {
  const nextIndex = stepIndex + 1;
  if (nextIndex >= steps.length) return steps;

  const nextStep = steps[nextIndex];
  if (nextStep.status === "idle" || nextStep.status === "failed") {
    return steps.map((step, index) =>
      index === nextIndex ? { ...step, input: output } : step,
    );
  }

  return steps;
}
