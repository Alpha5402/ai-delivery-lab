import { z } from "zod";
import type { RecalledRequirementCase } from "./workspace.js";

export const stepStatuses = ["idle", "running", "waiting-human", "success", "failed"] as const;
export const workflowStepIds = [
  "requirement_intake",
  "clarification",
  "solution_design",
  "module_mapping",
  "code_generation",
  "code_review",
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

// TODO(PR3): stepOrder / stepLabels / stepAgents 应从 defaultWorkflowTemplate 派生，
// 消除双写。module_mapping / repo_write 保留为 legacy step id，但不再作为新 workflow 的顶级阶段。
export const stepOrder = workflowStepIds.filter((id) => id !== "module_mapping" && id !== "repo_write");

export const stepLabels: Record<WorkflowStepId, string> = {
  requirement_intake: "接收需求",
  clarification: "确认需求",
  solution_design: "生成方案",
  module_mapping: "定位代码",
  code_generation: "生成代码",
  code_review: "代码审查",
  repo_write: "生成代码",
  verification: "验证结果",
  pull_request: "提交 PR",
};

export const stepAgents: Record<WorkflowStepId, string> = {
  requirement_intake: "接收需求",
  clarification: "确认需求",
  solution_design: "生成方案",
  module_mapping: "定位代码",
  code_generation: "生成代码",
  code_review: "代码审查 Agent",
  repo_write: "生成代码",
  verification: "验证结果",
  pull_request: "提交 PR",
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
  dataContract: z.object({
    affectedSurfaces: z.array(z.string().min(1)).default([]),
    inputs: z.array(z.string().min(1)).default([]),
    outputs: z.array(z.string().min(1)).default([]),
    stateChanges: z.array(z.string().min(1)).default([]),
    apiContract: z.array(z.string().min(1)).default([]),
    constraints: z.array(z.string().min(1)).default([]),
    assumptions: z.array(z.string().min(1)).default([]),
    outOfScope: z.array(z.string().min(1)).default([]),
    verificationHints: z.array(z.string().min(1)).default([]),
  }).default({}),
});

export const moduleMappingSchema = z.object({
  touchedModules: z.array(z.object({
    name: z.string().min(1),
    reason: z.string().min(1),
    files: z.array(z.string().min(1)),
  })),
  reusableSkill: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().min(1).optional(),
  ),
});

/** LLM 面向的代码生成计划 schema — content 限制 200 字符，仅用于展示片段。 */
const codeGenerationTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  files: z.array(z.string().min(1)),
  testRequired: z.boolean(),
  /** 指向 solution_design.acceptanceCriteria 的 1-based 编号或稳定短 id */
  acceptanceCriteriaRefs: z.array(z.string().min(1)).default([]),
  /** 对目标文件的预期改动，供 writer 和 code review 使用 */
  expectedChange: z.string().min(1).optional(),
  /** 需要测试时，描述测试要证明什么；不需要测试时说明原因 */
  testIntent: z.string().min(1).optional(),
  /** testRequired=true 时必须填写：本次生成代码阶段要一并创建/修改的测试文件 */
  testFiles: z.array(z.string().min(1)).optional(),
  coverLayer: z.enum(["data", "api", "ui", "state", "routing", "style", "auth", "test"]).optional(),
});

export const llmCodeGenerationPlanSchema = z.object({
  strategy: z.string().min(1),
  tasks: z.array(codeGenerationTaskSchema),
  patches: z.array(z.object({
    path: z.string().min(1),
    changeType: z.enum(["created", "modified"]),
    content: z.string().max(200),
  })).optional(),
});

/** Golden-path 确定性补丁 schema — content 无长度限制，承载完整文件内容。 */
export const deterministicCodeGenerationPlanSchema = z.object({
  strategy: z.string().min(1),
  tasks: z.array(codeGenerationTaskSchema),
  patches: z.array(z.object({
    path: z.string().min(1),
    changeType: z.enum(["created", "modified"]),
    content: z.string(),
  })).optional(),
});

/** @deprecated 使用 llmCodeGenerationPlanSchema 或 deterministicCodeGenerationPlanSchema */
export const codeGenerationPlanSchema = llmCodeGenerationPlanSchema;

