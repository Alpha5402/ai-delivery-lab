// Re-export shared types from backend (single source of truth).
// Only `import type` is used — Zod is never bundled into the frontend.
export type {
  StepStatus,
  WorkflowStepId,
  RequirementDraft,
  ClarificationOutput,
  SolutionDsl,
  ModuleMapping,
  CodeGenerationPlan,
  RepoWriteResult,
  VerificationResult,
  PullRequestResult,
  InterventionMessage,
  StepRun,
  WorkflowRun,
  WorkflowExecutionNode,
  WorkflowExecutionTree,
  StepRunSnapshot,
} from "@backend/domain/workflow";

import type {
  RequirementDraft,
  ClarificationOutput,
  SolutionDsl,
  ModuleMapping,
  CodeGenerationPlan,
  RepoWriteResult,
  VerificationResult,
  PullRequestResult,
} from "@backend/domain/workflow";

// Frontend-only convenience types

export type RequirementPattern = "frontend-only" | "cross-stack" | "interaction" | "unclear";

export type StepOutputMap = {
  requirement_intake: RequirementDraft;
  clarification: ClarificationOutput;
  solution_design: SolutionDsl;
  module_mapping: ModuleMapping;
  code_generation: CodeGenerationPlan;
  repo_write: RepoWriteResult;
  verification: VerificationResult;
  pull_request: PullRequestResult;
};
