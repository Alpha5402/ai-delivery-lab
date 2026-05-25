import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  type StepExecutionMode,
  type WorkflowStepId,
  workflowStepIds,
} from "../domain/workflow.js";

/**
 * 默认执行模式（产品语义）：
 * - clarification、solution_design、code_generation、pull_request 默认需要人工确认；
 * - 其余步骤默认自动续跑。
 * 用户可在 Settings 页覆盖。
 */
export const defaultStepExecutionModes: Record<WorkflowStepId, StepExecutionMode> = {
  requirement_intake: "automatic",
  clarification: "manual-confirmation",
  solution_design: "manual-confirmation",
  module_mapping: "automatic",
  code_generation: "manual-confirmation",
  repo_write: "automatic",
  verification: "automatic",
  pull_request: "manual-confirmation",
};

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