/**
 * 单个文件改动的描述。
 * - planned: 仅是 codegen 的计划写入；
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
  warningKind: z.enum(["bundle_size", "deprecation", "performance", "unknown"]).optional(),
  warningSummary: z.string().optional(),
  failureKind: z.enum(["missing_dependency", "missing_script", "runtime_environment", "command_failed", "unknown"]).optional(),
  failureSummary: z.string().optional(),
  suggestedAction: z.string().optional(),
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
  /** 本次提交使用的 commit message */
  commitMessage: z.string().optional(),
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
  codeReviewContext: z.enum(["default", "from-code-review", "omit"]).optional(),
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
export type LlmCodeGenerationPlan = z.infer<typeof llmCodeGenerationPlanSchema>;
export type DeterministicCodeGenerationPlan = z.infer<typeof deterministicCodeGenerationPlanSchema>;
/** CodeGenerationPlan 使用 deterministic schema 类型（content: string），兼容 golden path 完整文件 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCodeReviewFinding(value: unknown, index: number) {
  if (!isPlainRecord(value)) return value;
  const file = value.file ?? value.path;
  const recommendation = value.recommendation ?? value.suggestion;
  const rawLine = value.line ?? value.lines;
  const parsedLine = typeof rawLine === "number"
    ? rawLine
    : typeof rawLine === "string"
      ? Number.parseInt(rawLine, 10)
      : undefined;
  return {
    ...value,
    id: value.id ?? `F${String(index + 1).padStart(3, "0")}`,
    title: value.title ?? value.message ?? value.summary,
    detail: value.detail ?? value.message ?? value.reason ?? value.title,
    ...(file ? { file } : {}),
    ...(Number.isFinite(parsedLine) ? { line: parsedLine } : {}),
    ...(recommendation ? { recommendation } : {}),
  };
}

function normalizeCodeReviewChecklistItem(value: unknown, index: number) {
  if (typeof value === "string") {
    return {
      id: `C${String(index + 1).padStart(3, "0")}`,
      label: value,
      status: "warning",
    };
  }
  if (!isPlainRecord(value)) return value;
  return {
    ...value,
    id: value.id ?? `C${String(index + 1).padStart(3, "0")}`,
    label: value.label ?? value.message ?? value.title ?? value.detail,
    detail: value.detail ?? value.message,
  };
}

export const codeReviewResultSchema = z.object({
  summary: z.string().min(1),
  decision: z.enum(["approve", "request-changes"]),
  findings: z.preprocess((value) => (
    Array.isArray(value) ? value.map(normalizeCodeReviewFinding) : value
  ), z.array(z.object({
    id: z.string().min(1),
    severity: z.enum(["blocker", "major", "minor", "nit"]),
    title: z.string().min(1),
    detail: z.string().min(1),
    file: z.string().optional(),
    line: z.number().optional(),
    recommendation: z.string().optional(),
  }))),
  checklist: z.preprocess((value) => (
    Array.isArray(value) ? value.map(normalizeCodeReviewChecklistItem) : value
  ), z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(["passed", "warning", "failed", "not_applicable"]),
    detail: z.string().optional(),
  }))),
  reviewedFiles: z.array(z.string()),
  riskAreas: z.array(z.string()),
});

export type CodeReviewResult = z.infer<typeof codeReviewResultSchema>;
export type CodeGenerationPlan = DeterministicCodeGenerationPlan;
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

export type WorkflowExecutionNode = {
  id: string;
  stepId: WorkflowStepId;
  status: StepStatus;
  output?: unknown;
  input?: unknown;
  logs: string[];
  interventions?: InterventionMessage[];
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  reason: "initial" | "continue" | "replay" | "regenerate" | "restore" | "review-retry";
  parentNodeId?: string;
  childNodeIds: string[];
  invalidated?: boolean;
};

export type WorkflowExecutionTree = {
  rootNodeId: string;
  activeNodeId: string;
  nodes: Record<string, WorkflowExecutionNode>;
  stepActiveNodeIds: Partial<Record<WorkflowStepId, string>>;
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
  /** 当前 step 独立累计的 LLM / 工具调用用量；看板另行做全局汇总 */
  metrics?: AgentMetric[];
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
    hitFileGlobs?: string[];
    hitFiles?: string[];
    hitRouteHints?: string[];
    score?: number;
  };
  /** 用户收藏成功 run 后生成的历史案例 id */
  caseId?: string;
  /** 当前 run 是否已被收藏到历史案例库 */
  caseFavorited?: boolean;
  /** 新建 run 时召回的相似历史案例（轻量摘要） */
  recalledCases?: RecalledRequirementCase[];
  /** 生成方案后由用户确认哪些历史案例可进入代码生成上下文 */
  recalledCaseSelection?: {
    status: "pending" | "confirmed" | "skipped";
    defaultSelectedCaseIds: string[];
    selectedCaseIds: string[];
    confirmedAt?: string;
  };
  /** run-level 执行树，用于分支追溯与节点级回滚 */
  executionTree?: WorkflowExecutionTree;
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
