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

/**
 * Step 内部细粒度执行阶段（runtime 可观测）：
 * - generate: agent 生成产物
 * - schema_validate: zod 校验
 * - factual_validate: 文件存在 / 接口契约等事实校验
 * - tool_verify: 真实命令 / 工具执行（typecheck/lint/test/build/git apply）
 * - repair: 自动修复一次
 * - gate: quality gate 决策
 */
export const stepPhaseKinds = [
  "generate",
  "schema_validate",
  "factual_validate",
  "tool_verify",
  "repair",
  "gate",
] as const;

export const stepPhaseStatuses = ["pending", "running", "success", "failed", "skipped"] as const;

export const stepCheckTypes = ["schema", "factual", "command", "diff", "security"] as const;
export const stepCheckStatuses = ["passed", "failed", "warning", "skipped"] as const;

export const qualityGateDecisions = [
  "auto-continue",
  "need-human",
  "repair",
  "block",
] as const;

/**
 * 验证状态五态，用于 verification step 的真实执行结果：
 * - passed: 命令真实执行且通过
 * - failed: 命令真实执行且失败
 * - skipped: 显式跳过（无相关命令 / 配置项不要求）
 * - not_configured: 项目未配置该命令（如没有 lint script）
 * - not_executed: runtime 因环境问题未能执行
 */
export const verificationStatuses = [
  "passed",
  "failed",
  "skipped",
  "not_configured",
  "not_executed",
] as const;

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

/** 已解决的澄清决策，供 downstream 消费 */
const clarificationDecisionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  finalAnswer: z.string().min(1),
  source: z.enum(["agent-inferred", "user-confirmed"]).default("user-confirmed"),
});

/** 澄清问题——只包含仍需用户处理的开放问题 */
const clarificationQuestionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  answer: z.string(),
  riskIfUnanswered: z.string().min(1),
  status: z.enum(["open", "resolved"]).default("open"),
  responseControl: z.object({
    type: z.enum(["single", "multiple"]),
    options: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      description: z.string().optional(),
    })).min(1),
    allowCustom: z.boolean().optional(),
  }).optional(),
});

export const clarificationOutputSchema = z.object({
  summary: z.string().min(1),
  /** 已确认的决策/规则，不再需要用户审核 */
  decisions: z.array(clarificationDecisionSchema).default([]),
  /** 仍需用户处理的开放问题 */
  questions: z.array(clarificationQuestionSchema).default([]),
  /** Agent 判定澄清是否已完成——true 表示可以推进到下一步 */
  clarificationComplete: z.boolean().default(false),
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
    /** 跨栈 Skill 注入：标注该任务覆盖的层 (data / api / ui) */
    coverLayer: z.enum(["data", "api", "ui"]).optional(),
  })),
  /**
   * 可选的可落盘补丁集合。当 LLM 对文件内容有把握时,可以同时输出完整文件内容,
   * 由后续 repo_write step 真实写入并切到 applied 模式。
   * 不提供则保持 planned 模式。
   */
  patches: z.array(z.object({
    path: z.string().min(1),
    changeType: z.enum(["created", "modified"]),
    content: z.string(),
  })).optional(),
});

/**
 * 单个文件改动的描述。
 * - planned: 仅是 codegen / repo_write 的计划写入；
 * - applied: runtime 已经把内容真实写入工作区。
 */
export const fileChangeSchema = z.object({
  path: z.string().min(1),
  changeType: z.enum(["created", "modified", "deleted", "tested"]),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  /** 仅 applied 模式下需要：apply 后真实的 file content（截断） */
  contentPreview: z.string().optional(),
});

export const repoWriteResultSchema = z.object({
  branch: z.string().min(1),
  /**
   * 区分"仅是计划"与"已落盘":
   * - planned: 当前 runtime 没有真实写文件,filesChanged 视为建议清单;
   * - applied: 已通过 write_file/git apply 真实落地。
   */
  mode: z.enum(["planned", "applied"]).default("planned"),
  pendingChanges: z.array(fileChangeSchema).default([]),
  appliedChanges: z.array(fileChangeSchema).default([]),
  diffSummary: z.string().default(""),
  /**
   * @deprecated 保留以减少前端破坏性升级,等价于 pendingChanges + appliedChanges。
   * 新代码请使用 pendingChanges / appliedChanges。
   */
  filesChanged: z.array(fileChangeSchema).default([]),
});

/**
 * 单条 verification 命令的真实执行 trace。
 * 来源是 runtime 的 run_command 工具，不是 LLM 自报。
 */
export const verificationCommandResultSchema = z.object({
  label: z.enum(["typecheck", "lint", "unit_tests", "build", "custom"]),
  command: z.string().min(1),
  cwd: z.string().min(1),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  status: z.enum(verificationStatuses),
  stdoutPreview: z.string().default(""),
  stderrPreview: z.string().default(""),
});

