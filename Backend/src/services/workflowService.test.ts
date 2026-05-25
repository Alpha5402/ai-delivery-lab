import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  getCurrentWorkflowRun,
  replayFromStep,
  runStep,
  updateStepOutput,
} from "./workflowService.js";

describe("workflowService", () => {
  it("does not create a seeded current workflow", () => {
    expect(getCurrentWorkflowRun()).toBeUndefined();
  });

  it("creates a fresh workflow from PM input and marks it as current", async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    expect(run.activeStepId).toBe("clarification");
    expect(run.steps).toHaveLength(8);
    expect(run.steps[0].status).toBe("success");
    expect(["waiting-human", "failed"]).toContain(run.steps[1].status);
    expect(getCurrentWorkflowRun()?.id).toBe(run.id);
  });

  it("fails a step instead of returning seeded data when the Agent cannot run", async () => {
    const run = await createWorkflowRun({
      title: "阅读量展示",
      rawText: "在首页文章卡片展示阅读量",
      pattern: "frontend-only",
      targetRepo: "conduit",
    });

    await expect(runStep(run.id, "clarification")).rejects.toThrow();
    expect(run.steps.find((step) => step.id === "clarification")?.status).toBe("failed");
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
    expect(solutionStep?.status).toBe("replayed");
    expect(moduleStep?.status).toBe("idle");
    expect(moduleStep?.output).toBeUndefined();
  });
});
