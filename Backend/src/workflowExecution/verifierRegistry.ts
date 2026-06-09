import type { WorkflowStepId } from "../domain/workflow.js";
import { stepOrder } from "../domain/workflow.js";
import type { VerifierResult } from "../services/stepVerifiers.js";
import type { WorkspaceContext } from "../domain/workspace.js";

export type StepVerifier = (
  output: unknown,
  workspace?: WorkspaceContext,
) => VerifierResult;

export type VerifierDefinition = {
  stepId: WorkflowStepId;
  verifierProfileId: string;
  verify: StepVerifier;
};

const verifiers = new Map<WorkflowStepId, VerifierDefinition>();

export function registerStepVerifier(def: VerifierDefinition): void {
  verifiers.set(def.stepId, def);
}

export function getStepVerifier(stepId: WorkflowStepId): VerifierDefinition | undefined {
  return verifiers.get(stepId);
}

/** 通过注册表执行 verifier。保持签名和返回值与原 runStepVerifier 一致。 */
export function runRegisteredStepVerifier(
  stepId: WorkflowStepId,
  output: unknown,
  workspace?: WorkspaceContext,
): VerifierResult {
  const def = verifiers.get(stepId);
  if (!def) {
    return {
      checks: [{ id: "registry.missing_verifier", type: "factual", status: "warning", message: `No verifier registered for ${stepId}` }],
      qualityGate: { decision: "need-human", reasons: [`missing verifier: ${stepId}`], confidence: 0, repairAttempts: 0 },
    };
  }
  return def.verify(output, workspace);
}

/**
 * 注册 default 7 步 verifier。
 * 必须在 app 启动时调用一次。
 */
export function registerDefaultStepVerifiers(
  impl: Record<string, (...args: any[]) => any>,
): void {
  // Adapt verifyTrivialOutput(label, output) → StepVerifier(output, workspace?)
  function trivialFor(stepId: string): StepVerifier {
    return (output: unknown, _workspace?: WorkspaceContext) =>
      impl.verifyTrivialOutput(stepId, output) as ReturnType<StepVerifier>;
  }

  // 需要 workspace 的 verifier：缺失时退回 trivial（保持旧 runStepVerifier 行为）
  function withWorkspaceFallback(
    stepId: string,
    fn: (...args: any[]) => any,
  ): StepVerifier {
    return (output: unknown, workspace?: WorkspaceContext) => {
      if (!workspace) return impl.verifyTrivialOutput(stepId, output) as ReturnType<StepVerifier>;
      return fn(output, workspace) as ReturnType<StepVerifier>;
    };
  }

  // 不需要 workspace 的 verifier：直接适配
  function direct(fn: (...args: any[]) => any): StepVerifier {
    return (output: unknown, _workspace?: WorkspaceContext) =>
      fn(output) as ReturnType<StepVerifier>;
  }

  const registry: Record<string, StepVerifier> = {
    requirement_intake: trivialFor("requirement_intake"),
    clarification: direct(impl.verifyClarification),
    solution_design: direct(impl.verifySolutionDsl),
    module_mapping: withWorkspaceFallback("module_mapping", impl.verifyModuleMapping),
    code_generation: withWorkspaceFallback("code_generation", impl.verifyCodeGenerationPlan),
    repo_write: withWorkspaceFallback("repo_write", impl.verifyRepoWrite),
    code_review: trivialFor("code_review"),
    verification: direct(impl.verifyVerification),
    pull_request: trivialFor("pull_request"),
  };

  for (const stepId of stepOrder) {
    const verify = registry[stepId];
    if (!verify) continue; // 跳过未在 registry 中定义的 step
    registerStepVerifier({
      stepId,
      verifierProfileId: `${stepId}-verifier`,
      verify,
    });
  }
}
