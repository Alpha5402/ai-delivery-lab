import { z } from "zod";
import { defaultStepExecutionModes, stepExecutionModeSchema } from "./workflowSettingsService.js";
import { getProjectSettingsFromStore, saveProjectSettingsToStore } from "./workspaceStore.js";
import type { ProjectSettings, ProjectSkillSetting, VerificationCommandSetting } from "../domain/workspace.js";
import { workflowStepIds } from "../domain/workflow.js";

export const verificationCommandSettingSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  command: z.string().min(1).max(500),
  enabled: z.boolean().default(true),
});

export const projectSkillSettingSchema = z.object({
  id: z.string().min(1).max(80),
  baseSkillId: z.string().min(1).max(80).optional(),
  enabled: z.boolean().default(true),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  requirementPatterns: z.array(z.string().min(1)).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  match: z.object({
    keywords: z.array(z.string()).optional(),
    fileGlobs: z.array(z.string()).optional(),
    routeHints: z.array(z.string()).optional(),
  }).optional(),
  steps: z.record(z.string(), z.unknown()).optional(),
});

export const projectSettingsPatchSchema = z.object({
  verificationCommands: z.array(verificationCommandSettingSchema).optional(),
  stepExecutionModes: z.record(z.enum(workflowStepIds), stepExecutionModeSchema).optional(),
  selectedLlmModelId: z.string().optional().nullable(),
  excludedPublicSkillIds: z.array(z.string().min(1)).optional(),
  projectSkills: z.array(projectSkillSettingSchema).optional(),
});

export const defaultVerificationCommands: VerificationCommandSetting[] = [
  { id: "typecheck", name: "TypeScript", command: "npm run typecheck", enabled: true },
  { id: "lint", name: "ESLint", command: "npm run lint", enabled: true },
  { id: "unit-tests", name: "单元测试", command: "npm test -- --run", enabled: true },
  { id: "build", name: "Build", command: "npm run build", enabled: true },
];

function normalizeCommands(commands: VerificationCommandSetting[]) {
  return commands
    .map((command) => ({
      ...command,
      id: command.id.trim(),
      name: command.name.trim(),
      command: command.command.trim(),
      enabled: command.enabled,
    }))
    .filter((command) => command.id && command.name && command.command);
}

function normalizeProjectSkills(skills: ProjectSkillSetting[]) {
  return skills
    .map((skill) => ({
      ...skill,
      id: skill.id.trim(),
      baseSkillId: skill.baseSkillId?.trim(),
      enabled: skill.enabled,
    }))
    .filter((skill) => skill.id);
}

function normalizeExcludedPublicSkillIds(skillIds: string[]) {
  return Array.from(new Set(skillIds.map((id) => id.trim()).filter(Boolean)));
}

function normalizeProjectSettings(settings: ProjectSettings): ProjectSettings {
  return {
    ...settings,
    verificationCommands: normalizeCommands(settings.verificationCommands ?? defaultVerificationCommands),
    stepExecutionModes: { ...defaultStepExecutionModes, ...(settings.stepExecutionModes ?? {}) },
    excludedPublicSkillIds: normalizeExcludedPublicSkillIds(settings.excludedPublicSkillIds ?? []),
    projectSkills: normalizeProjectSkills(settings.projectSkills ?? []),
  };
}

export function createDefaultProjectSettings(projectId: string): ProjectSettings {
  return {
    projectId,
    verificationCommands: defaultVerificationCommands,
    stepExecutionModes: { ...defaultStepExecutionModes },
    selectedLlmModelId: undefined,
    excludedPublicSkillIds: [],
    projectSkills: [],
    updatedAt: new Date().toISOString(),
  };
}

export function getProjectSettings(projectId: string): ProjectSettings {
  return normalizeProjectSettings(getProjectSettingsFromStore(projectId) ?? createDefaultProjectSettings(projectId));
}

export function updateProjectSettings(projectId: string, patch: z.infer<typeof projectSettingsPatchSchema>) {
  const current = getProjectSettings(projectId);
  const next: ProjectSettings = {
    ...current,
    verificationCommands: patch.verificationCommands
      ? normalizeCommands(patch.verificationCommands)
      : current.verificationCommands,
    stepExecutionModes: patch.stepExecutionModes
      ? { ...current.stepExecutionModes, ...patch.stepExecutionModes }
      : current.stepExecutionModes,
    selectedLlmModelId: patch.selectedLlmModelId === null ? undefined : (patch.selectedLlmModelId ?? current.selectedLlmModelId),
    excludedPublicSkillIds: patch.excludedPublicSkillIds
      ? normalizeExcludedPublicSkillIds(patch.excludedPublicSkillIds)
      : current.excludedPublicSkillIds,
    projectSkills: patch.projectSkills
      ? normalizeProjectSkills(patch.projectSkills)
      : current.projectSkills,
    updatedAt: new Date().toISOString(),
  };
  return saveProjectSettingsToStore(projectId, next);
}

export function getProjectStepExecutionMode(projectId: string | undefined, stepId: keyof typeof defaultStepExecutionModes) {
  if (!projectId) return defaultStepExecutionModes[stepId];
  return getProjectSettings(projectId).stepExecutionModes[stepId] ?? defaultStepExecutionModes[stepId];
}

export function getProjectVerificationCommands(projectId: string | undefined) {
  if (!projectId) return defaultVerificationCommands;
  return getProjectSettings(projectId).verificationCommands;
}

export function getProjectSelectedLlmModelId(projectId: string | undefined) {
  return projectId ? getProjectSettings(projectId).selectedLlmModelId : undefined;
}

export function getProjectSkillSettings(projectId: string | undefined) {
  return projectId ? getProjectSettings(projectId).projectSkills.filter((skill) => skill.enabled) : [];
}

export function getExcludedPublicSkillIds(projectId: string | undefined) {
  return projectId ? new Set(getProjectSettings(projectId).excludedPublicSkillIds) : new Set<string>();
}
