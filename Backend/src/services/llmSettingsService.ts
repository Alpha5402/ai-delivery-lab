import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env.js";
import { getProjectSelectedLlmModelId } from "./projectSettingsService.js";

const ENV_FALLBACK_MODEL_ID = "__env__";

const storedLlmModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().min(1),
  modelName: z.string().min(1),
  encryptedApiKey: z.string().optional(),
  isDefault: z.boolean().default(false),
});

const storedLlmSettingsSchema = z.object({
  models: z.array(storedLlmModelSchema).default([]),
  defaultModelId: z.string().optional(),
});

export const llmModelCreateSchema = z.object({
  displayName: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  modelName: z.string().trim().min(1),
  apiKey: z.string().optional(),
  isDefault: z.boolean().optional(),
});

export const llmModelPatchSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  modelName: z.string().trim().min(1).optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export const llmSettingsPatchSchema = z.object({
  baseUrl: z.string().trim().optional(),
  modelName: z.string().trim().optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
});

type StoredLlmModel = z.infer<typeof storedLlmModelSchema>;
type StoredLlmSettings = z.infer<typeof storedLlmSettingsSchema>;
export type LlmSettingsPatch = z.infer<typeof llmSettingsPatchSchema>;

const SETTINGS_FILE_PATH = path.resolve(
  path.dirname(path.resolve(env.WORKSPACE_DB_PATH)),
  "llm-settings.json",
);
const SETTINGS_SECRET_PATH = path.resolve(
  path.dirname(path.resolve(env.WORKSPACE_DB_PATH)),
  "llm-settings.secret",
);

let cached: StoredLlmSettings | null = null;

function normalizeOptional(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined) {
  return normalizeOptional(value)?.replace(/\/+$/, "");
}

function makeId(displayName: string) {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
  return `${base}-${Date.now().toString(36)}`;
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

function maskSecret(value: string | undefined) {
  return value ? "*".repeat(value.length) : "";
}

function envFallbackModel(): StoredLlmModel | null {
  if (!env.ARK_MODEL && !env.ARK_API_KEY) return null;
  return {
    id: ENV_FALLBACK_MODEL_ID,
    displayName: "环境变量默认模型",
    baseUrl: env.ARK_BASE_URL,
    modelName: env.ARK_MODEL ?? "",
    encryptedApiKey: undefined,
    isDefault: true,
  };
}

function normalizeSettings(settings: StoredLlmSettings): StoredLlmSettings {
  const cleaned = settings.models.map((model) => ({
    ...model,
    baseUrl: normalizeBaseUrl(model.baseUrl) ?? model.baseUrl,
  }));

  let defaultModelId = settings.defaultModelId ?? cleaned.find((model) => model.isDefault)?.id;
  if (!defaultModelId && cleaned.length > 0) {
    defaultModelId = cleaned[0].id;
  }
  if (defaultModelId && defaultModelId !== ENV_FALLBACK_MODEL_ID && !cleaned.some((model) => model.id === defaultModelId)) {
    defaultModelId = cleaned[0]?.id;
  }

  return {
    models: cleaned.map((model) => ({ ...model, isDefault: model.id === defaultModelId })),
    defaultModelId,
  };
}

function normalizeModels(models: StoredLlmModel[]) {
  return normalizeSettings({ models }).models;
}

function migrateLegacy(raw: unknown): StoredLlmSettings {
  const legacy = raw as { baseUrl?: string; modelName?: string; encryptedApiKey?: string };
  if (!legacy || typeof legacy !== "object" || (!legacy.baseUrl && !legacy.modelName && !legacy.encryptedApiKey)) {
    return { models: [] };
  }
  if (!legacy.modelName) return { models: [] };
  return {
    defaultModelId: "default",
    models: [{
      id: "default",
      displayName: legacy.modelName,
      baseUrl: normalizeBaseUrl(legacy.baseUrl) ?? env.ARK_BASE_URL,
      modelName: legacy.modelName,
      encryptedApiKey: legacy.encryptedApiKey,
      isDefault: true,
    }],
  };
}

function readFromDisk(): StoredLlmSettings {
  if (!existsSync(SETTINGS_FILE_PATH)) return { models: [] };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE_PATH, "utf-8")) as unknown;
    const parsed = storedLlmSettingsSchema.safeParse(raw);
    return parsed.success ? normalizeSettings(parsed.data) : migrateLegacy(raw);
  } catch {
    return { models: [] };
  }
}

