import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLlmTransport, type LlmTransport } from "./llmClient.js";
import {
  addInterventionAndRegenerate,
  confirmStep,
  createWorkflowRun,
  getStepHistory,
  getWorkflowRun,
  replayFromStep,
  restoreStepSnapshot,
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
    expect(run.steps).toHaveLength(8); // 8 steps with code_review
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

  it("ordinary (non-repo_write) intervention does not dup feedback", async () => {
    pushMock(MOCK_CLARIFICATION);
    const run = await createWorkflowRun({
      title: "test", rawText: "test", pattern: "frontend-only", targetRepo: "conduit",
    });
    await tick(100);

    addInterventionAndRegenerate(run.id, "clarification", "请确认字数统计规则");
    const updated = getWorkflowRun(run.id)!;
    const interventions = updated.steps[1].interventions ?? [];
    // 应有且仅有一条 user role 消息
    const userMsgs = interventions.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].content).toBe("请确认字数统计规则");
  });

  // ---- 还原快照测试 ----

  it("restoreStepSnapshot sets step to waiting-human and resets activeStepId", async () => {
    pushMock(MOCK_CLARIFICATION);
    const run = await createWorkflowRun({
      title: "test", rawText: "test", pattern: "frontend-only", targetRepo: "conduit",
    });
    await tick(100);

    // 通过 updateStepOutput 写入 output，再 replayFromStep 产生一个 snapshot
    const updated = updateStepOutput(run.id, "clarification", {
      summary: "restorable", questions: [], confidence: 0.9, decisions: [], clarificationComplete: false,
    });
    const replayed = replayFromStep(updated.id, "clarification");
    const history = getStepHistory(replayed.id, "clarification");
    expect(history.length).toBe(1);
    const snapId = history[0].id;

    const restored = restoreStepSnapshot(replayed.id, "clarification", snapId);
    expect(restored.steps[1].status).toBe("waiting-human");
    expect(restored.steps[1].output).toBeDefined();
    expect(restored.activeStepId).toBe("clarification");
  });

  it("restoreStepSnapshot unconditionally resets all downstream steps (no replayFromStep crutch)", async () => {
    pushMock(MOCK_CLARIFICATION);
    const run = await createWorkflowRun({
      title: "test", rawText: "test", pattern: "frontend-only", targetRepo: "conduit",
    });
    await tick(100);

    // 1. 给 clarification 写入一个带 output 的 state 并手动注入 history snapshot
    const live = getWorkflowRun(run.id)!;
    const snapId = `snap-${Date.now()}`;
    const snapOutput = { summary: "snapshot-output", questions: [], confidence: 0.95, decisions: [], clarificationComplete: false };
    // 手动注入 snapshot 历史记录
    live.steps[1].history = [{
      id: snapId,
      output: snapOutput,
      logs: [],
      createdAt: new Date().toISOString(),
      reason: "regenerate",
    }];

    // 2. 手动把下游 steps 设成 success 状态（模拟已完成流程）
    live.steps[2].status = "success";
    live.steps[2].output = { requirementId: "r1" };
    live.steps[2].startedAt = new Date().toISOString();
    live.steps[2].finishedAt = new Date().toISOString();
    live.steps[2].replayCount = 3;
    live.steps[2].history = [{ id: "old-snap", output: {}, logs: [], createdAt: "", reason: "replay" }];

    live.steps[3].status = "success";
    live.steps[3].output = { touchedModules: [] };
    live.steps[3].startedAt = new Date().toISOString();
    live.steps[3].finishedAt = new Date().toISOString();
    live.steps[3].replayCount = 1;

    // 3. 调用 restoreStepSnapshot——不传 replayDownstream
    const restored = restoreStepSnapshot(run.id, "clarification", snapId);

    // 4. 当前 step 应恢复为 waiting-human
    expect(restored.steps[1].status).toBe("waiting-human");
    expect(restored.steps[1].output).toEqual(snapOutput);
    expect(restored.activeStepId).toBe("clarification");

    // 5. 下游 steps 必须被无条件重置
    expect(restored.steps[2].status).toBe("idle");
    expect(restored.steps[2].output).toBeUndefined();
    expect(restored.steps[2].startedAt).toBeUndefined();
    expect(restored.steps[2].finishedAt).toBeUndefined();
    expect(restored.steps[2].replayCount).toBe(3); // 不增加
    expect(restored.steps[2].history.length).toBe(1); // 不新增 history

    expect(restored.steps[3].status).toBe("idle");
    expect(restored.steps[3].output).toBeUndefined();
    expect(restored.steps[3].startedAt).toBeUndefined();
    expect(restored.steps[3].replayCount).toBe(1); // 不增加

    // 6. 已执行过的下游应有失效日志
    expect(restored.steps[2].logs.some((l) => l.includes("因上游步骤还原"))).toBe(true);
    expect(restored.steps[3].logs.some((l) => l.includes("因上游步骤还原"))).toBe(true);

    // 7. 完全未执行过的下游不应有失效日志
    for (let i = 4; i < 7; i++) {
      expect(restored.steps[i].status).toBe("idle");
      expect(restored.steps[i].output).toBeUndefined();
      expect(restored.steps[i].logs.some((l) => l.includes("因上游步骤还原"))).toBe(false);
    }
  });

  it("restoreStepSnapshot does not add fake invalidation logs to never-executed downstream steps", async () => {
    pushMock(MOCK_CLARIFICATION);
    const run = await createWorkflowRun({
      title: "test", rawText: "test", pattern: "frontend-only", targetRepo: "conduit",
    });
    await tick(100);

    // 注入 snapshot 到 clarification
    const live = getWorkflowRun(run.id)!;
    const snapId = `snap-${Date.now()}`;
    live.steps[1].history = [{
      id: snapId, output: { summary: "x", questions: [], confidence: 0.9, decisions: [], clarificationComplete: false },
      logs: [], createdAt: new Date().toISOString(), reason: "regenerate",
    }];

    // 只设 solution_design (step 2) 为已执行
    live.steps[2].status = "success";
    live.steps[2].output = { requirementId: "r1" };

    // 其余所有下游保持原始 idle state（createWorkflowRun 的初始状态）
    const restored = restoreStepSnapshot(run.id, "clarification", snapId);

    // 已执行的 solution_design: 有失效日志
    expect(restored.steps[2].status).toBe("idle");
    expect(restored.steps[2].logs.some((l) => l.includes("因上游步骤还原"))).toBe(true);

    // 从未执行的下游: 保持干净 idle，无假日志
    for (let i = 3; i < 7; i++) {
      expect(restored.steps[i].status).toBe("idle");
      expect(restored.steps[i].output).toBeUndefined();
      expect(restored.steps[i].logs.filter((l) => l.includes("因上游步骤还原")).length).toBe(0);
    }
  });

  // ---- Replay 清空 Interventions 测试 ----

  it("replayFromStep clears interventions on replay start and downstream steps", async () => {
    pushMock(MOCK_CLARIFICATION);
    const run = await createWorkflowRun({
      title: "test", rawText: "test", pattern: "frontend-only", targetRepo: "conduit",
    });
    await tick(100);

    // 给 replay 起点 (solution_design) 和下游 (module_mapping) 加 interventions
    const live = getWorkflowRun(run.id)!;
    live.steps[2].interventions = [{ id: "up-int", stepId: "solution_design", role: "user", content: "upstream decision", createdAt: "" }];
    live.steps[2].output = { requirementId: "r1" };
    live.steps[3].interventions = [{ id: "down-int", stepId: "module_mapping", role: "user", content: "downstream note", createdAt: "" }];
    // 上游 step (clarification) 也设一个 intervention
    live.steps[1].interventions = [{ id: "past-int", stepId: "clarification", role: "user", content: "past decision", createdAt: "" }];

    const replayed = replayFromStep(run.id, "solution_design");

    // replay 起点 step 和下游的 interventions 应被清空
    expect(replayed.steps[2].interventions).toEqual([]);
    expect(replayed.steps[3].interventions).toEqual([]);
    // 上游 step 的 interventions 应保留
    expect(replayed.steps[1].interventions).toBeDefined();
    expect(replayed.steps[1].interventions!.length).toBe(1);
    // history snapshot 应保留旧 interventions
    expect(replayed.steps[2].history!.length).toBe(1);
    expect(replayed.steps[2].history![0].interventions).toBeDefined();
    expect(replayed.steps[2].history![0].interventions!.length).toBe(1);
    expect(replayed.activeStepId).toBe("solution_design");
  });

  it("addInterventionAndRegenerate still preserves new feedback", async () => {
    pushMock(MOCK_CLARIFICATION);
    const run = await createWorkflowRun({
      title: "test", rawText: "test", pattern: "frontend-only", targetRepo: "conduit",
    });
    await tick(100);
    // 先给 clarification 一个 output
    const live = getWorkflowRun(run.id)!;
    live.steps[1].output = {
      summary: "x", questions: [], decisions: [], clarificationComplete: false, confidence: 0.9,
    };
    pushMock(MOCK_CLARIFICATION);

    await addInterventionAndRegenerate(run.id, "clarification", "新的反馈");
    await tick(100);
    const latest = getWorkflowRun(run.id)!;
    const interventions = latest.steps[1].interventions ?? [];
    expect(interventions.some((m) => m.content === "新的反馈")).toBe(true);
  });
});
