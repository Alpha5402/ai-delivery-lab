import { beforeEach, describe, expect, it } from "vitest";
import type { VerifierResult } from "../services/stepVerifiers.js";
import {
  type StepVerifier,
  registerDefaultStepVerifiers,
  registerStepVerifier,
  runRegisteredStepVerifier,
} from "./verifierRegistry.js";

// ---- Fake verifier implementations mirroring real signatures ----

function fakeVerifyTrivialOutput(label: string, output: unknown): VerifierResult {
  if (output == null) {
    return {
      checks: [{ id: `${label}.empty_output`, type: "schema", status: "failed", message: `${label} 输出为空` }],
      qualityGate: { decision: "need-human", reasons: ["empty output"], confidence: 0, repairAttempts: 0 },
    };
  }
  return {
    checks: [{ id: `${label}.has_output`, type: "schema", status: "passed", message: `${label} 输出非空` }],
    qualityGate: { decision: "auto-continue", reasons: ["output present"], confidence: 1, repairAttempts: 0 },
  };
}

function fakeVerifyClarification(output: unknown): VerifierResult {
  const o = output as Record<string, unknown> | undefined;
  if (o?.summary) {
    return {
      checks: [{ id: "clarification.ok", type: "factual", status: "passed", message: "ok" }],
      qualityGate: { decision: "auto-continue", reasons: ["ok"], confidence: 1, repairAttempts: 0 },
    };
  }
  return {
    checks: [{ id: "clarification.bad", type: "factual", status: "failed", message: "no summary" }],
    qualityGate: { decision: "need-human", reasons: ["no summary"], confidence: 0, repairAttempts: 0 },
  };
}

function fakeVerifyModuleMapping(output: unknown): VerifierResult {
  // This verifier requires workspace — if called without it, should never reach here
  return {
    checks: [{ id: "module_mapping.ok", type: "factual", status: "passed", message: "ok" }],
    qualityGate: { decision: "auto-continue", reasons: ["ok"], confidence: 1, repairAttempts: 0 },
  };
}

describe("verifierRegistry — signature adapters", () => {
  beforeEach(() => {
    registerDefaultStepVerifiers({
      verifyTrivialOutput: fakeVerifyTrivialOutput,
      verifyClarification: fakeVerifyClarification,
      verifySolutionDsl: fakeVerifyClarification, // reuse for test
      verifyModuleMapping: fakeVerifyModuleMapping,
      verifyCodeGenerationPlan: fakeVerifyClarification,
      verifyRepoWrite: fakeVerifyClarification,
      verifyVerification: fakeVerifyClarification,
    });
  });

  it("verifyTrivialOutput wrapper passes label and output correctly", () => {
    // Without fix, label would get the output value and output=undefined
    const result = runRegisteredStepVerifier("requirement_intake", { some: "data" });
    expect(result.qualityGate.decision).toBe("auto-continue");
    expect(result.checks[0].message).toContain("非空");
  });

  it("verifyTrivialOutput wrapper detects empty output", () => {
    const result = runRegisteredStepVerifier("requirement_intake", null);
    expect(result.qualityGate.decision).toBe("need-human");
    expect(result.checks[0].message).toContain("为空");
  });

  it("pull_request also uses TrivialOutput wrapper correctly", () => {
    const result = runRegisteredStepVerifier("pull_request", undefined);
    expect(result.qualityGate.decision).toBe("need-human");
    expect(result.checks[0].id).toContain("pull_request");
  });

  it("clarification verifier works with direct adapter", () => {
    const result = runRegisteredStepVerifier("clarification", { summary: "test" });
    expect(result.qualityGate.decision).toBe("auto-continue");
  });

  it("module_mapping falls back to trivial when workspace is missing", () => {
    // Old behavior: if (!workspace) return verifyTrivialOutput("module_mapping", output)
    const result = runRegisteredStepVerifier("module_mapping", { touchedModules: [] }, undefined);
    // Should fall back to TrivialOutput — checks pass because output is not null
    expect(result.qualityGate.decision).toBe("auto-continue");
    expect(result.checks[0].id).toContain("module_mapping");
    // Should NOT be the module_mapping-specific check "module_mapping.ok"
    expect(result.checks[0].message).toContain("非空");
  });
});

describe("verifierRegistry — unregistered step fallback", () => {
  it("returns need-human with missing_verifier check for unknown step", () => {
    const result = runRegisteredStepVerifier("nonexistent" as never, {});
    expect(result.qualityGate.decision).toBe("need-human");
    expect(result.checks.some((c) => c.id === "registry.missing_verifier")).toBe(true);
  });
});
