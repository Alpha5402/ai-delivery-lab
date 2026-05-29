import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceContext } from "../domain/workspace.js";
import type { RuntimeToolCall, RuntimeToolName } from "./types.js";

const execFileAsync = promisify(execFile);
const maxReadChars = 12_000;
const maxStreamChars = 4_000;
const COMMAND_TIMEOUT_MS = 120_000;

/** 严禁用 write_file 覆盖的敏感文件名(不带路径前缀的最后一段)。 */
const PROTECTED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
]);

/**
 * run_command 命令白名单(只允许这些 npm script 名 / 二进制)。
 * 不允许任意 shell —— 由 label 映射到固定参数列表。
 */
const COMMAND_WHITELIST: Record<string, { argv: string[]; description: string }> = {
  "npm:typecheck": { argv: ["npm", "run", "typecheck"], description: "TypeScript 类型检查" },
  "npm:lint": { argv: ["npm", "run", "lint"], description: "ESLint / 代码风格检查" },
  "npm:test": { argv: ["npm", "test", "--", "--run"], description: "Vitest / Jest 单元测试" },
  "npm:build": { argv: ["npm", "run", "build"], description: "构建检查" },
  "tsc:noemit": { argv: ["npx", "tsc", "--noEmit"], description: "tsc --noEmit" },
};

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
    case "detect_workflow_commands":
      return detectWorkflowCommands(workspace);
    case "run_command":
      return runWorkspaceCommand(workspace, input);
    case "write_file":
      return writeWorkspaceFile(workspace, input);
    case "git_checkout_branch":
      return gitCheckoutBranch(workspace, input);
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

/**
 * 探测工作区有哪些可执行验证命令(typecheck/lint/test/build)。
 * 来源:repositoryScan.scripts 中是否包含对应 npm script。
 */
function detectWorkflowCommands(workspace: WorkspaceContext) {
  const scripts = workspace.repositoryScan.scripts ?? {};
  const allScripts = new Set<string>();
  for (const list of Object.values(scripts)) {
    for (const name of list) allScripts.add(name);
  }

  function pick(label: keyof typeof COMMAND_WHITELIST | string, requireScript: string | null) {
    const spec = (COMMAND_WHITELIST as Record<string, { argv: string[]; description: string }>)[label];
    if (!spec) return null;
    const available = requireScript === null || allScripts.has(requireScript);
    return {
      label,
      argv: spec.argv,
      description: spec.description,
      available,
      reason: available ? "ok" : `package.json scripts.${requireScript} 未定义`,
    };
  }

  return {
    workspaceDir: workspace.workspaceDir,
    candidates: [
      pick("npm:typecheck", "typecheck"),
      pick("npm:lint", "lint"),
      pick("npm:test", "test"),
      pick("npm:build", "build"),
      // tsc 兜底:即使没有 typecheck script,只要项目里有 tsconfig 也能跑
      pick("tsc:noemit", null),
    ].filter(Boolean),
    detectedScripts: Array.from(allScripts).sort(),
  };
}

/**
 * 真实执行白名单命令并返回 stdout/stderr 截断 + exitCode。
 * 失败时 status=failed,但不抛出 —— 由调用方决定怎么处理。
 */
async function runWorkspaceCommand(workspace: WorkspaceContext, input: RuntimeToolInput) {
  const label = String(input.label ?? "");
  const spec = COMMAND_WHITELIST[label];
  if (!spec) {
    throw new Error(`run_command 不允许的命令 label: ${label}`);
  }
  if (!workspace.workspaceDir) {
    return {
      label,
      command: spec.argv.join(" "),
      cwd: "",
      exitCode: null,
      durationMs: 0,
      status: "not_executed" as const,
      stdoutPreview: "",
      stderrPreview: "workspaceDir is not available",
    };
  }

  const cwd = workspace.workspaceDir;
  const [bin, ...args] = spec.argv;
  const startedAt = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      label,
      command: spec.argv.join(" "),
      cwd,
      exitCode: 0,
      durationMs: Math.round(performance.now() - startedAt),
      status: "passed" as const,
      stdoutPreview: stdout.slice(-maxStreamChars),
      stderrPreview: stderr.slice(-maxStreamChars),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const exitCode = typeof err.code === "number" ? err.code : null;
    return {
      label,
      command: spec.argv.join(" "),
      cwd,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      status: "failed" as const,
      stdoutPreview: (err.stdout ?? "").slice(-maxStreamChars),
      stderrPreview: (err.stderr ?? err.message ?? "").slice(-maxStreamChars),
    };
  }
}

/**
 * 沙箱写入文件:
 *  - 路径必须相对、且不含 .. ;
 *  - 不允许覆盖 PROTECTED_FILENAMES;
 *  - 不允许写到 .git / node_modules 内部;
 *  - mode=ensure 时若已存在则不覆盖。
 */
async function writeWorkspaceFile(workspace: WorkspaceContext, input: RuntimeToolInput) {
  if (!workspace.workspaceDir) {
    throw new Error("workspaceDir is not available for write_file");
  }
  const relativePath = String(input.path ?? "");
  const content = String(input.content ?? "");
  const mode = (input.mode === "ensure" ? "ensure" : "overwrite") as "ensure" | "overwrite";

  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error(`Unsafe write path: ${relativePath}`);
  }
  const segments = relativePath.split(/[\\/]/);
  const filename = segments[segments.length - 1];
  if (PROTECTED_FILENAMES.has(filename)) {
    throw new Error(`Refusing to write protected file: ${filename}`);
  }
  if (segments.some((seg) => seg === ".git" || seg === "node_modules")) {
    throw new Error(`Refusing to write inside ${segments.join("/")}`);
  }

  const workspaceRoot = path.resolve(workspace.workspaceDir);
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Write escaped workspace: ${relativePath}`);
  }

  if (mode === "ensure" && existsSync(absolutePath)) {
    return { path: relativePath, written: false, reason: "file already exists" };
  }

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf-8");
  return {
    path: relativePath,
    written: true,
    bytes: Buffer.byteLength(content, "utf-8"),
  };
}

/**
 * 切换或创建一个工作区分支。仅在工作区是 git 仓库时可用。
 * - create=true 时如果分支已存在,会切换到该分支并返回 reused=true 而不是抛错。
 */
async function gitCheckoutBranch(workspace: WorkspaceContext, input: RuntimeToolInput) {
  if (!workspace.workspaceDir) {
    return { ok: false, reason: "workspaceDir is not available" };
  }
  const branch = String(input.branch ?? "");
  if (!branch || /[^A-Za-z0-9._/-]/.test(branch)) {
    throw new Error(`Unsafe branch name: ${branch}`);
  }

  try {
    // 已有同名分支:直接 checkout
    await execFileAsync("git", ["rev-parse", "--verify", branch], {
      cwd: workspace.workspaceDir,
      timeout: 10_000,
    });
    await execFileAsync("git", ["checkout", branch], { cwd: workspace.workspaceDir, timeout: 15_000 });
    return { ok: true, branch, reused: true };
  } catch {
    // 不存在:创建
    try {
      await execFileAsync("git", ["checkout", "-b", branch], { cwd: workspace.workspaceDir, timeout: 15_000 });
      return { ok: true, branch, reused: false };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "git checkout -b failed",
      };
    }
  }
}