export const verificationResultSchema = z.object({
  lint: z.enum(verificationStatuses),
  unitTests: z.enum(verificationStatuses),
  build: z.enum(verificationStatuses).default("not_configured"),
  typecheck: z.enum(verificationStatuses).default("not_configured"),
  coverage: z.number().min(0).max(100).nullable().default(null),
  testSuites: z.array(z.object({
    name: z.string().min(1),
    status: z.enum(verificationStatuses),
    durationMs: z.number().int().min(0),
  })),
  /** 真实执行命令的 trace；为空数组表示 runtime 未真实执行任何命令 */
  commands: z.array(verificationCommandResultSchema).default([]),
  /** LLM 给出的失败归因与修复建议（不能作为通过/失败的事实来源） */
  diagnosis: z.string().default(""),
});

export const pullRequestResultSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  status: z.enum(["draft", "ready"]),
  checklist: z.array(z.string().min(1)),
  /** 实际创建的分支名 */
  branch: z.string().optional(),
  /** push 后的 commit SHA */
  commitSha: z.string().optional(),
  /** GitHub PR number */
  prNumber: z.number().optional(),
  /** 是否已 push 到 remote */
  pushed: z.boolean().optional(),
});

/**
 * StepPhase / StepCheck / StepArtifact / QualityGateResult
 *
 * 用于把每个顶级 Step 内部拆成可观测的子阶段，
 * 而不需要把它们提升为顶级 workflow step。
 * 详见 AGENTS.md 中的 "执行/生成 → 校验 → 验证 → 修复 → Gate" 流水线说明。
 */
export const stepPhaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(stepPhaseKinds),
  name: z.string().min(1),
  status: z.enum(stepPhaseStatuses),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  message: z.string().optional(),
});

export const stepCheckSchema = z.object({
  id: z.string().min(1),
  type: z.enum(stepCheckTypes),
  status: z.enum(stepCheckStatuses),
  message: z.string().min(1),
  /** 任意可序列化的证据,如失败的 file path / exitCode / stderr 截断 */
  evidence: z.unknown().optional(),
});

export const stepArtifactSchema = z.object({
  id: z.string().min(1),
  /** patch / diff / command_log / test_report 等 */
  kind: z.string().min(1),
  uri: z.string().optional(),
  /** 短摘要,不要塞大块内容 */
  summary: z.string().optional(),
  data: z.unknown().optional(),
});

export const qualityGateResultSchema = z.object({
  decision: z.enum(qualityGateDecisions),
  reasons: z.array(z.string().min(1)),
  /** 0~1,用于动态续跑判断 */
  confidence: z.number().min(0).max(1),
  /** 已尝试的自动修复次数,防止无限循环 */
  repairAttempts: z.number().int().min(0).default(0),
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
export type ClarificationDecision = z.infer<typeof clarificationDecisionSchema>;
export type ClarificationOutput = z.infer<typeof clarificationOutputSchema>;
export type SolutionDsl = z.infer<typeof solutionDslSchema>;
export type ModuleMapping = z.infer<typeof moduleMappingSchema>;
export type CodeGenerationPlan = z.infer<typeof codeGenerationPlanSchema>;
export type RepoWriteResult = z.infer<typeof repoWriteResultSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerificationCommandResult = z.infer<typeof verificationCommandResultSchema>;
export type VerificationStatus = (typeof verificationStatuses)[number];
export type PullRequestResult = z.infer<typeof pullRequestResultSchema>;
export type StepExecutionMode = "automatic" | "manual-confirmation";
export type StepPhase = z.infer<typeof stepPhaseSchema>;
export type StepPhaseKind = (typeof stepPhaseKinds)[number];
export type StepPhaseStatus = (typeof stepPhaseStatuses)[number];
export type StepCheck = z.infer<typeof stepCheckSchema>;
export type StepCheckType = (typeof stepCheckTypes)[number];
export type StepCheckStatus = (typeof stepCheckStatuses)[number];
export type StepArtifact = z.infer<typeof stepArtifactSchema>;
export type QualityGateResult = z.infer<typeof qualityGateResultSchema>;
export type QualityGateDecision = (typeof qualityGateDecisions)[number];

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
  /** Step 内部细粒度执行阶段(可观测,前端可折叠展示) */
  phases?: StepPhase[];
  /** 校验结果数组(schema/factual/command/diff/security) */
  checks?: StepCheck[];
  /** 工件(patch/diff/command_log 等) */
  artifacts?: StepArtifact[];
  /** Step 完成后的质量门禁判定;automatic 续跑必须 decision === "auto-continue" */
  qualityGate?: QualityGateResult;
  /** 自动修复尝试次数,防止无限循环 */
  repairAttempts?: number;
};

export type WorkflowRun = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  projectId?: string;
  activeStepId: WorkflowStepId;
  steps: StepRun[];
  /** 本次 run 命中的 Skill id（run 级别，非步骤级别） */
  selectedSkillId?: string;
  /** Skill 命中原因摘要，供前端展示 */
  skillMatchReason?: {
    skillId: string;
    skillName: string;
    matchedPattern: string;
    matchedScope?: string;
    hitKeywords: string[];
  };
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
