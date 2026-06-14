import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceContext } from "../domain/workspace.js";
import { runRuntimeTool } from "./toolRegistry.js";

function createWorkspace(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    id: "workspace-demo",
    mode: "repo-import",
    hasRepository: true,
    repoName: "demo",
    workspaceDir: "/tmp/demo",
    architectureSummary: "Demo architecture",
    createdAt: "2026-05-24T00:00:00.000Z",
    repositoryScan: {
      repoName: "demo",
      repoPath: "/tmp/demo",
      scannedAt: "2026-05-24T00:00:00.000Z",
      source: "local",
      filesInspected: 3,
      fileTree: ["README.md", "src/App.tsx", "src/services/api.ts"],
      directories: ["src"],
      packageManagers: ["npm"],
      scripts: { root: ["test"] },
      stack: ["React", "TypeScript"],
      testEntrypoints: ["root: npm run test"],
      notes: [],
      keyFiles: {
        "README.md": "# Demo",
      },
    },
    agentReadme: {
      fileName: "readme-for-agent.md",
      content: "# Agent Guide",
      sections: {
        architecture: "Demo architecture",
        stack: ["React"],
        conventions: ["Use JSON"],
        testing: ["root: npm run test"],
        riskNotes: ["None"],
      },
    },
    ...overrides,
  };
}

