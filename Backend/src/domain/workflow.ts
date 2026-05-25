import { z } from "zod";

export const stepStatuses = ["idle", "running", "waiting-human", "success", "failed"] as const;
export const workflowStepIds = [
  "requirement_intake",
  "clarification",
  "solution_design",
  "module_mapping",
  "code_generation",
  "repo_write",
  "verification",
  "pull_request",
] as const;

export const requirementPatterns = ["frontend-only", "cross-stack", "interaction", "unclear"] as const;

export const stepOrder = [...workflowStepIds];

export const stepLabels: Record<WorkflowStepId, string> = {
  requirement_intake: "PM 输入",
  clarification: "澄清 Agent",
  solution_design: "方案 DSL",
  module_mapping: "模块定位",
  code_generation: "代码计划",
  repo_write: "写入仓库",
  verification: "Lint / 单测",
  pull_request: "提交 PR",
};

export const stepAgents: Record<WorkflowStepId, string> = {
  requirement_intake: "Requirement Composer",
  clarification: "Clarifier Agent",
  solution_design: "Planner Agent",
  module_mapping: "Context Locator",
  code_generation: "Codegen Skill",
  repo_write: "Conduit Writer",
  verification: "Verifier",
  pull_request: "PR Assistant",
};

// 旧的 stepExecutionModes 常量已迁移至 services/workflowSettingsService.ts 的 defaultStepExecutionModes，
// 并由 getStepExecutionMode() 在运行时按用户配置返回。

export const workflowStepIdSchema = z.enum(workflowStepIds);
export const stepStatusSchema = z.enum(stepStatuses);

export const requirementDraftSchema = z.object({
  title: z.string().min(1),
  rawText: z.string().min(1),
  pattern: z.enum(requirementPatterns),
  targetRepo: z.literal("conduit"),
});

export const clarificationOutputSchema = z.object({
  summary: z.string().min(1),
  questions: z.array(z.object({
    id: z.string().min(1),
    question: z.string().min(1),
    answer: z.string(),
    riskIfUnanswered: z.string().min(1),
  })),
  confidence: z.number().min(0).max(1),
});

export const solutionDslSchema = z.object({
  requirementId: z.string().min(1),
  scope: z.enum(["frontend", "backend", "fullstack"]),
  userStory: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  dataContract: z.record(z.unknown()),
});

export const moduleMappingSchema = z.object({
  touchedModules: z.array(z.object({
    name: z.string().min(1),
    reason: z.string().min(1),
    files: z.array(z.string().min(1)),
  })),
  reusableSkill: z.string().min(1),
});

export const codeGenerationPlanSchema = z.object({
  strategy: z.string().min(1),
  tasks: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    files: z.array(z.string().min(1)),
    testRequired: z.boolean(),
  })),
});

export const repoWriteResultSchema = z.object({
  branch: z.string().min(1),
  filesChanged: z.array(z.object({
    path: z.string().min(1),
    changeType: z.enum(["created", "modified", "tested"]),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  })),
});

export const verificationResultSchema = z.object({
  lint: z.enum(["passed", "failed"]),
  unitTests: z.enum(["passed", "failed"]),
  coverage: z.number().min(0).max(100),
  testSuites: z.array(z.object({
    name: z.string().min(1),
    status: z.enum(["passed", "failed"]),
    durationMs: z.number().int().min(0),
  })),
});

export const pullRequestResultSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  status: z.enum(["draft", "ready"]),
  checklist: z.array(z.string().min(1)),
});

export const createWorkflowSchema = z.object({
  projectId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  rawText: z.string().min(1),
  pattern: z.enum(requirementPatterns).default("unclear"),
  targetRepo: z.literal("conduit").default("conduit"),
});

export const updateStepSchema = z.object({
  output: z.unknown(),
});

export const replayWorkflowSchema = z.object({
  stepId: workflowStepIdSchema,
});

export const createInterventionSchema = z.object({
  message: z.string().min(1),
});

export type StepStatus = z.infer<typeof stepStatusSchema>;
export type WorkflowStepId = z.infer<typeof workflowStepIdSchema>;
export type RequirementDraft = z.infer<typeof requirementDraftSchema>;
export type ClarificationOutput = z.infer<typeof clarificationOutputSchema>;
export type SolutionDsl = z.infer<typeof solutionDslSchema>;
export type ModuleMapping = z.infer<typeof moduleMappingSchema>;
export type CodeGenerationPlan = z.infer<typeof codeGenerationPlanSchema>;
export type RepoWriteResult = z.infer<typeof repoWriteResultSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type PullRequestResult = z.infer<typeof pullRequestResultSchema>;
export type StepExecutionMode = "automatic" | "manual-confirmation";

export type InterventionMessage = {
  id: string;
  stepId: WorkflowStepId;
  role: "agent" | "user" | "system";
  content: string;
  createdAt: string;
};

export type StepRunSnapshot = {
  id: string;
  output: unknown;
  logs: string[];
  interventions?: InterventionMessage[];
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  reason: "replay" | "regenerate";
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
  interventions?: InterventionMessage[];
  replayCount: number;
  history: StepRunSnapshot[];
};

export type WorkflowRun = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  projectId?: string;
  activeStepId: WorkflowStepId;
  steps: StepRun[];
};

export type RepositorySnapshot = {
  name: string;
  branch: string;
  baseCommit: string;
  health: "ready" | "dirty" | "checking";
};

export type AgentMetric = {
  agent: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCost: number;
};
