import { describe, expect, it } from "vitest";
import { createMockWorkflowRun } from "./mockWorkflow";
import { workflowReducer } from "./workflowReducer";
import { canSubmitPullRequest, getCompletedSteps, getDownstreamStepIds, hasHumanBlocker } from "./workflowSelectors";

const run = createMockWorkflowRun();

describe("workflowReducer", () => {
  it("moves a step from running to success and passes output to the next step", () => {
    const started = workflowReducer(run, { type: "START_STEP", stepId: "module_mapping" });
    const completed = workflowReducer(started, {
      type: "COMPLETE_STEP",
      stepId: "module_mapping",
      output: { touchedModules: [] },
    });

    expect(completed.steps.find((step) => step.id === "module_mapping")?.status).toBe("success");
    expect(completed.steps.find((step) => step.id === "code_generation")?.input).toEqual({ touchedModules: [] });
  });

  it("marks a step as waiting for human intervention", () => {
    const next = workflowReducer(run, { type: "WAIT_FOR_HUMAN", stepId: "solution_design", message: "需要确认验收标准" });

    expect(next.activeStepId).toBe("solution_design");
    expect(next.steps.find((step) => step.id === "solution_design")?.status).toBe("waiting-human");
  });

  it("replay clears downstream outputs", () => {
    const next = workflowReducer(run, { type: "REPLAY_FROM", stepId: "solution_design" });

    expect(next.steps.find((step) => step.id === "solution_design")?.status).toBe("replayed");
    expect(next.steps.find((step) => step.id === "module_mapping")?.output).toBeUndefined();
    expect(next.steps.find((step) => step.id === "code_generation")?.status).toBe("idle");
  });
});

describe("workflowSelectors", () => {
  it("gets completed steps and human blockers", () => {
    expect(getCompletedSteps(run)).toHaveLength(3);
    expect(hasHumanBlocker(run)).toBe(true);
  });

  it("only allows PR submission after verification without blockers", () => {
    expect(canSubmitPullRequest(run)).toBe(false);
  });

  it("returns downstream step ids", () => {
    expect(getDownstreamStepIds("module_mapping")).toEqual(["code_generation", "repo_write", "verification", "pull_request"]);
  });
});
