import { useEffect, useState } from "react";
import { fetchDefaultWorkflowTemplate, type WorkflowTemplateMeta } from "../../api/client";
import { stepLabels, stepOrder } from "./stepDefinitions";
import type { WorkflowStepId } from "./types";

// Mirror of Backend/src/workflowTemplates/builtin/defaultTemplate.ts
const FALLBACK_AGENTS: Record<string, string> = {
  requirement_intake: "接收需求",
  clarification: "确认需求",
  solution_design: "生成方案",
  module_mapping: "定位代码",
  code_generation: "准备修改",
  repo_write: "写入变更",
  verification: "验证结果",
  pull_request: "准备 PR",
};

const FALLBACK_PROFILE_IDS: Record<string, string> = {
  requirement_intake: "requirement-composer",
  clarification: "clarifier-agent",
  solution_design: "planner-agent",
  module_mapping: "repository-mapper",
  code_generation: "codegen-skill",
  repo_write: "repository-writer",
  verification: "verification-runner",
  pull_request: "pr-assistant",
};

const FALLBACK_SCHEMA_IDS: Record<string, string> = {
  requirement_intake: "requirementDraft",
  clarification: "clarificationOutput",
  solution_design: "solutionDsl",
  module_mapping: "moduleMapping",
  code_generation: "codeGenerationPlan",
  repo_write: "repoWriteResult",
  verification: "verificationResult",
  pull_request: "pullRequestResult",
};

/**
 * Fallback template — 与 Backend/src/workflowTemplates/builtin/defaultTemplate.ts 一致。
 * 当后端 API 不可用时保证 UI 不崩溃。
 */
export const FALLBACK_TEMPLATE: WorkflowTemplateMeta = {
  id: "default-software-delivery",
  name: "默认软件交付流程",
  version: 1,
  steps: stepOrder.map((id) => ({
    id,
    label: stepLabels[id],
    agent: FALLBACK_AGENTS[id],
    agentProfileId: FALLBACK_PROFILE_IDS[id],
    verifierProfileId: `${id}-verifier`,
    outputSchemaId: FALLBACK_SCHEMA_IDS[id],
    defaultExecutionMode: (["clarification", "solution_design", "code_generation", "repo_write", "pull_request"] as string[]).includes(id)
      ? "manual-confirmation" as const
      : "automatic" as const,
    inputRefs: [],
  })),
};

/** 从 template 派生 stepOrder */
export function deriveStepOrder(template: WorkflowTemplateMeta): WorkflowStepId[] {
  return template.steps.map((s) => s.id as WorkflowStepId);
}

/** 从 template 派生 stepLabels */
export function deriveStepLabels(template: WorkflowTemplateMeta): Record<string, string> {
  return Object.fromEntries(template.steps.map((s) => [s.id, s.label]));
}

/** 从 template 派生 stepAgents */
export function deriveStepAgents(template: WorkflowTemplateMeta): Record<string, string> {
  return Object.fromEntries(template.steps.map((s) => [s.id, s.agent]));
}

/** React hook: 加载默认 template */
export function useDefaultWorkflowTemplate() {
  const [template, setTemplate] = useState<WorkflowTemplateMeta>(FALLBACK_TEMPLATE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDefaultWorkflowTemplate()
      .then((t) => {
        if (cancelled) return;
        setTemplate(t);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "无法加载 workflow template");
        // fallback 已就位
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { template, loading, error };
}
