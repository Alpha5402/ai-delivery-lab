import { describe, expect, it } from "vitest";
import type { QualityGateResult, StepExecutionMode, WorkflowRun } from "../domain/workflow.js";
import { resolveConfirmationDecision } from "./confirmationPolicy.js";

function makeRun(): WorkflowRun {
  return {
    id: "run-test", title: "test", createdAt: "", updatedAt: "", activeStepId: "clarification",
    steps: [],
  };
}

function makeGate(decision: QualityGateResult["decision"] = "auto-continue"): QualityGateResult {
  return { decision, reasons: [], confidence: 1, repairAttempts: 0 };
}

describe("confirmationPolicy — default behavior", () => {
  it("automatic + auto-continue => auto", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "module_mapping", output: {},
      qualityGate: makeGate("auto-continue"), executionMode: "automatic",
    });
    expect(result.shouldAutoContinue).toBe(true);
    expect(result.nextStatus).toBe("success");
  });

  it("manual-confirmation + auto-continue => waiting-human", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "code_generation", output: {},
      qualityGate: makeGate("auto-continue"), executionMode: "manual-confirmation",
    });
    expect(result.shouldAutoContinue).toBe(false);
    expect(result.nextStatus).toBe("waiting-human");
  });

  it("gate need-human => waiting-human regardless of mode", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "module_mapping", output: {},
      qualityGate: makeGate("need-human"), executionMode: "automatic",
    });
    expect(result.shouldAutoContinue).toBe(false);
    expect(result.nextStatus).toBe("waiting-human");
  });

  it("gate block => failed", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "repo_write", output: {},
      qualityGate: makeGate("block"), executionMode: "automatic",
    });
    expect(result.shouldAutoContinue).toBe(false);
    expect(result.nextStatus).toBe("failed");
  });
});

describe("confirmationPolicy — clarificationComplete", () => {
  it("manual + clarificationComplete => auto", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "clarification",
      output: { clarificationComplete: true },
      qualityGate: makeGate("auto-continue"), executionMode: "manual-confirmation",
    });
    expect(result.shouldAutoContinue).toBe(true);
    expect(result.appliedPolicy?.source).toBe("clarification-complete");
  });
});

describe("confirmationPolicy — Skill force-manual", () => {
  it("force-manual overrides automatic mode", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "module_mapping", output: {},
      qualityGate: makeGate("auto-continue"), executionMode: "automatic",
      skillConfirmationPolicyAddon: { mode: "force-manual", reason: "safety" },
    });
    expect(result.shouldAutoContinue).toBe(false);
    expect(result.nextStatus).toBe("waiting-human");
    expect(result.appliedPolicy?.source).toBe("skill");
  });

  it("force-manual overrides clarificationComplete", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "clarification",
      output: { clarificationComplete: true },
      qualityGate: makeGate("auto-continue"), executionMode: "manual-confirmation",
      skillConfirmationPolicyAddon: { mode: "force-manual", reason: "must review" },
    });
    expect(result.shouldAutoContinue).toBe(false);
    expect(result.nextStatus).toBe("waiting-human");
  });
});

describe("confirmationPolicy — Skill allow-auto", () => {
  it("allow-auto overrides manual mode", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "code_generation", output: {},
      qualityGate: makeGate("auto-continue"), executionMode: "manual-confirmation",
      skillConfirmationPolicyAddon: { mode: "allow-auto" },
    });
    expect(result.shouldAutoContinue).toBe(true);
    expect(result.appliedPolicy?.source).toBe("skill");
  });

  it("allow-auto does not override need-human", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "code_generation", output: {},
      qualityGate: makeGate("need-human"), executionMode: "manual-confirmation",
      skillConfirmationPolicyAddon: { mode: "allow-auto" },
    });
    expect(result.shouldAutoContinue).toBe(false);
    expect(result.nextStatus).toBe("waiting-human");
  });
});

describe("confirmationPolicy — requireHumanWhen", () => {
  it("open-questions triggers waiting-human", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "clarification",
      output: { questions: [{ status: "open" }] },
      qualityGate: makeGate("auto-continue"), executionMode: "automatic",
      skillConfirmationPolicyAddon: { requireHumanWhen: ["open-questions"] },
    });
    expect(result.shouldAutoContinue).toBe(false);
  });

  it("low-confidence triggers waiting-human with custom floor", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "clarification",
      output: { confidence: 0.5 },
      qualityGate: makeGate("auto-continue"), executionMode: "automatic",
      skillConfirmationPolicyAddon: { requireHumanWhen: ["low-confidence"], confidenceFloor: 0.8 },
    });
    expect(result.shouldAutoContinue).toBe(false);
  });

  it("writes-files triggers for repo_write step", () => {
    const result = resolveConfirmationDecision({
      run: makeRun(), stepId: "repo_write", output: {},
      qualityGate: makeGate("auto-continue"), executionMode: "automatic",
      skillConfirmationPolicyAddon: { requireHumanWhen: ["writes-files"] },
    });
    expect(result.shouldAutoContinue).toBe(false);
  });
});
