export type StepStatus = "idle" | "running" | "waiting-human" | "success" | "failed" | "replayed";

export type WorkflowStepId =
  | "requirement_intake"
  | "clarification"
  | "solution_design"
  | "module_mapping"
  | "code_generation"
  | "repo_write"
  | "verification"
  | "pull_request";

export type RequirementPattern = "frontend-only" | "cross-stack" | "interaction" | "unclear";

export type RequirementDraft = {
  title: string;
  rawText: string;
  pattern: RequirementPattern;
  targetRepo: "conduit";
};

export type ClarificationOutput = {
  summary: string;
  questions: Array<{
    id: string;
    question: string;
    answer: string;
    riskIfUnanswered: string;
  }>;
  confidence: number;
};

export type SolutionDsl = {
  requirementId: string;
  scope: "frontend" | "backend" | "fullstack";
  userStory: string;
  acceptanceCriteria: string[];
  dataContract: Record<string, unknown>;
};

export type ModuleMapping = {
  touchedModules: Array<{
    name: string;
    reason: string;
    files: string[];
  }>;
  reusableSkill: string;
};

export type CodeGenerationPlan = {
  strategy: string;
  tasks: Array<{
    id: string;
    title: string;
    files: string[];
    testRequired: boolean;
  }>;
};

export type RepoWriteResult = {
  branch: string;
  filesChanged: Array<{
    path: string;
    changeType: "created" | "modified" | "tested";
    additions: number;
    deletions: number;
  }>;
};

export type VerificationResult = {
  lint: "passed" | "failed";
  unitTests: "passed" | "failed";
  coverage: number;
  testSuites: Array<{
    name: string;
    status: "passed" | "failed";
    durationMs: number;
  }>;
};

export type PullRequestResult = {
  title: string;
  url: string;
  status: "draft" | "ready";
  checklist: string[];
};

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

export type StepRun<TOutput = unknown> = {
  id: WorkflowStepId;
  label: string;
  agent: string;
  status: StepStatus;
  input: unknown;
  output?: TOutput;
  startedAt?: string;
  finishedAt?: string;
  logs: string[];
  humanEditable: boolean;
};

export type WorkflowRun = {
  id: string;
  title: string;
  createdAt: string;
  activeStepId: WorkflowStepId;
  steps: StepRun[];
};

export type WorkflowAction =
  | { type: "START_STEP"; stepId: WorkflowStepId }
  | { type: "COMPLETE_STEP"; stepId: WorkflowStepId; output: unknown }
  | { type: "FAIL_STEP"; stepId: WorkflowStepId; message: string }
  | { type: "WAIT_FOR_HUMAN"; stepId: WorkflowStepId; message: string }
  | { type: "UPDATE_STEP_JSON"; stepId: WorkflowStepId; output: unknown }
  | { type: "REPLAY_FROM"; stepId: WorkflowStepId };
