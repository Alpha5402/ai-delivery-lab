import { describe, expect, it } from "vitest";
import {
  FALLBACK_TEMPLATE,
  deriveStepAgents,
  deriveStepLabels,
  deriveStepOrder,
} from "./workflowTemplate";
import { getDownstreamStepIdsFromRun } from "./workflowSelectors";
import type { WorkflowRun, WorkflowStepId } from "./types";

/** Minimal valid WorkflowRun for downstream-id tests */
function mockRun(stepIds: WorkflowStepId[]): WorkflowRun {
  return {
    id: "run-test",
    title: "test",
    createdAt: "",
    updatedAt: "",
    activeStepId: stepIds[0],
    steps: stepIds.map((id) => ({
      id,
      label: id,
      agent: "test",
      status: "success" as const,
      input: undefined as unknown,
      logs: [],
      replayCount: 0,
      history: [],
    })),
  };
}

describe("workflowTemplate utilities", () => {
  it("deriveStepOrder from fallback template matches 8 steps", () => {
    const order = deriveStepOrder(FALLBACK_TEMPLATE);
    expect(order).toHaveLength(8);
    expect(order[0]).toBe("requirement_intake");
    expect(order[7]).toBe("pull_request");
  });

  it("deriveStepLabels returns correct labels", () => {
    const labels = deriveStepLabels(FALLBACK_TEMPLATE);
    expect(labels["requirement_intake"]).toBe("PM 输入");
    expect(labels["pull_request"]).toBe("提交 PR");
  });

  it("deriveStepAgents returns correct agents", () => {
    const agents = deriveStepAgents(FALLBACK_TEMPLATE);
    expect(agents["clarification"]).toBe("Clarifier Agent");
    expect(agents["verification"]).toBe("Verifier");
  });

  it("FALLBACK_TEMPLATE has all required step fields", () => {
    for (const step of FALLBACK_TEMPLATE.steps) {
      expect(step.id).toBeTruthy();
      expect(step.label).toBeTruthy();
      expect(step.agent).toBeTruthy();
      expect(["automatic", "manual-confirmation"]).toContain(step.defaultExecutionMode);
    }
  });
});

describe("getDownstreamStepIdsFromRun", () => {
  it("returns downstream step ids based on run.steps order", () => {
    const run = mockRun(["requirement_intake", "clarification", "solution_design"]);
    const downstream = getDownstreamStepIdsFromRun("clarification", run);
    expect(downstream).toEqual(["solution_design"]);
  });

  it("returns empty array for last step", () => {
    const run = mockRun(["requirement_intake", "pull_request"]);
    expect(getDownstreamStepIdsFromRun("pull_request", run)).toEqual([]);
  });

  it("returns empty array for step not in run", () => {
    const run = mockRun(["requirement_intake"]);
    expect(getDownstreamStepIdsFromRun("code_generation", run)).toEqual([]);
  });
});