function writeToDisk(settings: StoredLlmSettings) {
  mkdirSync(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
  writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(normalizeSettings(settings), null, 2), "utf-8");
}

function getStoredSettings() {
  if (!cached) cached = readFromDisk();
  return cached;
}

function publicModel(model: StoredLlmModel, readOnly = false) {
  const apiKey = model.id === ENV_FALLBACK_MODEL_ID ? env.ARK_API_KEY : decryptSecret(model.encryptedApiKey);
  return {
    id: model.id,
    displayName: model.displayName,
    baseUrl: model.baseUrl,
    modelName: model.modelName,
    apiKeyConfigured: Boolean(apiKey),
    apiKeySource: model.id === ENV_FALLBACK_MODEL_ID ? (apiKey ? "env" : "none") : (apiKey ? "settings" : "none"),
    apiKeyMasked: maskSecret(apiKey),
    isDefault: model.isDefault,
    readOnly,
  };
}

export function listPublicLlmModels() {
  const settings = normalizeSettings(getStoredSettings());
  const models = settings.models;
  const fallback = envFallbackModel();
  if (models.length === 0) {
    return fallback ? [publicModel({ ...fallback, isDefault: settings.defaultModelId === ENV_FALLBACK_MODEL_ID || !settings.defaultModelId }, true)] : [];
  }
  const publicModels = models.map((model) => publicModel(model));
  return fallback
    ? [...publicModels, publicModel({ ...fallback, isDefault: settings.defaultModelId === ENV_FALLBACK_MODEL_ID }, true)]
    : publicModels;
}

export function createLlmModel(input: z.infer<typeof llmModelCreateSchema>) {
  const current = getStoredSettings();
  const model: StoredLlmModel = {
    id: makeId(input.displayName),
    displayName: input.displayName,
    baseUrl: normalizeBaseUrl(input.baseUrl) ?? input.baseUrl,
    modelName: input.modelName,
    encryptedApiKey: input.apiKey?.trim() ? encryptSecret(input.apiKey.trim()) : undefined,
    isDefault: Boolean(input.isDefault) || (current.models.length === 0 && current.defaultModelId !== ENV_FALLBACK_MODEL_ID),
  };
  const next = normalizeSettings({
    models: [
      ...current.models.map((item) => model.isDefault ? { ...item, isDefault: false } : item),
    model,
    ],
    defaultModelId: model.isDefault ? model.id : current.defaultModelId,
  });
  cached = next;
  writeToDisk(cached);
  return publicModel(cached.models.find((item) => item.id === model.id) ?? model);
}

export function updateLlmModel(id: string, patch: z.infer<typeof llmModelPatchSchema>) {
  const current = getStoredSettings();
  const models = current.models.map((model) => {
    if (model.id !== id) return patch.isDefault ? { ...model, isDefault: false } : model;
    return {
      ...model,
      displayName: patch.displayName ?? model.displayName,
      baseUrl: normalizeBaseUrl(patch.baseUrl) ?? model.baseUrl,
      modelName: patch.modelName ?? model.modelName,
      encryptedApiKey: patch.clearApiKey ? undefined : (patch.apiKey?.trim() ? encryptSecret(patch.apiKey.trim()) : model.encryptedApiKey),
      isDefault: patch.isDefault ?? model.isDefault,
    };
  });
  if (!models.some((model) => model.id === id)) throw new Error(`LLM model not found: ${id}`);
  cached = normalizeSettings({
    models,
    defaultModelId: patch.isDefault ? id : current.defaultModelId,
  });
  writeToDisk(cached);
  return publicModel(cached.models.find((model) => model.id === id)!);
}