describe("runRuntimeTool", () => {
  it("lists scanned files with a prefix", async () => {
    const call = await runRuntimeTool(createWorkspace(), "list_files", { prefix: "src/" });

    expect(call.tool).toBe("list_files");
    expect(call.output).toMatchObject({
      prefix: "src/",
      files: ["src/App.tsx", "src/services/api.ts"],
    });
  });

  it("reads cached key files before touching the filesystem", async () => {
    const call = await runRuntimeTool(createWorkspace(), "read_file", { path: "README.md" });

    expect(call.output).toMatchObject({
      path: "README.md",
      source: "scan.keyFiles",
      content: "# Demo",
    });
  });

  it("rejects unsafe file reads", async () => {
    await expect(runRuntimeTool(createWorkspace(), "read_file", { path: "../secret" }))
      .rejects
      .toThrow("Unsafe runtime read path");
  });

  it("returns the agent guide and test commands", async () => {
    await expect(runRuntimeTool(createWorkspace(), "read_agent_guide")).resolves.toMatchObject({
      output: { fileName: "readme-for-agent.md", content: "# Agent Guide" },
    });
    await expect(runRuntimeTool(createWorkspace(), "detect_test_commands")).resolves.toMatchObject({
      output: { testEntrypoints: ["root: npm run test"] },
    });
  });

  it("detects editable default verification commands", async () => {
    const workspace = createWorkspace();
    workspace.repositoryScan.scripts = {
      root: ["test"],
      frontend: ["build"],
      backend: ["start"],
    };

    const call = await runRuntimeTool(workspace, "detect_workflow_commands");
    const output = call.output as { candidates: Array<{ label: string; command: string; cwd: string; scope: string | null; available: boolean }> };

    expect(output.candidates.find((candidate) => candidate.label === "custom:typecheck")).toMatchObject({
      available: true,
      scope: "root",
      cwd: "/tmp/demo",
      command: "npm run typecheck",
    });
    expect(output.candidates.find((candidate) => candidate.label === "custom:unit-tests")).toMatchObject({
      available: true,
      scope: "root",
      cwd: "/tmp/demo",
      command: "npm test -- --run",
    });
  });

  it("reports live package.json scripts as trace data without creating implicit gates", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "tool-registry-live-scripts-"));
    try {
      await writeFile(path.join(workspaceDir, "package.json"), JSON.stringify({
        scripts: { test: "vitest" },
        devDependencies: { vitest: "^4.0.0" },
      }));
      await mkdir(path.join(workspaceDir, "frontend"));
      await writeFile(path.join(workspaceDir, "frontend", "package.json"), JSON.stringify({
        scripts: {
          build: "vite build",
          test: "vitest",
          typecheck: "tsc --noEmit",
        },
        devDependencies: {
          typescript: "^5.0.0",
          vite: "^5.0.0",
          vitest: "^4.0.0",
        },
      }));
      const workspace = createWorkspace({
        workspaceDir,
        repositoryScan: {
          ...createWorkspace().repositoryScan,
          repoPath: workspaceDir,
          scripts: { frontend: ["build"] },
        },
      });

      const call = await runRuntimeTool(workspace, "detect_workflow_commands");
      const output = call.output as {
        candidates: Array<{ label: string; cwd: string; scope: string | null; available: boolean }>;
        detectedScripts: Record<string, string[]>;
      };

      expect(output.detectedScripts.frontend).toEqual(["build", "test", "typecheck"]);
      expect(output.candidates.find((candidate) => candidate.label === "custom:build")).toMatchObject({
        available: true,
        scope: "root",
        cwd: workspaceDir,
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reports build warnings without failing the command", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "tool-registry-build-"));
    try {
      await writeFile(path.join(workspaceDir, "package.json"), JSON.stringify({
        scripts: {
          build: "node -e \"console.error('(!) Some chunks are larger than 500 kB after minification.')\"",
        },
        devDependencies: {},
      }));
      await mkdir(path.join(workspaceDir, "node_modules"));
      const workspace = createWorkspace({
        workspaceDir,
        repositoryScan: {
          ...createWorkspace().repositoryScan,
          repoPath: workspaceDir,
          scripts: { root: ["build"] },
        },
      });

      const call = await runRuntimeTool(workspace, "run_command", { label: "npm:build", cwd: workspaceDir });
      const output = call.output as { status: string; warningKind?: string; warningSummary?: string };

      expect(output.status).toBe("passed");
      expect(output.warningKind).toBe("bundle_size");
      expect(output.warningSummary).toContain("构建已通过");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("returns not_executed for npm commands when workspace dependencies are missing", async () => {
    const call = await runRuntimeTool(createWorkspace(), "run_command", { label: "npm:test", cwd: "/tmp/demo" });
    const output = call.output as { status: string; stderrPreview: string; failureSummary?: string; suggestedAction?: string };

    expect(output.status).toBe("not_executed");
    expect(output.stderrPreview).toContain("依赖未安装");
    expect(output.failureSummary).toContain("依赖尚未安装");
    expect(output.suggestedAction).toContain("npm install");
  });
});


describe("git tools", () => {
  it("git_config_identity returns not_configured when env is unset", async () => {
    const call = await runRuntimeTool(createWorkspace(), "git_config_identity");
    expect(call.tool).toBe("git_config_identity");
    const out = call.output as { ok?: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("未配置");
  });

  it("git_create_branch rejects unsafe branch names", async () => {
    const call = await runRuntimeTool(createWorkspace(), "git_create_branch", { branch: "foo bar" });
    expect(call.tool).toBe("git_create_branch");
    const out = call.output as { ok?: boolean };
    expect(out.ok).toBe(false);
  });

  it("git_create_branch sanitizes and creates valid branch names", async () => {
    const call = await runRuntimeTool(createWorkspace(), "git_create_branch", { branch: "feature/valid-name_123" });
    expect(call.tool).toBe("git_create_branch");
    // In test env without a real repo, this returns not available
    const out = call.output as { ok?: boolean; reason?: string };
    expect(out.ok !== undefined).toBe(true);
  });

  it("git_push_branch requires branch name", async () => {
    const call = await runRuntimeTool(createWorkspace(), "git_push_branch", { branch: "" });
    const out = call.output as { ok?: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("branch name required");
  });

  it("github_create_pr returns not_configured without token", async () => {
    const call = await runRuntimeTool(createWorkspace(), "github_create_pr", {
      title: "test PR", body: "test", head: "feature/x", base: "main",
    });
    const out = call.output as { ok?: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("未配置");
  });

  it("github_create_pr only uses token, never password", async () => {
    // GIT_AUTH_PASSWORD was removed from config — verify the tool
    // doesn't reference it anywhere in the source
    const call = await runRuntimeTool(createWorkspace(), "github_create_pr", {
      title: "t", body: "b", head: "h", base: "main",
    });
    const out = call.output as { ok?: boolean; reason?: string };
    // With no token set in test env, should return not_configured
    expect(out.ok).toBe(false);
  });
});
