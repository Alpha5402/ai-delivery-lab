import type { AgentMetric } from "../features/observability/types";
import type { RepositorySnapshot } from "../features/repository/types";
import type { RequirementDraft, WorkflowRun, WorkflowStepId } from "../features/workflow/types";
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

export function getCurrentWorkflowRun() {
  return request<WorkflowRun>("/workflows/current");
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
