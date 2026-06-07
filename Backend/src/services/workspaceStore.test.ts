import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import { WorkspaceStore } from "./workspaceStore.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function createWorkspace(id = "workspace-demo"): WorkspaceContext {
  return {
    id,
    mode: "repo-import",
    hasRepository: true,
    repoUrl: "https://github.com/example/demo.git",
    workspaceDir: "/tmp/demo",
    repoName: "demo",
    architectureSummary: "Demo architecture",
    createdAt: "2026-05-24T00:00:00.000Z",
    repositoryScan: {
      repoUrl: "https://github.com/example/demo.git",
      repoPath: "/tmp/demo",
      repoName: "demo",
      scannedAt: "2026-05-24T00:00:00.000Z",
      source: "cloned",
      filesInspected: 2,
      fileTree: ["README.md", "src/index.ts"],
      directories: ["src"],
      packageManagers: ["npm"],
      scripts: { root: ["test"] },
      stack: ["TypeScript"],
      testEntrypoints: ["root: npm run test"],
      notes: ["Read README.md first"],
      keyFiles: { "README.md": "# Demo" },
    },
    agentReadme: {
      fileName: "readme-for-agent.md",
      content: "# Agent Context",
      sections: {
        architecture: "Demo architecture",
        stack: ["TypeScript"],
        conventions: ["Use JSON"],
        testing: ["root: npm run test"],
        riskNotes: ["None"],
      },
    },
  };
}

function createWorkflowRun(projectId: string, id = "run-demo"): WorkflowRun {
  return {
    id,
    projectId,
    title: "增加字数统计",
    createdAt: "2026-05-24T01:00:00.000Z",
    updatedAt: "2026-05-24T01:05:00.000Z",
    activeStepId: "clarification",
    steps: [
      {
        id: "requirement_intake",
        label: "接收需求",
        agent: "接收需求",
        status: "success",
        input: { source: "pm" },
        output: {
          title: "增加字数统计",
          rawText: "文章详情页新增字数统计",
          pattern: "frontend-only",
          targetRepo: "conduit",
        },
        logs: ["需求已接收"],
      },
      {
        id: "clarification",
        label: "确认需求",
        agent: "确认需求",
        status: "waiting-human",
        input: { from: "requirement_intake" },
        logs: [],
      },
    ],
  } as WorkflowRun;
}

describe("WorkspaceStore", () => {
  it("persists workspace summaries and full mdc context in SQLite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-store-test-"));
    const dbPath = path.join(dir, "workspaces.sqlite");
    const store = new WorkspaceStore(dbPath);
    const workspace = createWorkspace();

    store.upsert(workspace);

    expect(store.list()).toEqual([
      expect.objectContaining({
        id: workspace.id,
        repoName: "demo",
        source: "cloned",
        filesInspected: 2,
        stack: ["TypeScript"],
      }),
    ]);
    expect(store.get(workspace.id)?.agentReadme.content).toBe("# Agent Context");
    store.close();

    const reopened = new WorkspaceStore(dbPath);
    expect(reopened.get(workspace.id)?.repositoryScan.fileTree).toEqual(["README.md", "src/index.ts"]);
    reopened.close();
  });

  it("persists project workflow history and recent project metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-store-test-"));
    const dbPath = path.join(dir, "workspaces.sqlite");
    const store = new WorkspaceStore(dbPath);
    const workspace = createWorkspace();
    const run = createWorkflowRun(workspace.id);

    store.upsert(workspace);
    store.saveWorkflowRun(workspace.id, run);

    const project = store.getProject(workspace.id);
    expect(project?.workflowRuns).toEqual([
      expect.objectContaining({
        id: run.id,
        title: "增加字数统计",
        requirement: "文章详情页新增字数统计",
        status: "paused",
        currentStep: "clarification",
      }),
    ]);
    expect(store.getWorkflowRun(run.id)?.steps[0]?.output).toMatchObject({ rawText: "文章详情页新增字数统计" });
    expect(store.listRecentProjects(1)[0]).toMatchObject({ id: workspace.id, name: "demo" });

    store.close();
  });

  it("migrates legacy workspace databases without last_opened_at", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-store-legacy-test-"));
    const dbPath = path.join(dir, "workspaces.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE workspaces (
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
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO workspaces (
        id, repo_name, mode, has_repository, repo_url, workspace_dir, source,
        files_inspected, stack_json, workspace_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "workspace-legacy",
      "legacy",
      "repo-import",
      1,
      null,
      "/tmp/legacy",
      "local",
      0,
      "[]",
      JSON.stringify(createWorkspace("workspace-legacy")),
      "2026-05-24T00:00:00.000Z",
      "2026-05-24T00:10:00.000Z",
    );
    db.close();

    const store = new WorkspaceStore(dbPath);

    expect(store.list()[0]).toMatchObject({
      id: "workspace-legacy",
      lastOpenedAt: "2026-05-24T00:10:00.000Z",
    });
    store.close();
  });
});
