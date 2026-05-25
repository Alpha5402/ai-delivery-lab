import { describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../domain/workspace.js";
import { runRuntimeTool } from "./toolRegistry.js";

function createWorkspace(): WorkspaceContext {
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
});

