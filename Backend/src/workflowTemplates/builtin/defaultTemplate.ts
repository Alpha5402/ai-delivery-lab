import type { StepExecutionMode, WorkflowStepId } from "../../domain/workflow.js";
import { workflowStepIds } from "../../domain/workflow.js";
import type { WorkflowTemplate } from "../templateTypes.js";

/**
 * 默认 8 步软件交付流程模板。
 * 必须严格等价于当前 domain/workflow.ts 中的硬编码定义。
 *
 * agentProfileId 使用 stable id：
 *   requirement-composer / clarifier-agent / planner-agent
 *   repository-mapper / codegen-skill / repository-writer
 *   verification-runner / pr-assistant
 *
 * verifierProfileId 暂等于 `${stepId}-verifier`（PR3 实现真实 verifier profile）。
 * outputSchemaId 引用 domain/workflow.ts 中对应的 schema 名称。
 * defaultExecutionMode 等价于 workflowSettingsService.defaultStepExecutionModes。
 */

const stepIds = workflowStepIds as readonly WorkflowStepId[];

/** 当前 8 步的默认执行模式（与 workflowSettingsService.defaultStepExecutionModes 一致） */
const DEFAULT_MODES: Record<WorkflowStepId, StepExecutionMode> = {
  requirement_intake: "automatic",
  clarification: "manual-confirmation",
  solution_design: "manual-confirmation",
  module_mapping: "automatic",
  code_generation: "manual-confirmation",
  repo_write: "automatic",
  verification: "automatic",
  pull_request: "manual-confirmation",
};

const STEP_LABELS: Record<WorkflowStepId, string> = {
  requirement_intake: "PM 输入",
  clarification: "澄清 Agent",
  solution_design: "方案 DSL",
  module_mapping: "模块定位",
  code_generation: "代码计划",
  repo_write: "写入仓库",
  verification: "Lint / 单测",
  pull_request: "提交 PR",
};

const STEP_AGENTS: Record<WorkflowStepId, string> = {
  requirement_intake: "Requirement Composer",
  clarification: "Clarifier Agent",
  solution_design: "Planner Agent",
  module_mapping: "Context Locator",
  code_generation: "Codegen Skill",
  repo_write: "Conduit Writer",
  verification: "Verifier",
  pull_request: "PR Assistant",
};

const AGENT_PROFILE_IDS: Record<WorkflowStepId, string> = {
  requirement_intake: "requirement-composer",
  clarification: "clarifier-agent",
  solution_design: "planner-agent",
  module_mapping: "repository-mapper",
  code_generation: "codegen-skill",
  repo_write: "repository-writer",
  verification: "verification-runner",
  pull_request: "pr-assistant",
};

const OUTPUT_SCHEMA_IDS: Record<WorkflowStepId, string> = {
  requirement_intake: "requirementDraft",
  clarification: "clarificationOutput",
  solution_design: "solutionDsl",
  module_mapping: "moduleMapping",
  code_generation: "codeGenerationPlan",
  repo_write: "repoWriteResult",
  verification: "verificationResult",
  pull_request: "pullRequestResult",
};

export const DEFAULT_TEMPLATE_ID = "default-software-delivery";

export const defaultWorkflowTemplate: WorkflowTemplate = {
  id: DEFAULT_TEMPLATE_ID,
  name: "默认软件交付流程",
  description: "标准 8 步软件交付：PM 输入 → 澄清 → 方案设计 → 模块定位 → 代码计划 → 仓库写入 → 验证 → PR",
  version: 1,
  steps: stepIds.map((id) => ({
    id,
    label: STEP_LABELS[id],
    agent: STEP_AGENTS[id],
    agentProfileId: AGENT_PROFILE_IDS[id],
    verifierProfileId: `${id}-verifier`,
    outputSchemaId: OUTPUT_SCHEMA_IDS[id],
    defaultExecutionMode: DEFAULT_MODES[id],
    inputRefs: [] as string[],
  })),
};

/** 从 default template 派生 stepLabels（供 domain/workflow.ts 和前端使用） */
export const derivedStepLabels: Record<WorkflowStepId, string> = { ...STEP_LABELS };

/** 从 default template 派生 stepAgents */
export const derivedStepAgents: Record<WorkflowStepId, string> = { ...STEP_AGENTS };
