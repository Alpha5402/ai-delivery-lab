import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { env } from "../config/env.js";
import type { WorkflowRun } from "../domain/workflow.js";
import type { ProjectWorkspace, WorkflowRunSummary, WorkspaceContext, WorkspaceSummary } from "../domain/workspace.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type WorkspaceRow = {
  id: string;
  repo_name: string;
  mode: WorkspaceContext["mode"];
  has_repository: number;
  repo_url: string | null;
  workspace_dir: string | null;
  source: WorkspaceContext["repositoryScan"]["source"];
  files_inspected: number;
  stack_json: string;
  workspace_json: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
};

type WorkflowRunRow = {
  id: string;
  project_id: string;
  title: string;
  requirement: string;
  status: WorkflowRunSummary["status"];
  current_step: string | null;
  run_json: string;
  created_at: string;
  updated_at: string;
};

type TableInfoRow = {
  name: string;
};

export class WorkspaceStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath = env.WORKSPACE_DB_PATH) {
    const absolutePath = path.resolve(dbPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        repo_name TEXT NOT NULL,
        mode TEXT NOT NULL,
        has_repository INTEGER NOT NULL,
        repo_url TEXT,
        workspace_dir TEXT,
        source TEXT NOT NULL,
        files_inspected INTEGER NOT NULL,
        stack_json TEXT NOT NULL,
        workspace_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        requirement TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step TEXT,
        run_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
    `);
    this.ensureLastOpenedColumn();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened_at ON workspaces(last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_updated_at ON workflow_runs(project_id, updated_at DESC);
    `);
  }

  upsert(workspace: WorkspaceContext) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspaces (
        id, repo_name, mode, has_repository, repo_url, workspace_dir, source,
        files_inspected, stack_json, workspace_json, created_at, updated_at, last_opened_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo_name = excluded.repo_name,
        mode = excluded.mode,
        has_repository = excluded.has_repository,
        repo_url = excluded.repo_url,
        workspace_dir = excluded.workspace_dir,
        source = excluded.source,
        files_inspected = excluded.files_inspected,
        stack_json = excluded.stack_json,
        workspace_json = excluded.workspace_json,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at
    `).run(
      workspace.id,
      workspace.repoName,
      workspace.mode,
      workspace.hasRepository ? 1 : 0,
      workspace.repoUrl ?? null,
      workspace.workspaceDir ?? null,
      workspace.repositoryScan.source,
      workspace.repositoryScan.filesInspected,
      JSON.stringify(workspace.repositoryScan.stack),
      JSON.stringify(workspace),
      workspace.createdAt,
      updatedAt,
      updatedAt,
    );
  }

  list(): WorkspaceSummary[] {
    const rows = this.db.prepare(`
      SELECT id, repo_name, mode, has_repository, repo_url, workspace_dir, source,
        files_inspected, stack_json, created_at, updated_at, last_opened_at
      FROM workspaces
      ORDER BY last_opened_at DESC
    `).all() as WorkspaceRow[];

    return rows.map((row) => ({
      id: row.id,
      repoName: row.repo_name,
      mode: row.mode,
      hasRepository: row.has_repository === 1,
      repoUrl: row.repo_url ?? undefined,
      workspaceDir: row.workspace_dir ?? undefined,
      source: row.source,
      filesInspected: row.files_inspected,
      stack: parseStack(row.stack_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at,
    }));
  }

  get(id: string): WorkspaceContext | null {
    const row = this.db.prepare("SELECT workspace_json FROM workspaces WHERE id = ?").get(id) as Pick<WorkspaceRow, "workspace_json"> | undefined;
    return row ? JSON.parse(row.workspace_json) as WorkspaceContext : null;
  }

  touchWorkspace(id: string) {
    this.db.prepare("UPDATE workspaces SET last_opened_at = ?, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), id);
  }

  listRecentProjects(limit?: number): ProjectWorkspace[] {
    const workspaces = typeof limit === "number" ? this.list().slice(0, limit) : this.list();
    return workspaces.map((workspace) => ({
      ...workspace,
      name: workspace.repoName,
      path: workspace.workspaceDir ?? "",
      workflowRuns: this.listWorkflowRunSummaries(workspace.id),
    }));
  }

  getProject(id: string): ProjectWorkspace | null {
    const workspace = this.list().find((item) => item.id === id);
    if (!workspace) {
      return null;
    }

    return {
      ...workspace,
      name: workspace.repoName,
      path: workspace.workspaceDir ?? "",
      workflowRuns: this.listWorkflowRunSummaries(id),
    };
  }

  saveWorkflowRun(projectId: string, run: WorkflowRun) {
    const requirement = getRunRequirement(run);
    const status = getRunStatus(run);
    const updatedAt = run.updatedAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflow_runs (
        id, project_id, title, requirement, status, current_step, run_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        requirement = excluded.requirement,
        status = excluded.status,
        current_step = excluded.current_step,
        run_json = excluded.run_json,
        updated_at = excluded.updated_at
    `).run(
      run.id,
      projectId,
      run.title,
      requirement,
      status,
      run.activeStepId,
      JSON.stringify({ ...run, projectId, updatedAt }),
      run.createdAt,
      updatedAt,
    );
    this.touchWorkspace(projectId);
  }

  getWorkflowRun(runId: string): WorkflowRun | null {
    const row = this.db.prepare("SELECT run_json FROM workflow_runs WHERE id = ?").get(runId) as Pick<WorkflowRunRow, "run_json"> | undefined;
    return row ? JSON.parse(row.run_json) as WorkflowRun : null;
  }

  listWorkflowRunSummaries(projectId: string): WorkflowRunSummary[] {
    const rows = this.db.prepare(`
      SELECT id, title, requirement, status, current_step, created_at, updated_at
      FROM workflow_runs
      WHERE project_id = ?
      ORDER BY updated_at DESC
    `).all(projectId) as WorkflowRunRow[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      requirement: row.requirement,
      status: row.status,
      currentStep: row.current_step ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteWorkflowRun(runId: string) {
    this.db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
  }

  deleteWorkspace(id: string) {
    this.db.prepare("DELETE FROM workflow_runs WHERE project_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id) as { changes?: number };
    return result.changes ?? 0;
  }

  close() {
    this.db.close();
  }

  private ensureLastOpenedColumn() {
    if (!this.hasColumn("workspaces", "last_opened_at")) {
      this.db.exec("ALTER TABLE workspaces ADD COLUMN last_opened_at TEXT");
    }
    this.db.prepare("UPDATE workspaces SET last_opened_at = updated_at WHERE last_opened_at IS NULL").run();
  }

  private hasColumn(tableName: string, columnName: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
    return columns.some((column) => column.name === columnName);
  }
}

const defaultStore = new WorkspaceStore();

export function saveWorkspaceToStore(workspace: WorkspaceContext) {
  defaultStore.upsert(workspace);
}

export function listSavedWorkspaces() {
  return defaultStore.list();
}

export function getSavedWorkspace(id: string) {
  return defaultStore.get(id);
}

export function touchSavedWorkspace(id: string) {
  defaultStore.touchWorkspace(id);
}

export function listRecentProjects(limit?: number) {
  return defaultStore.listRecentProjects(limit);
}

export function getSavedProject(id: string) {
  return defaultStore.getProject(id);
}

export function saveWorkflowRunToStore(projectId: string, run: WorkflowRun) {
  defaultStore.saveWorkflowRun(projectId, run);
}

export function getStoredWorkflowRun(runId: string) {
  return defaultStore.getWorkflowRun(runId);
}

export function listStoredWorkflowRuns(projectId: string) {
  return defaultStore.listWorkflowRunSummaries(projectId);
}

export function deleteWorkflowRunFromStore(runId: string) {
  defaultStore.deleteWorkflowRun(runId);
}

export function deleteWorkspaceFromStore(workspaceId: string) {
  return defaultStore.deleteWorkspace(workspaceId);
}

function parseStack(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function getRunRequirement(run: WorkflowRun) {
  const output = run.steps.find((step) => step.id === "requirement_intake")?.output;
  if (output && typeof output === "object" && "rawText" in output && typeof output.rawText === "string") {
    return output.rawText;
  }

  return run.title;
}

function getRunStatus(run: WorkflowRun): WorkflowRunSummary["status"] {
  if (run.steps.some((step) => step.status === "failed")) {
    return "failed";
  }

  if (run.steps.every((step) => step.status === "success")) {
    return "success";
  }

  if (run.steps.some((step) => step.status === "running")) {
    return "running";
  }

  return "paused";
}
