import type { WorkflowStepId } from "./types";

/**
 * @deprecated 页面运行时请使用 useDefaultWorkflowTemplate() 从 API 获取。
 * 保留此文件仅作为 fallback 和向后兼容层。
 */
export const stepOrder: WorkflowStepId[] = [
  "requirement_intake",
  "clarification",
  "solution_design",
  "module_mapping",
  "code_generation",
  "verification",
  "pull_request",
];

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
