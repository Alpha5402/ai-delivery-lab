import type { WorkflowStepId } from "./types";

export const stepOrder: WorkflowStepId[] = [
  "requirement_intake",
  "clarification",
  "solution_design",
  "module_mapping",
  "code_generation",
  "repo_write",
  "verification",
  "pull_request",
];

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
