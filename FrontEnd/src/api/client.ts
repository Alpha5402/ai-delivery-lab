import type { AgentMetric } from "../features/observability/types";
import type { RepositorySnapshot } from "../features/repository/types";
import type { RequirementDraft, StepRunSnapshot, WorkflowExecutionTree, WorkflowRun, WorkflowStepId } from "../features/workflow/types";
import type { ProjectWorkspace, QuickProjectDraft, RequirementCase, WorkspaceContext, WorkspaceSummary } from "../features/workspace/types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(payload?.message ?? `API request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function getWorkflowRun(runId: string) {
  return request<WorkflowRun>(`/workflows/${runId}`);
}

export function createWorkflowRun(requirement: Omit<RequirementDraft, "title"> & { title?: string; projectId?: string; workspaceId?: string }) {
  return request<WorkflowRun>("/workflows", {
    method: "POST",
    body: JSON.stringify(requirement),
  });
}

export function deleteWorkflowRun(runId: string) {
  return request<void>(`/workflows/${runId}`, {
    method: "DELETE",
  });
}

export function favoriteWorkflowRunCase(runId: string) {
  return request<{ run: WorkflowRun; case: RequirementCase }>(`/workflows/${runId}/favorite-case`, {
    method: "POST",
  });
}

export type WorkflowStepRunOptions = {
  pullRequest?: {
    branch?: string;
    commitMessage?: string;
  };
};

export function runWorkflowStep(runId: string, stepId: WorkflowStepId, options?: WorkflowStepRunOptions) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/${stepId}/run`, {
    method: "POST",
    body: options ? JSON.stringify(options) : undefined,
  });
}

export function confirmWorkflowStep(runId: string, stepId: WorkflowStepId) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/${stepId}/confirm`, {
    method: "POST",
  });
}

export function confirmRecalledCases(runId: string, selectedCaseIds: string[]) {
  return request<WorkflowRun>(`/workflows/${runId}/recalled-cases/confirm`, {
    method: "POST",
    body: JSON.stringify({ selectedCaseIds }),
  });
}

export function createStepIntervention(runId: string, stepId: WorkflowStepId, message: string) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/${stepId}/interventions`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export function updateWorkflowStep(runId: string, stepId: WorkflowStepId, output: unknown) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/${stepId}`, {
    method: "PATCH",
    body: JSON.stringify({ output }),
  });
}

export function replayWorkflowFrom(
  runId: string,
  stepId: WorkflowStepId,
  options?: { codeReviewContext?: "default" | "from-code-review" | "omit" },
) {
  return request<WorkflowRun>(`/workflows/${runId}/replay`, {
    method: "POST",
    body: JSON.stringify({ stepId, ...options }),
  });
}

// ---- Step History -----------------------------------------------------------

export function getStepHistory(runId: string, stepId: WorkflowStepId) {
  return request<StepRunSnapshot[]>(`/workflows/${runId}/steps/${stepId}/history`);
}

export function getWorkflowExecutionTree(runId: string) {
  return request<WorkflowExecutionTree>(`/workflows/${runId}/execution-tree`);
}

export function restoreExecutionTreeNode(runId: string, nodeId: string) {
  return request<WorkflowRun>(`/workflows/${runId}/execution-tree/nodes/${nodeId}/restore`, {
    method: "POST",
  });
}

export function deleteExecutionTreeNode(runId: string, nodeId: string) {
  return request<WorkflowRun>(`/workflows/${runId}/execution-tree/nodes/${nodeId}`, {
    method: "DELETE",
  });
}