export function deleteLlmModel(id: string) {
  const current = getStoredSettings();
  const models = current.models.filter((model) => model.id !== id);
  if (models.length === current.models.length) return 0;
  cached = normalizeSettings({
    models,
    defaultModelId: current.defaultModelId === id ? undefined : current.defaultModelId,
  });
  writeToDisk(cached);
  return 1;
}

export function setDefaultLlmModel(id: string) {
  if (id === ENV_FALLBACK_MODEL_ID) {
    const fallback = envFallbackModel();
    if (!fallback) throw new Error("Environment LLM model is not configured");
    const current = getStoredSettings();
    cached = normalizeSettings({ ...current, defaultModelId: ENV_FALLBACK_MODEL_ID });
    writeToDisk(cached);
    return publicModel({ ...fallback, isDefault: true }, true);
  }
  return updateLlmModel(id, { isDefault: true });
}

function resolveStoredModel(projectId?: string): StoredLlmModel | null {
  const settings = normalizeSettings(getStoredSettings());
  const selectedId = getProjectSelectedLlmModelId(projectId);
  if (selectedId === ENV_FALLBACK_MODEL_ID) return envFallbackModel();
  const selected = selectedId ? settings.models.find((model) => model.id === selectedId) : undefined;
  const fallback = settings.defaultModelId === ENV_FALLBACK_MODEL_ID
    ? envFallbackModel()
    : settings.models.find((model) => model.isDefault) ?? settings.models[0] ?? envFallbackModel();
  return selected ?? fallback ?? null;
}

export function getLlmRuntimeSettings(projectId?: string) {
  const model = resolveStoredModel(projectId);
  if (!model) {
    return {
      baseUrl: env.ARK_BASE_URL,
      modelName: env.ARK_MODEL,
      embeddingModelName: env.EMBEDDING_MODEL ?? env.ARK_MODEL,
      apiKey: env.ARK_API_KEY,
      apiKeySource: env.ARK_API_KEY ? "env" as const : "none" as const,
    };
  }
  const settingsApiKey = model.id === ENV_FALLBACK_MODEL_ID ? undefined : decryptSecret(model.encryptedApiKey);
  const apiKey = settingsApiKey ?? env.ARK_API_KEY;
  return {
    baseUrl: normalizeBaseUrl(model.baseUrl) ?? env.ARK_BASE_URL,
    modelName: model.modelName,
    embeddingModelName: env.EMBEDDING_MODEL ?? model.modelName,
    apiKey,
    apiKeySource: settingsApiKey ? "settings" as const : env.ARK_API_KEY ? "env" as const : "none" as const,
  };
}

export function getPublicLlmSettings() {
  const runtime = getLlmRuntimeSettings();
  return {
    baseUrl: runtime.baseUrl,
    modelName: runtime.modelName,
    apiKeyConfigured: Boolean(runtime.apiKey),
    apiKeySource: runtime.apiKeySource,
    apiKeyMasked: maskSecret(runtime.apiKey),
    overrides: {
      baseUrl: listPublicLlmModels().some((model) => model.isDefault && !model.readOnly),
      modelName: listPublicLlmModels().some((model) => model.isDefault && !model.readOnly),
      apiKey: runtime.apiKeySource === "settings",
    },
  };
}

export function updateLlmSettings(patch: LlmSettingsPatch) {
  const models = getStoredSettings().models;
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  if (!defaultModel) {
    createLlmModel({
      displayName: patch.modelName?.trim() || env.ARK_MODEL || "Default Model",
      baseUrl: patch.baseUrl?.trim() || env.ARK_BASE_URL,
      modelName: patch.modelName?.trim() || env.ARK_MODEL || "",
      apiKey: patch.apiKey,
      isDefault: true,
    });
    return getPublicLlmSettings();
  }
  updateLlmModel(defaultModel.id, {
    baseUrl: patch.baseUrl,
    modelName: patch.modelName,
    apiKey: patch.apiKey,
    clearApiKey: patch.clearApiKey,
  });
  return getPublicLlmSettings();
}
