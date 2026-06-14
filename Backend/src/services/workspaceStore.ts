import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../config/env.js";
import type { WorkflowRun } from "../domain/workflow.js";
import type { ProjectSettings, ProjectWorkspace, RequirementCase, WorkflowRunSummary, WorkspaceContext, WorkspaceSummary } from "../domain/workspace.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const testWorkspaceDbPath = path.join(tmpdir(), `ai-delivery-workspace-test-${process.pid}.sqlite`);

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

type RequirementCaseRow = {
  id: string;
  project_id: string;
  workspace_id: string;
  created_from_run_id: string;
  title: string;
  raw_requirement: string;
  requirement_pattern: string;
  requirement_summary: string;
  accepted_constraints_json: string;
  solution_summary: string;
  touched_files_json: string;
  code_tasks_json: string;
  verification_summary: string;
  pull_request_url: string | null;
  tags_json: string;
  stack_json: string;
  keywords_json: string;
  embedding_text: string | null;
  embedding_json: string | null;
  embedding_model: string | null;
  embedding_updated_at: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectSettingsRow = {
  project_id: string;
  settings_json: string;
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
      CREATE TABLE IF NOT EXISTS requirement_cases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_from_run_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        raw_requirement TEXT NOT NULL,
        requirement_pattern TEXT NOT NULL,
        requirement_summary TEXT NOT NULL,
        accepted_constraints_json TEXT NOT NULL,
        solution_summary TEXT NOT NULL,
        touched_files_json TEXT NOT NULL,
        code_tasks_json TEXT NOT NULL,
        verification_summary TEXT NOT NULL,
        pull_request_url TEXT,
        tags_json TEXT NOT NULL,
        stack_json TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        embedding_text TEXT,
        embedding_json TEXT,
        embedding_model TEXT,
        embedding_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY(created_from_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS project_settings (
        project_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
    `);
    this.ensureLastOpenedColumn();
    this.ensureRequirementCaseEmbeddingColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened_at ON workspaces(last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_updated_at ON workflow_runs(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_requirement_cases_project_updated_at ON requirement_cases(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_requirement_cases_run_id ON requirement_cases(created_from_run_id);
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

  getProjectSettings(projectId: string): ProjectSettings | null {
    const row = this.db.prepare("SELECT settings_json FROM project_settings WHERE project_id = ?")
      .get(projectId) as Pick<ProjectSettingsRow, "settings_json"> | undefined;
    return row ? JSON.parse(row.settings_json) as ProjectSettings : null;
  }

  saveProjectSettings(projectId: string, settings: ProjectSettings) {
    const updatedAt = new Date().toISOString();
    const next = { ...settings, projectId, updatedAt };
    this.db.prepare(`
      INSERT INTO project_settings (project_id, settings_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `).run(projectId, JSON.stringify(next), updatedAt);
    return next;
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
      SELECT wr.id, wr.title, wr.requirement, wr.status, wr.current_step, wr.created_at, wr.updated_at,
        rc.id AS case_id
      FROM workflow_runs wr
      LEFT JOIN requirement_cases rc ON rc.created_from_run_id = wr.id
      WHERE wr.project_id = ?
      ORDER BY wr.updated_at DESC
    `).all(projectId) as WorkflowRunRow[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      requirement: row.requirement,
      status: row.status,
      currentStep: row.current_step ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      caseId: (row as WorkflowRunRow & { case_id?: string }).case_id,
      caseFavorited: Boolean((row as WorkflowRunRow & { case_id?: string }).case_id),
    }));
  }

  deleteWorkflowRun(runId: string) {
    this.db.prepare("DELETE FROM requirement_cases WHERE created_from_run_id = ?").run(runId);
    this.db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
  }

  deleteWorkspace(id: string) {
    this.db.prepare("DELETE FROM requirement_cases WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM workflow_runs WHERE project_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id) as { changes?: number };
    return result.changes ?? 0;
  }

  upsertRequirementCase(item: RequirementCase): RequirementCase {
    const existing = this.getRequirementCaseByRun(item.createdFromRunId);
    const createdAt = existing?.createdAt ?? item.createdAt;
    this.db.prepare(`
      INSERT INTO requirement_cases (
        id, project_id, workspace_id, created_from_run_id, title, raw_requirement,
        requirement_pattern, requirement_summary, accepted_constraints_json,
        solution_summary, touched_files_json, code_tasks_json, verification_summary,
        pull_request_url, tags_json, stack_json, keywords_json,
        embedding_text, embedding_json, embedding_model, embedding_updated_at,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(created_from_run_id) DO UPDATE SET
        title = excluded.title,
        raw_requirement = excluded.raw_requirement,
        requirement_pattern = excluded.requirement_pattern,
        requirement_summary = excluded.requirement_summary,
        accepted_constraints_json = excluded.accepted_constraints_json,
        solution_summary = excluded.solution_summary,
        touched_files_json = excluded.touched_files_json,
        code_tasks_json = excluded.code_tasks_json,
        verification_summary = excluded.verification_summary,
        pull_request_url = excluded.pull_request_url,
        tags_json = excluded.tags_json,
        stack_json = excluded.stack_json,
        keywords_json = excluded.keywords_json,
        embedding_text = excluded.embedding_text,
        embedding_json = excluded.embedding_json,
        embedding_model = excluded.embedding_model,
        embedding_updated_at = excluded.embedding_updated_at,
        updated_at = excluded.updated_at
    `).run(
      existing?.id ?? item.id,
      item.projectId,
      item.workspaceId,
      item.createdFromRunId,
      item.title,
      item.rawRequirement,
      item.requirementPattern,
      item.requirementSummary,
      JSON.stringify(item.acceptedConstraints),
      item.solutionSummary,
      JSON.stringify(item.touchedFiles),
      JSON.stringify(item.codeTasks),
      item.verificationSummary,
      item.pullRequestUrl ?? null,
      JSON.stringify(item.tags),
      JSON.stringify(item.stack),
      JSON.stringify(item.keywords),
      item.embeddingText ?? null,
      item.embedding ? JSON.stringify(item.embedding) : null,
      item.embeddingModel ?? null,
      item.embeddingUpdatedAt ?? null,
      createdAt,
      item.updatedAt,
    );
    return this.getRequirementCaseByRun(item.createdFromRunId) ?? { ...item, id: existing?.id ?? item.id, createdAt };
  }

  listRequirementCases(projectId: string): RequirementCase[] {
    const rows = this.db.prepare(`
      SELECT * FROM requirement_cases
      WHERE project_id = ?
      ORDER BY updated_at DESC
    `).all(projectId) as RequirementCaseRow[];
    return rows.map(mapRequirementCaseRow);
  }

  getRequirementCase(projectId: string, caseId: string): RequirementCase | null {
    const row = this.db.prepare(`
      SELECT * FROM requirement_cases
      WHERE project_id = ? AND id = ?
    `).get(projectId, caseId) as RequirementCaseRow | undefined;
    return row ? mapRequirementCaseRow(row) : null;
  }

  getRequirementCaseByRun(runId: string): RequirementCase | null {
    const row = this.db.prepare(`
      SELECT * FROM requirement_cases
      WHERE created_from_run_id = ?
    `).get(runId) as RequirementCaseRow | undefined;
    return row ? mapRequirementCaseRow(row) : null;
  }

  deleteRequirementCase(projectId: string, caseId: string) {
    const result = this.db.prepare("DELETE FROM requirement_cases WHERE project_id = ? AND id = ?").run(projectId, caseId) as { changes?: number };
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

  private ensureRequirementCaseEmbeddingColumns() {
    const columns: Array<[string, string]> = [
      ["embedding_text", "TEXT"],
      ["embedding_json", "TEXT"],
      ["embedding_model", "TEXT"],
      ["embedding_updated_at", "TEXT"],
    ];
    for (const [name, type] of columns) {
      if (!this.hasColumn("requirement_cases", name)) {
        this.db.exec(`ALTER TABLE requirement_cases ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private hasColumn(tableName: string, columnName: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
    return columns.some((column) => column.name === columnName);
  }
}

function resolveDefaultStorePath() {
  if (env.NODE_ENV === "test" && !process.env.WORKSPACE_DB_PATH) {
    return testWorkspaceDbPath;
  }
  return env.WORKSPACE_DB_PATH;
}

const defaultStore = new WorkspaceStore(resolveDefaultStorePath());

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

export function getProjectSettingsFromStore(projectId: string) {
  return defaultStore.getProjectSettings(projectId);
}

export function saveProjectSettingsToStore(projectId: string, settings: ProjectSettings) {
  return defaultStore.saveProjectSettings(projectId, settings);
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

export function saveRequirementCaseToStore(item: RequirementCase) {
  return defaultStore.upsertRequirementCase(item);
}

export function listRequirementCasesFromStore(projectId: string) {
  return defaultStore.listRequirementCases(projectId);
}

export function getRequirementCaseFromStore(projectId: string, caseId: string) {
  return defaultStore.getRequirementCase(projectId, caseId);
}

export function getRequirementCaseByRunFromStore(runId: string) {
  return defaultStore.getRequirementCaseByRun(runId);
}

export function deleteRequirementCaseFromStore(projectId: string, caseId: string) {
  return defaultStore.deleteRequirementCase(projectId, caseId);
}

function parseStack(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseStringArray(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseNumberArray(raw: string | null) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : undefined;
  } catch {
    return undefined;
  }
}

function mapRequirementCaseRow(row: RequirementCaseRow): RequirementCase {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    createdFromRunId: row.created_from_run_id,
    title: row.title,
    rawRequirement: row.raw_requirement,
    requirementPattern: row.requirement_pattern,
    requirementSummary: row.requirement_summary,
    acceptedConstraints: parseStringArray(row.accepted_constraints_json),
    solutionSummary: row.solution_summary,
    touchedFiles: parseStringArray(row.touched_files_json),
    codeTasks: parseStringArray(row.code_tasks_json),
    verificationSummary: row.verification_summary,
    pullRequestUrl: row.pull_request_url ?? undefined,
    tags: parseStringArray(row.tags_json),
    stack: parseStringArray(row.stack_json),
    keywords: parseStringArray(row.keywords_json),
    embeddingText: row.embedding_text ?? undefined,
    embedding: parseNumberArray(row.embedding_json),
    embeddingModel: row.embedding_model ?? undefined,
    embeddingUpdatedAt: row.embedding_updated_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