export function restoreStepSnapshot(
  runId: string,
  stepId: WorkflowStepId,
  snapshotId: string,
  opts?: { replayDownstream?: boolean },
) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/${stepId}/restore`, {
    method: "POST",
    body: JSON.stringify({ snapshotId, replayDownstream: opts?.replayDownstream }),
  });
}

// ---- Workflow Settings ------------------------------------------------------

export type WorkflowStepExecutionMode = "automatic" | "manual-confirmation";

export type CustomVerificationCommand = {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
};

export type WorkflowSettings = {
  stepExecutionModes: Record<WorkflowStepId, WorkflowStepExecutionMode>;
  git: {
    userName?: string;
    userEmail?: string;
    githubTokenConfigured: boolean;
    githubTokenSource: "settings" | "env" | "none";
    githubTokenMasked: string;
    githubOwner?: string;
    githubRepo?: string;
    githubBaseBranch: string;
    githubRemote: string;
  };
  enabledOptionalSteps: { code_review: boolean };
  customVerificationCommands: CustomVerificationCommand[];
};

export type WorkflowSettingsPatch = {
  stepExecutionModes?: Record<WorkflowStepId, WorkflowStepExecutionMode>;
  enabledOptionalSteps?: { code_review?: boolean };
  customVerificationCommands?: CustomVerificationCommand[];
  git?: {
    userName?: string;
    userEmail?: string;
    githubToken?: string;
    clearGithubToken?: boolean;
    githubOwner?: string;
    githubRepo?: string;
    githubBaseBranch?: string;
    githubRemote?: string;
  };
};

export function fetchWorkflowSettings() {
  return request<WorkflowSettings>("/workflows/settings");
}

export function updateWorkflowSettings(patch: WorkflowSettingsPatch) {
  return request<WorkflowSettings>("/workflows/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---- Public LLM Models -----------------------------------------------------

export type LlmModel = {
  id: string;
  displayName: string;
  baseUrl: string;
  modelName?: string;
  apiKeyConfigured: boolean;
  apiKeySource: "settings" | "env" | "none";
  apiKeyMasked: string;
  isDefault: boolean;
  readOnly?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type LlmModelInput = {
  id?: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  isDefault?: boolean;
};

export type LlmModelPatch = Partial<Omit<LlmModelInput, "id">> & {
  clearApiKey?: boolean;
};

export function listLlmModels() {
  return request<LlmModel[]>("/llm/models");
}

export function createLlmModel(input: LlmModelInput) {
  return request<LlmModel>("/llm/models", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateLlmModel(modelId: string, patch: LlmModelPatch) {
  return request<LlmModel>(`/llm/models/${modelId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteLlmModel(modelId: string) {
  return request<void>(`/llm/models/${modelId}`, { method: "DELETE" });
}

export function setDefaultLlmModel(modelId: string) {
  return request<LlmModel>(`/llm/models/${modelId}/default`, { method: "POST" });
}

// ---- Project Settings ------------------------------------------------------

export type VerificationCommandSetting = {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
};

export type ProjectSkillSetting = {
  id: string;
  baseSkillId?: string;
  enabled: boolean;
  name?: string;
  description?: string;
  version?: string;
  requirementPatterns?: string[];
  scopes?: string[];
  match?: {
    keywords?: string[];
    fileGlobs?: string[];
    routeHints?: string[];
  };
  steps?: Record<string, unknown>;
};

export type ProjectSettings = {
  projectId: string;
  verificationCommands: VerificationCommandSetting[];
  stepExecutionModes: Partial<Record<WorkflowStepId, WorkflowStepExecutionMode>>;
  selectedLlmModelId?: string;
  excludedPublicSkillIds: string[];
  projectSkills: ProjectSkillSetting[];
  updatedAt: string;
};

export type ProjectSettingsPatch = Partial<Pick<ProjectSettings, "verificationCommands" | "stepExecutionModes" | "excludedPublicSkillIds" | "projectSkills">> & {
  selectedLlmModelId?: string | null;
};

export function fetchProjectSettings(projectId: string) {
  return request<ProjectSettings>(`/workspaces/${projectId}/settings`);
}

export function updateProjectSettings(projectId: string, patch: ProjectSettingsPatch) {
  return request<ProjectSettings>(`/workspaces/${projectId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---- SSE subscription -------------------------------------------------------

export type WorkflowStreamEvent =
  | { type: "update"; run: WorkflowRun }
  | {
      type: "step";
      runId: string;
      stepId: WorkflowStepId;
      phase: "started" | "completed" | "failed" | "waiting-human";
      message?: string;
    }
  | { type: "settings"; settings: WorkflowSettings }
  | { type: "metrics"; metrics: AgentMetric[] };

/**
 * 订阅 workflow run 的 SSE 流，支持指数退避自动重连。
 * 返回一个 disposer，调用即关闭连接并停止重连。
 */
export function subscribeWorkflowRun(
  runId: string,
  handlers: {
    onUpdate?: (run: WorkflowRun) => void;
    onStepEvent?: (event: Extract<WorkflowStreamEvent, { type: "step" }>) => void;
    onSettingsChanged?: (settings: WorkflowSettings) => void;
    onMetrics?: (metrics: AgentMetric[]) => void;
    onOpen?: () => void;
    onError?: (error: unknown) => void;
    onReconnect?: (attempt: number) => void;
  },
): () => void {
  const url = `${API_BASE_URL}/workflows/${runId}/stream`;
  const MAX_RETRIES = 10;
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 30000;

  let source: EventSource | null = null;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function connect() {
    if (disposed) return;

    source = new EventSource(url);
    if (import.meta.env.DEV) {
      console.debug("[workflow-sse]", "connect", { runId, url });
    }

    source.onopen = () => {
      retryCount = 0;
      if (import.meta.env.DEV) {
        console.debug("[workflow-sse]", "open", { runId });
      }
      handlers.onOpen?.();
    };

    source.addEventListener("update", (raw) => {
      retryCount = 0; // 成功收到消息，重置重试计数
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { run: WorkflowRun };
        if (import.meta.env.DEV) {
          console.debug("[workflow-sse]", "update", {
            runId,
            activeStepId: payload.run.activeStepId,
            updatedAt: payload.run.updatedAt,
          });
        }
        handlers.onUpdate?.(payload.run);
      } catch (error) {
        handlers.onError?.(error);
      }
    });

    source.addEventListener("step", (raw) => {
      retryCount = 0;
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as Extract<WorkflowStreamEvent, { type: "step" }>;
        if (import.meta.env.DEV) {
          console.debug("[workflow-sse]", "step", {
            runId,
            stepId: payload.stepId,
            phase: payload.phase,
          });
        }
        handlers.onStepEvent?.(payload);
      } catch (error) {
        handlers.onError?.(error);
      }
    });

    source.addEventListener("settings", (raw) => {
      retryCount = 0;
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { settings: WorkflowSettings };
        handlers.onSettingsChanged?.(payload.settings);
      } catch (error) {
        handlers.onError?.(error);
      }
    });

    source.addEventListener("metrics", (raw) => {
      retryCount = 0;
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { metrics: AgentMetric[] };
        if (import.meta.env.DEV) {
          console.debug("[workflow-sse]", "metrics", { runId, count: payload.metrics.length });
        }
        handlers.onMetrics?.(payload.metrics);
      } catch (error) {
        handlers.onError?.(error);
      }
    });

    source.onerror = () => {
      // EventSource 进入 CLOSED 状态时尝试重连
      if (disposed) return;

      source?.close();
      source = null;

      if (retryCount >= MAX_RETRIES) {
        handlers.onError?.(new Error(`SSE connection failed after ${MAX_RETRIES} retries`));
        return;
      }

      retryCount += 1;
      // 指数退避: delay = min(base * 2^(retry-1), max) + jitter
      const exponentialDelay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount - 1), MAX_DELAY_MS);
      const jitter = Math.random() * 500;
      const delay = exponentialDelay + jitter;

      if (import.meta.env.DEV) {
        console.debug("[workflow-sse]", "reconnect", { runId, attempt: retryCount, delay });
      }
      handlers.onReconnect?.(retryCount);
      retryTimer = setTimeout(connect, delay);
    };
  }

  connect();

  return () => {
    disposed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    source?.close();
    source = null;
  };
}

// ---- Repository / metrics / workspace ---------------------------------------

export function getRepositorySnapshot() {
  return request<RepositorySnapshot>("/repository");
}

export function getAgentMetrics() {
  return request<AgentMetric[]>("/metrics");
}

export type DailyMetric = {
  date: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  estimatedCost: number;
};

export type LlmDashboardSettings = {
  baseUrl: string;
  modelName?: string;
  apiKeyConfigured: boolean;
  apiKeySource: "settings" | "env" | "none";
  apiKeyMasked: string;
  overrides: {
    baseUrl: boolean;
    modelName: boolean;
    apiKey: boolean;
  };
};

export type LlmDashboardSettingsPatch = {
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
  clearApiKey?: boolean;
};

export function getDailyMetrics() {
  return request<DailyMetric[]>("/metrics/daily");
}

export function getLlmDashboardSettings() {
  return request<LlmDashboardSettings>("/metrics/llm-settings");
}

export function updateLlmDashboardSettings(patch: LlmDashboardSettingsPatch) {
  return request<LlmDashboardSettings>("/metrics/llm-settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function importWorkspace(repoUrl: string) {
  return request<WorkspaceContext>("/workspaces/import", {
    method: "POST",
    body: JSON.stringify({ repoUrl }),
  });
}

export function listWorkspaces() {
  return request<WorkspaceSummary[]>("/workspaces");
}

export function listRecentProjects() {
  return request<ProjectWorkspace[]>("/workspaces/recent");
}

export function getProjectWorkspace(projectId: string) {
  return request<ProjectWorkspace>(`/workspaces/${projectId}`);
}

export function listRequirementCases(projectId: string) {
  return request<RequirementCase[]>(`/workspaces/${projectId}/cases`);
}

export function getRequirementCase(projectId: string, caseId: string) {
  return request<RequirementCase>(`/workspaces/${projectId}/cases/${caseId}`);
}

export function deleteRequirementCase(projectId: string, caseId: string) {
  return request<void>(`/workspaces/${projectId}/cases/${caseId}`, {
    method: "DELETE",
  });
}

export function deleteProjectWorkspace(projectId: string, deleteDirectory = false) {
  return request<void>(`/workspaces/${projectId}?deleteDirectory=${String(deleteDirectory)}`, {
    method: "DELETE",
  });
}

export function openWorkspace(workspaceId: string) {
  return request<WorkspaceContext>("/workspaces/open", {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
}

export function createQuickProjectWorkspace(draft: QuickProjectDraft) {
  return request<WorkspaceContext>("/workspaces/quick-project", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export function getCurrentWorkspace() {
  return request<WorkspaceContext>("/workspaces/current");
}

// ---- Skills ----------------------------------------------------------------

export type SkillSummary = {
  id: string;
  name: string;
  version: string;
  source?: "builtin" | "json";
  builtin?: boolean;
  overridden?: boolean;
  requirementPatterns: string[];
  scopes: string[];
  matchKeywords?: string[];
  stepIds: string[];
};

export type SkillManifest = SkillSummary & {
  match: { keywords?: string[]; fileGlobs?: string[]; routeHints?: string[] };
  steps: Record<string, {
    instructionAddon: string;
    outputContractAddon?: string;
    contextHints?: string[];
    verificationPolicyAddon?: { required?: string[]; optional?: string[] };
  }>;
};

export function listSkills() {
  return request<SkillSummary[]>("/skills");
}

export function getSkill(skillId: string) {
  return request<SkillManifest>(`/skills/${skillId}`);
}

export function createJsonSkill(body: Record<string, unknown>) {
  return request<SkillManifest>("/skills/json", { method: "POST", body: JSON.stringify(body) });
}

export function updateJsonSkill(skillId: string, body: Record<string, unknown>) {
  return request<SkillManifest>(`/skills/json/${skillId}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteJsonSkill(skillId: string) {
  return request<void>(`/skills/json/${skillId}`, { method: "DELETE" });
}

export function resetBuiltinSkill(skillId: string) {
  return request<SkillManifest>(`/skills/${skillId}/reset`, { method: "POST" });
}

// ---- Code Review Retry --------------------------------------------------------

export function retryCodeGenerationFromCodeReview(runId: string) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/code_review/retry-code-generation`, { method: "POST" });
}

// ---- Workflow Templates -------------------------------------------------------

export type TemplateStepMeta = {
  id: string;
  label: string;
  agent: string;
  agentProfileId: string;
  verifierProfileId: string;
  outputSchemaId: string;
  defaultExecutionMode: "automatic" | "manual-confirmation";
  confirmationPolicy?: { mode?: string; reason?: string };
  inputRefs: string[];
};

export type WorkflowTemplateMeta = {
  id: string;
  name: string;
  description?: string;
  version: number;
  steps: TemplateStepMeta[];
};

export function fetchWorkflowTemplates() {
  return request<Array<{ id: string; name: string; description?: string; version: number; stepCount: number; stepIds: string[] }>>("/templates");
}

export function fetchDefaultWorkflowTemplate() {
  return request<WorkflowTemplateMeta>("/templates/default");
}

export function fetchWorkflowTemplate(id: string) {
  return request<WorkflowTemplateMeta>(`/templates/${id}`);
}
