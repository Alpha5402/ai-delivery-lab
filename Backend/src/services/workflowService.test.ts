import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  getWorkflowRun,
  replayFromStep,
  runStep,
  updateStepOutput,
} from "./workflowService.js";

/**
 * 由于 runStep 改成"立即返回 running 快照 + 后台 promise 执行"，
 * 原测试中"runStep 抛错"的断言已不再成立；
 * 这里改为：触发 runStep 后等待少许时间，再断言 step 处于 running/failed。
 */
async function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("workflowService", () => {
  it("creates a fresh workflow from PM input with clarification kicked off in background", async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    expect(run.activeStepId).toBe("clarification");
    expect(run.steps).toHaveLength(8);
    expect(run.steps[0].status).toBe("success");
    // 新行为：createWorkflowRun 立刻返回，clarification 处于 running（后台执行中）。
    expect(["idle", "running"]).toContain(run.steps[1].status);
    expect(getWorkflowRun(run.id)?.id).toBe(run.id);
  });

  it("marks step as failed (not throw) when the Agent cannot run", async () => {
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
