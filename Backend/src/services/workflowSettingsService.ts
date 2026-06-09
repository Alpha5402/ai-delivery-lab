import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
 *  - 低风险/事实采集步骤(requirement_intake、module_mapping、verification)
 *    默认自动续跑,但都被 Quality Gate 二次约束。
 *  - code_generation 会真实生成并写入文件，落盘完成后必须等待用户确认再进入验证。
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
    code_review: "manual-confirmation",
    repo_write: "manual-confirmation",
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

const gitSettingsStoredSchema = z.object({
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  encryptedGithubToken: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  githubBaseBranch: z.string().optional(),
  githubRemote: z.string().optional(),
}).default({});

const optionalStepsSchema = z.object({
  code_review: z.boolean().default(true),
}).default({ code_review: true });

const workflowSettingsStoredSchema = z.object({
  stepExecutionModes: z.record(z.enum(workflowStepIds), stepExecutionModeSchema),
  git: gitSettingsStoredSchema,
  enabledOptionalSteps: optionalStepsSchema,
});

export const workflowSettingsPatchSchema = z.object({
  stepExecutionModes: z.record(z.enum(workflowStepIds), stepExecutionModeSchema).optional(),
  enabledOptionalSteps: optionalStepsSchema.optional(),
  git: z.object({
    userName: z.string().optional(),
    userEmail: z.string().optional(),
    githubToken: z.string().optional(),
    clearGithubToken: z.boolean().optional(),
    githubOwner: z.string().optional(),
    githubRepo: z.string().optional(),
    githubBaseBranch: z.string().optional(),
    githubRemote: z.string().optional(),
  }).optional(),
});

type StoredWorkflowSettings = z.infer<typeof workflowSettingsStoredSchema>;
export type WorkflowSettings = {
  stepExecutionModes: Record<WorkflowStepId, StepExecutionMode>;
  enabledOptionalSteps: { code_review: boolean };
  git: {
    userName?: string;
    userEmail?: string;
    githubTokenConfigured: boolean;
    githubTokenSource: "settings" | "env" | "none";
    githubOwner?: string;
    githubRepo?: string;
    githubBaseBranch: string;
    githubRemote: string;
  };
};
export type WorkflowSettingsPatch = z.infer<typeof workflowSettingsPatchSchema>;

const SETTINGS_FILE_PATH = path.resolve(
  path.dirname(path.resolve(env.WORKSPACE_DB_PATH)),
  "workflow-settings.json",
);
const SETTINGS_SECRET_PATH = path.resolve(
  path.dirname(path.resolve(env.WORKSPACE_DB_PATH)),
  "workflow-settings.secret",
);

let cached: StoredWorkflowSettings | null = null;

function normalizeOptional(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getSettingsSecret() {
  mkdirSync(path.dirname(SETTINGS_SECRET_PATH), { recursive: true });
  if (existsSync(SETTINGS_SECRET_PATH)) {
    const existing = readFileSync(SETTINGS_SECRET_PATH, "utf-8").trim();
    if (existing) return Buffer.from(existing, "base64");
  }

  const secret = randomBytes(32);
  writeFileSync(SETTINGS_SECRET_PATH, secret.toString("base64"), { encoding: "utf-8", mode: 0o600 });
  return secret;
}

function encryptSecret(value: string) {
  const key = getSettingsSecret();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value: string | undefined) {
  if (!value) return undefined;
  try {
    const [version, ivRaw, tagRaw, encryptedRaw] = value.split(":");
    if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", getSettingsSecret(), Buffer.from(ivRaw, "base64"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return undefined;
  }
}

function createDefaultStoredSettings(): StoredWorkflowSettings {
  return { stepExecutionModes: { ...defaultStepExecutionModes }, git: {}, enabledOptionalSteps: { code_review: true } };
}

function normalizeStepExecutionModes(
  modes: Partial<Record<WorkflowStepId, StepExecutionMode>>,
): Record<WorkflowStepId, StepExecutionMode> {
  return {
    ...defaultStepExecutionModes,
    ...modes,
    code_generation: modes.code_generation === "automatic"
      ? "manual-confirmation"
      : (modes.code_generation ?? defaultStepExecutionModes.code_generation),
    repo_write: modes.repo_write === "automatic"
      ? "manual-confirmation"
      : (modes.repo_write ?? defaultStepExecutionModes.repo_write ?? "manual-confirmation"),
  };
}

function toPublicSettings(settings: StoredWorkflowSettings): WorkflowSettings {
  const settingsToken = decryptSecret(settings.git.encryptedGithubToken);
  const envToken = env.GITHUB_TOKEN || env.GIT_AUTH_TOKEN;
  const tokenSource = settingsToken ? "settings" : envToken ? "env" : "none";
  return {
    stepExecutionModes: normalizeStepExecutionModes(settings.stepExecutionModes),
    enabledOptionalSteps: settings.enabledOptionalSteps ?? { code_review: true },
    git: {
      userName: settings.git.userName ?? env.GIT_USER_NAME,
      userEmail: settings.git.userEmail ?? env.GIT_USER_EMAIL,
      githubTokenConfigured: Boolean(settingsToken || envToken),
      githubTokenSource: tokenSource,
      githubOwner: settings.git.githubOwner ?? env.GITHUB_OWNER,
      githubRepo: settings.git.githubRepo ?? env.GITHUB_REPO,
      githubBaseBranch: settings.git.githubBaseBranch ?? env.GITHUB_BASE_BRANCH,
      githubRemote: settings.git.githubRemote ?? env.GITHUB_REMOTE,
    },
  };
}

function readFromDisk(): StoredWorkflowSettings {
  if (!existsSync(SETTINGS_FILE_PATH)) {
    return createDefaultStoredSettings();
  }

  try {
    const raw = readFileSync(SETTINGS_FILE_PATH, "utf-8");
    const parsed = workflowSettingsStoredSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return createDefaultStoredSettings();
    }

    return {
      stepExecutionModes: normalizeStepExecutionModes(parsed.data.stepExecutionModes),
      git: parsed.data.git ?? {},
      enabledOptionalSteps: parsed.data.enabledOptionalSteps ?? { code_review: true },
    };
  } catch {
    return createDefaultStoredSettings();
  }
}

