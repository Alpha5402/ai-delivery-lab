import type { AgentMetric } from "../features/observability/types";
import type { RepositorySnapshot } from "../features/repository/types";
import type { RequirementDraft, StepRunSnapshot, WorkflowRun, WorkflowStepId } from "../features/workflow/types";
import type { ProjectWorkspace, QuickProjectDraft, WorkspaceContext, WorkspaceSummary } from "../features/workspace/types";

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

export function createWorkflowRun(requirement: RequirementDraft) {
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

export function runWorkflowStep(runId: string, stepId: WorkflowStepId) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/${stepId}/run`, {
    method: "POST",
  });
}

export function confirmWorkflowStep(runId: string, stepId: WorkflowStepId) {
  return request<WorkflowRun>(`/workflows/${runId}/steps/${stepId}/confirm`, {
    method: "POST",
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

export function replayWorkflowFrom(runId: string, stepId: WorkflowStepId) {
  return request<WorkflowRun>(`/workflows/${runId}/replay`, {
    method: "POST",
    body: JSON.stringify({ stepId }),
  });
}

// ---- Step History -----------------------------------------------------------

export function getStepHistory(runId: string, stepId: WorkflowStepId) {
  return request<StepRunSnapshot[]>(`/workflows/${runId}/steps/${stepId}/history`);
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

export type WorkflowSettings = {
  stepExecutionModes: Record<WorkflowStepId, WorkflowStepExecutionMode>;
};

export function fetchWorkflowSettings() {
  return request<WorkflowSettings>("/workflows/settings");
}

export function updateWorkflowSettings(patch: Partial<WorkflowSettings>) {
  return request<WorkflowSettings>("/workflows/settings", {
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
  | { type: "settings"; settings: WorkflowSettings };

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

    source.addEventListener("update", (raw) => {
      retryCount = 0; // 成功收到消息，重置重试计数
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { run: WorkflowRun };
        handlers.onUpdate?.(payload.run);
      } catch (error) {
        handlers.onError?.(error);
      }
    });

    source.addEventListener("step", (raw) => {
      retryCount = 0;
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as Extract<WorkflowStreamEvent, { type: "step" }>;
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
