import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  type StepExecutionMode,
  type WorkflowStepId,
  workflowStepIds,
} from "../domain/workflow.js";
import { getDefaultWorkflowTemplate } from "../workflowTemplates/templateRegistry.js";
import { workflowEventBus } from "./workflowEvents.js";

/**
 * 默认执行模式（产品语义）。
 * 从 default WorkflowTemplate 的 step.defaultExecutionMode 派生，
 * 避免与模板定义双写。
 *
 * 当前语义：
 *  - 高风险/语义决策步骤(clarification、solution_design、code_generation、pull_request)
 *    默认需要人工确认;
 *  - 低风险/事实采集步骤(requirement_intake、module_mapping、repo_write、verification)
 *    默认自动续跑,但都被 Quality Gate 二次约束。
 *  用户可在 Settings 页覆盖。
 */
function deriveDefaultModes(): Record<WorkflowStepId, StepExecutionMode> {
  const template = getDefaultWorkflowTemplate();
  const modes = {} as Record<WorkflowStepId, StepExecutionMode>;
  for (const step of template.steps) {
    if (workflowStepIds.includes(step.id as WorkflowStepId)) {
      modes[step.id as WorkflowStepId] = step.defaultExecutionMode;
    }
  }
  // 兜底：如果 template 缺失某些 step，用硬编码补偿
  const fallback: Record<string, StepExecutionMode> = {
    requirement_intake: "automatic",
    clarification: "manual-confirmation",
    solution_design: "manual-confirmation",
    module_mapping: "automatic",
    code_generation: "manual-confirmation",
    repo_write: "automatic",
    verification: "automatic",
    pull_request: "manual-confirmation",
  };
  for (const [key, val] of Object.entries(fallback)) {
    if (!(key in modes)) modes[key as WorkflowStepId] = val;
  }
  return modes;
}

export const defaultStepExecutionModes: Record<WorkflowStepId, StepExecutionMode> = deriveDefaultModes();

export const stepExecutionModeSchema = z.enum(["automatic", "manual-confirmation"]);

export const workflowSettingsSchema = z.object({
  stepExecutionModes: z.record(z.enum(workflowStepIds), stepExecutionModeSchema),
});

export const workflowSettingsPatchSchema = z.object({
  stepExecutionModes: z.record(z.enum(workflowStepIds), stepExecutionModeSchema).optional(),
});

export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;
export type WorkflowSettingsPatch = z.infer<typeof workflowSettingsPatchSchema>;

const SETTINGS_FILE_PATH = path.resolve(
  path.dirname(path.resolve(env.WORKSPACE_DB_PATH)),
  "workflow-settings.json",
);

let cached: WorkflowSettings | null = null;

function readFromDisk(): WorkflowSettings {
  if (!existsSync(SETTINGS_FILE_PATH)) {
    return { stepExecutionModes: { ...defaultStepExecutionModes } };
  }

  try {
    const raw = readFileSync(SETTINGS_FILE_PATH, "utf-8");
    const parsed = workflowSettingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { stepExecutionModes: { ...defaultStepExecutionModes } };
    }

    return {
      stepExecutionModes: {
        ...defaultStepExecutionModes,
        ...parsed.data.stepExecutionModes,
      },
    };
  } catch {
    return { stepExecutionModes: { ...defaultStepExecutionModes } };
  }
}

function writeToDisk(settings: WorkflowSettings) {
  mkdirSync(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
  writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

export function getWorkflowSettings(): WorkflowSettings {
  if (!cached) {
    cached = readFromDisk();
  }

  return cached;
}

export function getStepExecutionMode(stepId: WorkflowStepId): StepExecutionMode {
  const modes = getWorkflowSettings().stepExecutionModes;
  return modes[stepId] ?? defaultStepExecutionModes[stepId];
}

export function updateWorkflowSettings(patch: WorkflowSettingsPatch): WorkflowSettings {
  const current = getWorkflowSettings();
  const next: WorkflowSettings = {
    stepExecutionModes: {
      ...current.stepExecutionModes,
      ...(patch.stepExecutionModes ?? {}),
    },
  };

  cached = next;
  writeToDisk(next);
  // 广播 settings 变更到所有 SSE 订阅者
  workflowEventBus.emitSettingsChanged(next);
  return next;
}

export function resetWorkflowSettings(): WorkflowSettings {
  const next: WorkflowSettings = {
    stepExecutionModes: { ...defaultStepExecutionModes },
  };
  cached = next;
  writeToDisk(next);
  return next;
}