function writeToDisk(settings: StoredWorkflowSettings) {
  mkdirSync(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
  writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

export function getWorkflowSettings(): WorkflowSettings {
  if (!cached) {
    cached = readFromDisk();
  }

  return toPublicSettings(cached);
}

export function getStepExecutionMode(stepId: WorkflowStepId): StepExecutionMode {
  const settings = cached ?? readFromDisk();
  return settings.stepExecutionModes[stepId] ?? defaultStepExecutionModes[stepId];
}

export function getGitRuntimeSettings() {
  if (env.NODE_ENV === "test") {
    const envToken = env.GITHUB_TOKEN ?? env.GIT_AUTH_TOKEN;
    return {
      userName: env.GIT_USER_NAME,
      userEmail: env.GIT_USER_EMAIL,
      token: envToken,
      tokenSource: envToken ? "env" as const : "none" as const,
      githubOwner: env.GITHUB_OWNER,
      githubRepo: env.GITHUB_REPO,
      githubBaseBranch: env.GITHUB_BASE_BRANCH,
      githubRemote: env.GITHUB_REMOTE,
    };
  }

  if (!cached) cached = readFromDisk();
  const settingsToken = decryptSecret(cached.git.encryptedGithubToken);
  const envToken = env.GITHUB_TOKEN ?? env.GIT_AUTH_TOKEN;
  return {
    userName: cached.git.userName ?? env.GIT_USER_NAME,
    userEmail: cached.git.userEmail ?? env.GIT_USER_EMAIL,
    token: settingsToken ?? envToken,
    tokenSource: settingsToken ? "settings" as const : envToken ? "env" as const : "none" as const,
    githubOwner: cached.git.githubOwner ?? env.GITHUB_OWNER,
    githubRepo: cached.git.githubRepo ?? env.GITHUB_REPO,
    githubBaseBranch: cached.git.githubBaseBranch ?? env.GITHUB_BASE_BRANCH,
    githubRemote: cached.git.githubRemote ?? env.GITHUB_REMOTE,
  };
}

export function updateWorkflowSettings(patch: WorkflowSettingsPatch): WorkflowSettings {
  const current = cached ?? readFromDisk();
  const next: StoredWorkflowSettings = {
    stepExecutionModes: {
      ...current.stepExecutionModes,
      ...(patch.stepExecutionModes ?? {}),
    },
    git: {
      ...current.git,
      ...(patch.git?.userName !== undefined ? { userName: normalizeOptional(patch.git.userName) } : {}),
      ...(patch.git?.userEmail !== undefined ? { userEmail: normalizeOptional(patch.git.userEmail) } : {}),
      ...(patch.git?.githubOwner !== undefined ? { githubOwner: normalizeOptional(patch.git.githubOwner) } : {}),
      ...(patch.git?.githubRepo !== undefined ? { githubRepo: normalizeOptional(patch.git.githubRepo) } : {}),
      ...(patch.git?.githubBaseBranch !== undefined ? { githubBaseBranch: normalizeOptional(patch.git.githubBaseBranch) } : {}),
      ...(patch.git?.githubRemote !== undefined ? { githubRemote: normalizeOptional(patch.git.githubRemote) } : {}),
    },
    enabledOptionalSteps: {
      ...current.enabledOptionalSteps,
      ...(patch.enabledOptionalSteps ?? {}),
    },
  };
  if (patch.git?.clearGithubToken) {
    delete next.git.encryptedGithubToken;
  }
  if (patch.git?.githubToken?.trim()) {
    next.git.encryptedGithubToken = encryptSecret(patch.git.githubToken.trim());
  }

  cached = next;
  writeToDisk(next);
  // 广播 settings 变更到所有 SSE 订阅者
  const publicSettings = toPublicSettings(next);
  workflowEventBus.emitSettingsChanged(publicSettings);
  return publicSettings;
}

export function resetWorkflowSettings(): WorkflowSettings {
  const next = createDefaultStoredSettings();
  cached = next;
  writeToDisk(next);
  return toPublicSettings(next);
}
