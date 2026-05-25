import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceContext } from "../domain/workspace.js";
import type { RuntimeToolCall, RuntimeToolName } from "./types.js";

const execFileAsync = promisify(execFile);
const maxReadChars = 12_000;

type RuntimeToolInput = Record<string, unknown>;

export async function runRuntimeTool(
  workspace: WorkspaceContext,
  tool: RuntimeToolName,
  input: RuntimeToolInput = {},
): Promise<RuntimeToolCall> {
  const startedAt = performance.now();
  const output = await executeTool(workspace, tool, input);

  return {
    tool,
    input,
    output,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function executeTool(workspace: WorkspaceContext, tool: RuntimeToolName, input: RuntimeToolInput) {
  switch (tool) {
    case "list_files":
      return listFiles(workspace, input);
    case "read_file":
      return readWorkspaceFile(workspace, input);
    case "read_agent_guide":
      return {
        fileName: workspace.agentReadme.fileName,
        content: workspace.agentReadme.content,
      };
    case "git_status":
      return gitStatus(workspace);
    case "detect_test_commands":
      return {
        testEntrypoints: workspace.repositoryScan.testEntrypoints,
        scripts: workspace.repositoryScan.scripts,
      };
  }
}

function listFiles(workspace: WorkspaceContext, input: RuntimeToolInput) {
  const prefix = typeof input.prefix === "string" ? input.prefix : "";
  const limit = typeof input.limit === "number" ? Math.max(1, Math.min(input.limit, 80)) : 80;
  const files = workspace.repositoryScan.fileTree
    .filter((file) => file.startsWith(prefix))
    .slice(0, limit);

  return {
    totalScanned: workspace.repositoryScan.fileTree.length,
    prefix,
    files,
  };
}

async function readWorkspaceFile(workspace: WorkspaceContext, input: RuntimeToolInput) {
  const relativePath = String(input.path ?? "");
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error(`Unsafe runtime read path: ${relativePath}`);
  }

  const keyFile = workspace.repositoryScan.keyFiles[relativePath];
  if (keyFile) {
    return {
      path: relativePath,
      source: "scan.keyFiles",
      content: keyFile.slice(0, maxReadChars),
    };
  }

  if (!workspace.workspaceDir) {
    throw new Error("Workspace directory is not available for runtime file reads");
  }

  const absolutePath = path.resolve(workspace.workspaceDir, relativePath);
  const workspaceRoot = path.resolve(workspace.workspaceDir);
  if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Runtime read escaped workspace: ${relativePath}`);
  }

  if (!existsSync(absolutePath)) {
    throw new Error(`Runtime file not found: ${relativePath}`);
  }

  return {
    path: relativePath,
    source: "workspace",
    content: (await readFile(absolutePath, "utf-8")).slice(0, maxReadChars),
  };
}

async function gitStatus(workspace: WorkspaceContext) {
  if (!workspace.workspaceDir) {
    return { available: false, reason: "workspaceDir is not available" };
  }

  try {
    const [{ stdout: branch }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace.workspaceDir, timeout: 10_000 }),
      execFileAsync("git", ["status", "--porcelain"], { cwd: workspace.workspaceDir, timeout: 10_000 }),
    ]);

    return {
      available: true,
      branch: branch.trim(),
      dirty: status.trim().length > 0,
      status: status.trim(),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "git status failed",
    };
  }
}

