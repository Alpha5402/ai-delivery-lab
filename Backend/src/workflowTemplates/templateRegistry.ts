import type { WorkflowStepId } from "../domain/workflow.js";
import { DEFAULT_TEMPLATE_ID, defaultWorkflowTemplate } from "./builtin/defaultTemplate.js";
import type { WorkflowStepDefinition, WorkflowTemplate } from "./templateTypes.js";
import { workflowTemplateSchema } from "./templateTypes.js";

const templates = new Map<string, WorkflowTemplate>();

/** 注册一个 WorkflowTemplate。重复 id 会覆盖。 */
export function registerWorkflowTemplate(template: WorkflowTemplate): void {
  // Zod 校验
  workflowTemplateSchema.parse(template);
  templates.set(template.id, template);
}

/** 按 id 获取模板 */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return templates.get(id);
}

/** 获取默认模板 */
export function getDefaultWorkflowTemplate(): WorkflowTemplate {
  return templates.get(DEFAULT_TEMPLATE_ID) ?? defaultWorkflowTemplate;
}

/** 列出所有已注册模板 */
export function listWorkflowTemplates(): WorkflowTemplate[] {
  return [...templates.values()];
}

/** 获取模板中指定 step 的定义 */
export function getWorkflowStepDefinition(
  templateId: string,
  stepId: WorkflowStepId,
): WorkflowStepDefinition | undefined {
  const template = templates.get(templateId);
  return template?.steps.find((s) => s.id === stepId);
}

/** 启动时调用一次，注册内置模板 */
export function registerBuiltinTemplates(): void {
  registerWorkflowTemplate(defaultWorkflowTemplate);
}
