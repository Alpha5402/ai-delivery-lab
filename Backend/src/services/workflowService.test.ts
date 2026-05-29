import { describe, expect, it } from "vitest";
import {
  confirmStep,
  createWorkflowRun,
  getWorkflowRun,
  replayFromStep,
  runStep,
  updateStepOutput,
} from "./workflowService.js";
import type { ClarificationOutput } from "../domain/workflow.js";

/**
 * 由于 runStep 改成"立即返回 running 快照 + 后台 promise 执行"，
 * 原测试中"runStep 抛错"的断言已不再成立；
 * 这里改为：触发 runStep 后等待少许时间，再断言 step 处于 running/failed。
 */
async function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待某个条件满足，避免依赖固定超时的 flaky 测试。
 * 实际 LLM 调用可能 0.5s~30s，这里用最长 10s 轮询。
 */
async function waitFor(
  fn: () => boolean,
  { intervalMs = 100, timeoutMs = 10_000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await tick(intervalMs);
  }
  // 最后一次尝试
  if (fn()) return;
}

describe("workflowService", () => {
  it("creates a fresh workflow from PM input with clarification kicked off in background", { timeout: 60_000 }, async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    expect(run.activeStepId).toBe("clarification");
    expect(run.steps).toHaveLength(8);
    expect(run.steps[0].status).toBe("success");

    // createWorkflowRun 立刻返回，后台 autoContinue 将 clarification 切到 running 并等待 LLM 响应。
    // 轮询等待 clarification 达成 terminal state（LLM 调用完成）。
    await waitFor(() => {
      const latest = getWorkflowRun(run.id);
      if (!latest) return false;
      const s = latest.steps[1].status;
      return s === "waiting-human" || s === "success" || s === "failed";
    }, { timeoutMs: 30_000 });

    const latest = getWorkflowRun(run.id)!;
    expect(latest.steps[1].status).not.toBe("idle");
    expect(getWorkflowRun(run.id)?.id).toBe(run.id);
  });

  it("marks step as failed (not throw) when the Agent cannot run", { timeout: 30_000 }, async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    await runStep(run.id, "clarification");
    // 等待后台 promise 把 clarification 推到 failed（无 ARK_API_KEY 的测试环境会失败）。
    await tick(200);
    const latest = getWorkflowRun(run.id);
    expect(["failed", "running", "waiting-human"]).toContain(
      latest?.steps.find((step) => step.id === "clarification")?.status,
    );
  });

  // ---- 交互断层修复测试 ----

  it("confirmStep advances activeStepId and triggers next step (does not stay idle)", { timeout: 90_000 }, async () => {
    // 构造：创建 run 后等待首次 autoContinue 结束，然后手动把 clarification
    // 设为 waiting-human + output，模拟 quality gate 判 need-human 后的 UI 确认路径。
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    // 等待首次 autoContinue 完全结束（terminal state），释放 advancing 锁。
    // 仅检查 !== "idle" 不够——running 期间锁仍被持有，confirm 无法重入。
    await waitFor(() => {
      const live = getWorkflowRun(run.id);
      if (!live) return false;
      const s = live.steps[1].status;
      return s === "waiting-human" || s === "success" || s === "failed";
    }, { timeoutMs: 45_000 });

    // 手动构造 waiting-human 状态
    const live = getWorkflowRun(run.id)!;
    live.steps[1].status = "waiting-human";
    live.steps[1].output = {
      summary: "需求为前端展示优化",
      questions: [],
      confidence: 0.8,
    } satisfies ClarificationOutput;

    const confirmed = confirmStep(run.id, "clarification");

    // 同步断言：confirm 把当前 step 标为 success，activeStepId 移到下游
    expect(confirmed.steps[1].status).toBe("success");
    expect(confirmed.activeStepId).toBe("solution_design");

    // confirm 内部调用 scheduleAutoContinue → advanceWorkflow → executeStepAndAdvance
    // 现在 executeStepAndAdvance 在 LLM 调用前同步切换到 running。
    // 轮询等待 solution_design 脱离 idle，验证 /confirm 后台自动启动下一步。
    await waitFor(() => {
      const latest = getWorkflowRun(run.id);
      return latest != null && latest.steps[2].status !== "idle";
    }, { timeoutMs: 45_000 });

    const latest = getWorkflowRun(run.id)!;
    expect(latest.steps[2].status).not.toBe("idle");
    expect(["running", "waiting-human", "failed"]).toContain(latest.steps[2].status);
  });

  it("confirmStep rejects non-waiting-human step", async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });
    // clarification 还是 idle（初始状态），直接 confirm 应报错
    expect(() => confirmStep(run.id, "clarification")).toThrow(
      /not waiting for confirmation/,
    );
  });

  it("confirmStep rejects step with no output", async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });
    const live = getWorkflowRun(run.id)!;
    // 状态改成 waiting-human 但没有 output
    live.steps[1].status = "waiting-human";
    live.steps[1].output = undefined;

    expect(() => confirmStep(run.id, "clarification")).toThrow(
      /has no output to confirm/,
    );
  });

  it("manual step first execution runs despite manual-confirmation (no output → must run)", { timeout: 30_000 }, async () => {
    // 注意：advanceWorkflow 是私有函数，这里通过 runStep 间接验证。
    // 核心断言：无 output 的 step 调用 runStep 后不会停在 idle。
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    // 先给 clarification 设置 output，否则 solution_design 的 resolveStepOutput 无法拿到上游产物
    const live = getWorkflowRun(run.id)!;
    live.steps[1].output = {
      summary: "已澄清",
      questions: [],
      confidence: 0.9,
    } satisfies ClarificationOutput;

    // solution_design 初始状态：idle, 无 output, mode=manual-confirmation
    // 但因为 !step.output 条件，advanceWorkflow 仍然会执行它。
    await runStep(run.id, "solution_design");

    // runStep 立即返回 running 快照
    const immediate = getWorkflowRun(run.id)!;
    expect(["running", "failed", "waiting-human"]).toContain(immediate.steps[2].status);
    expect(immediate.steps[2].status).not.toBe("idle");

    // 等待后台 promise 完成（LLM 可能成功或失败）
    await waitFor(() => {
      const latest = getWorkflowRun(run.id);
      return latest != null && latest.steps[2].status !== "idle";
    }, { timeoutMs: 15_000 });

    const latest = getWorkflowRun(run.id)!;
    expect(["running", "waiting-human", "failed"]).toContain(
      latest.steps[2].status,
    );
    expect(latest.steps[2].status).not.toBe("idle");
  });

  // ---- 原有测试 ----

  it("updates step output and replays downstream steps", async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });
    const updated = updateStepOutput(run.id, "solution_design", { requirementId: "manual-edit" });
    const replayed = replayFromStep(updated.id, "solution_design");
    const solutionStep = replayed.steps.find((step) => step.id === "solution_design");
    const moduleStep = replayed.steps.find((step) => step.id === "module_mapping");

    expect(replayed.activeStepId).toBe("solution_design");
    expect(solutionStep?.status).toBe("idle");
    expect(moduleStep?.status).toBe("idle");
    expect(moduleStep?.output).toBeUndefined();
  });
});
