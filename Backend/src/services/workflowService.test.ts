import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLlmTransport, type LlmTransport } from "./llmClient.js";
import {
  confirmStep,
  createWorkflowRun,
  getWorkflowRun,
  replayFromStep,
  runStep,
  updateStepOutput,
} from "./workflowService.js";
import type { ClarificationOutput } from "../domain/workflow.js";

// ---- Mock LLM Transport -------------------------------------------------------

let mockResponseQueue: string[] = [];

/** 推入一条 mock LLM 响应（JSON 字符串），FIFO 消费。 */
function pushMock(rawContent: string) {
  mockResponseQueue.push(rawContent);
}

function makeMockTransport(): LlmTransport {
  return async () => ({
    rawContent: mockResponseQueue.shift() ?? "{}",
    inputTokens: 5,
    outputTokens: 10,
    latencyMs: 1,
  });
}

// 常用的 schema 合规 mock 输出
const MOCK_CLARIFICATION = JSON.stringify({
  summary: "ok",
  decisions: [],
  questions: [],
  clarificationComplete: false,
  confidence: 0.8,
});
const MOCK_SOLUTION_DESIGN = JSON.stringify({
  requirementId: "r1",
  scope: "frontend",
  userStory: "test",
  acceptanceCriteria: ["a"],
  dataContract: {},
});

beforeEach(() => {
  mockResponseQueue = [];
  setLlmTransport(makeMockTransport());
});

afterEach(() => {
  setLlmTransport(null);
});

// ---- Helpers ------------------------------------------------------------------

async function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待条件满足。mock transport 下所有 LLM 调用即刻完成，
 * timeout 可以很短。
 */
async function waitFor(
  fn: () => boolean,
  { intervalMs = 10, timeoutMs = 500 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await tick(intervalMs);
  }
  if (fn()) return;
}

// ---- Tests --------------------------------------------------------------------

describe("workflowService", () => {
  it("creates a fresh workflow from PM input with clarification kicked off in background", async () => {
    // createWorkflowRun 自动触发 clarification agent → 需要 mock 输出
    pushMock(MOCK_CLARIFICATION);

    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    expect(run.activeStepId).toBe("clarification");
    expect(run.steps).toHaveLength(8);
    expect(run.steps[0].status).toBe("success");

    // mock 返回有效输出 → quality gate 判定 need-human（manual 模式）→ waiting-human
    await waitFor(() => {
      const latest = getWorkflowRun(run.id);
      if (!latest) return false;
      const s = latest.steps[1].status;
      return s === "waiting-human" || s === "success" || s === "failed";
    });

    const latest = getWorkflowRun(run.id)!;
    expect(latest.steps[1].status).toBe("waiting-human");
    expect(latest.steps[1].output).toBeDefined();
    expect(getWorkflowRun(run.id)?.id).toBe(run.id);
  });

  it("marks step as failed (not throw) when the Agent cannot run", async () => {
    // push 无效 JSON → schema 验证失败 → harness retry → 最终 failed
    pushMock("not json");

    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    await runStep(run.id, "clarification");
    await tick(100);
    const latest = getWorkflowRun(run.id);
    expect(["failed", "running", "waiting-human"]).toContain(
      latest?.steps.find((step) => step.id === "clarification")?.status,
    );
  });

  // ---- 交互断层修复测试 ----

  it("confirmStep advances activeStepId and triggers next step (does not stay idle)", async () => {
    // 第一个 autoContinue（clarification）
    pushMock(MOCK_CLARIFICATION);

    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    // 等待第一个 autoContinue 完成 → terminal state
    await waitFor(() => {
      const live = getWorkflowRun(run.id);
      if (!live) return false;
      const s = live.steps[1].status;
      return s === "waiting-human" || s === "success" || s === "failed";
    });

    // 手动构造 waiting-human 状态，模拟 quality gate 判 need-human
    const live = getWorkflowRun(run.id)!;
    live.steps[1].status = "waiting-human";
    live.steps[1].output = {
      summary: "需求为前端展示优化",
      questions: [], decisions: [], clarificationComplete: false,
      confidence: 0.8,
    } satisfies ClarificationOutput;

    // confirmStep 内部 scheduleAutoContinue → 需要 solution_design 的 mock
    pushMock(MOCK_SOLUTION_DESIGN);

    const confirmed = confirmStep(run.id, "clarification");

    // 同步断言：当前 step 标 success，activeStepId 移到下游
    expect(confirmed.steps[1].status).toBe("success");
    expect(confirmed.activeStepId).toBe("solution_design");

    // 轮询等待 solution_design 脱离 idle — 验证 /confirm 后台自动启动下一步
    await waitFor(() => {
      const latest = getWorkflowRun(run.id);
      if (!latest) return false;
      const s = latest.steps[2].status;
      return s === "waiting-human" || s === "success" || s === "failed";
    });

    const latest = getWorkflowRun(run.id)!;
    expect(latest.steps[2].status).toBe("waiting-human");
    expect(latest.steps[2].output).toBeDefined();
  });

  it("confirmStep rejects non-waiting-human step", async () => {
    pushMock(MOCK_CLARIFICATION); // background autoContinue
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
    pushMock(MOCK_CLARIFICATION); // background autoContinue
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });
    // 状态改成 waiting-human 但没有 output
    const live = getWorkflowRun(run.id)!;
    live.steps[1].status = "waiting-human";
    live.steps[1].output = undefined;

    expect(() => confirmStep(run.id, "clarification")).toThrow(
      /has no output to confirm/,
    );
  });

  it("manual step first execution runs despite manual-confirmation (no output → must run)", async () => {
    pushMock(MOCK_CLARIFICATION); // background autoContinue for clarification

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
      questions: [], decisions: [], clarificationComplete: false,
      confidence: 0.9,
    } satisfies ClarificationOutput;

    // solution_design mock
    pushMock(MOCK_SOLUTION_DESIGN);

    await runStep(run.id, "solution_design");

    // runStep 返回后 solution_design 应已脱离 idle
    const immediate = getWorkflowRun(run.id)!;
    expect(immediate.steps[2].status).not.toBe("idle");

    // 等待后台 promise 完成
    await tick(100);
    const latest = getWorkflowRun(run.id)!;
    expect(["running", "waiting-human", "failed"]).toContain(
      latest.steps[2].status,
    );
    expect(latest.steps[2].status).not.toBe("idle");
  });

  // ---- 原有测试 ----

  it("updates step output and replays downstream steps", async () => {
    pushMock(MOCK_CLARIFICATION); // background autoContinue

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
