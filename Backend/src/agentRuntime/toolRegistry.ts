import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceContext } from "../domain/workspace.js";
import { getGitRuntimeSettings } from "../services/workflowSettingsService.js";
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
};

type RuntimeToolInput = Record<string, unknown>;

function normalizeGitBranchName(input: unknown) {
  const normalized = String(input ?? "")
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/[-.]+(?=\/)/g, "")
    .replace(/\/[-.]+/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "")
    .slice(0, 60);
  if (!normalized) return "";

  const segments = normalized.split("/").filter(Boolean);
  const branch = segments.join("/");
  if (["feature", "fix", "bugfix", "hotfix", "chore", "refactor", "codex"].includes(branch)) {
    return `${branch}/update`;
  }
  return branch;
}

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
    case "git_config_identity":
      return gitConfigIdentity(workspace);
    case "git_create_branch":
      return gitCreateBranch(workspace, input);
    case "git_commit_changes":
      return gitCommitChanges(workspace, input);
    case "git_push_branch":
      return gitPushBranch(workspace, input);
    case "github_create_pr":
      return githubCreatePr(workspace, input);
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
  const scopeOrder = Object.keys(scripts).sort((left, right) => {
    if (left === "root") return -1;
    if (right === "root") return 1;
    if (left === "frontend") return -1;
    if (right === "frontend") return 1;
    return left.localeCompare(right);
  });

  function pick(label: keyof typeof COMMAND_WHITELIST | string, requireScript: string | null) {
    const spec = (COMMAND_WHITELIST as Record<string, { argv: string[]; description: string }>)[label];
    if (!spec) return null;
    const scope = requireScript === null
      ? "root"
      : scopeOrder.find((candidateScope) => scripts[candidateScope]?.includes(requireScript));
    const available = Boolean(scope);
    const cwd = scope && workspace.workspaceDir
      ? path.resolve(workspace.workspaceDir, scope === "root" ? "" : scope)
      : workspace.workspaceDir;
    return {
      label,
      argv: spec.argv,
      description: spec.description,
      scope: scope ?? null,
      cwd,
      available,
      reason: available ? "ok" : `未找到包含 scripts.${requireScript} 的 package.json`,
    };
  }

  return {
    workspaceDir: workspace.workspaceDir,
    candidates: [
      pick("npm:typecheck", "typecheck"),
      pick("npm:lint", "lint"),
      pick("npm:test", "test"),
      pick("npm:build", "build"),
    ].filter(Boolean),
    detectedScripts: Object.fromEntries(Object.entries(scripts).map(([scope, list]) => [scope, [...list].sort()])),
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

  const cwd = resolveCommandCwd(workspace, input.cwd);
  const command = spec.argv.join(" ");
  if (label.startsWith("npm:") && !hasInstalledDependencies(workspace, cwd)) {
    return {
      label,
      command,
      cwd,
      exitCode: null,
      durationMs: 0,
      status: "not_executed" as const,
      stdoutPreview: "",
      stderrPreview: "workspace 依赖未安装：请先在仓库根目录执行 npm install，再运行质量门禁。",
    };
  }
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
      command,
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
      command,
      cwd,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      status: "failed" as const,
      stdoutPreview: (err.stdout ?? "").slice(-maxStreamChars),
      stderrPreview: (err.stderr ?? err.message ?? "").slice(-maxStreamChars),
    };
  }
}

function resolveCommandCwd(workspace: WorkspaceContext, inputCwd: unknown) {
  const workspaceRoot = path.resolve(workspace.workspaceDir ?? "");
  const cwd = typeof inputCwd === "string" && inputCwd.trim()
    ? path.resolve(inputCwd)
    : workspaceRoot;
  if (cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`run_command cwd escaped workspace: ${cwd}`);
  }
  return cwd;
}

function hasInstalledDependencies(workspace: WorkspaceContext, cwd: string) {
  const workspaceRoot = path.resolve(workspace.workspaceDir ?? "");
  return existsSync(path.join(cwd, "node_modules")) || existsSync(path.join(workspaceRoot, "node_modules"));
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
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
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

// ---- 新增 Git 工具 ----

async function gitConfigIdentity(workspace: WorkspaceContext) {
  if (!workspace.workspaceDir) {
    return { ok: false, reason: "workspaceDir is not available" };
  }
  const gitSettings = getGitRuntimeSettings();
  if (!gitSettings.userName || !gitSettings.userEmail) {
    return { ok: false, reason: "GIT_USER_NAME 或 GIT_USER_EMAIL 未配置" };
  }
  try {
    await execFileAsync("git", ["config", "user.name", gitSettings.userName], { cwd: workspace.workspaceDir, timeout: 5_000 });
    await execFileAsync("git", ["config", "user.email", gitSettings.userEmail], { cwd: workspace.workspaceDir, timeout: 5_000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "git config failed" };
  }
}

async function gitCreateBranch(workspace: WorkspaceContext, input: RuntimeToolInput) {
  if (!workspace.workspaceDir) {
    return { ok: false, reason: "workspaceDir is not available" };
  }
  const branch = normalizeGitBranchName(input.branch);
  if (!branch) {
    return { ok: false, reason: "invalid branch name" };
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace.workspaceDir, timeout: 5_000 });
    if (stdout.trim() === branch) {
      return { ok: true, branch, reused: true, reason: "already on target branch" };
    }
  } catch { /* proceed */ }
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: workspace.workspaceDir, timeout: 5_000 });
    await execFileAsync("git", ["checkout", branch], { cwd: workspace.workspaceDir, timeout: 10_000 });
    return { ok: true, branch, reused: true };
  } catch {
    try {
      await execFileAsync("git", ["checkout", "-b", branch], { cwd: workspace.workspaceDir, timeout: 15_000 });
      return { ok: true, branch, reused: false };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "git create branch failed" };
    }
  }
}

async function gitCommitChanges(workspace: WorkspaceContext, input: RuntimeToolInput) {
  if (!workspace.workspaceDir) {
    return { ok: false, reason: "workspaceDir is not available" };
  }
  const message = String(input.message ?? "workflow auto commit").slice(0, 200).replace(/["`$\\]/g, "");
  try {
    // 先用 -z 探测是否有变更（比 --porcelain 更安全，不受文件名空格/引号影响）
    const { stdout: statusZ } = await execFileAsync("git", ["status", "--porcelain", "-z"], { cwd: workspace.workspaceDir, timeout: 10_000 });
    if (!statusZ.trim()) {
      return { ok: true, committed: false, reason: "no changes to commit" };
    }

    // Stage all changes，then unstage protected files (比逐行解析 porcelain 更健壮)
    await execFileAsync("git", ["add", "-A"], { cwd: workspace.workspaceDir, timeout: 15_000 });

    // Unstage PROTECTED_FILENAMES and .git/ node_modules/
    const { stdout: stagedFiles } = await execFileAsync("git", ["diff", "--cached", "--name-only", "-z"], { cwd: workspace.workspaceDir, timeout: 10_000 });
    const filesToUnstage: string[] = [];
    for (const file of stagedFiles.split("\0")) {
      if (!file) continue;
      const name = file.split("/").pop() ?? "";
      if (PROTECTED_FILENAMES.has(name) || file.startsWith(".git/") || file.startsWith("node_modules/")) {
        filesToUnstage.push(file);
      }
    }
    if (filesToUnstage.length > 0) {
      await execFileAsync("git", ["restore", "--staged", ...filesToUnstage], { cwd: workspace.workspaceDir, timeout: 10_000 });
    }

    // 检查 unstage 后是否还有可提交的变更
    const { stdout: remaining } = await execFileAsync("git", ["diff", "--cached", "--name-only", "-z"], { cwd: workspace.workspaceDir, timeout: 10_000 });
    const remainingFiles = remaining.split("\0").filter(Boolean);
    if (remainingFiles.length === 0) {
      return { ok: true, committed: false, reason: "only protected files changed" };
    }

    await execFileAsync("git", ["commit", "-m", message], { cwd: workspace.workspaceDir, timeout: 15_000 });
    return { ok: true, committed: true, filesChanged: remainingFiles.length };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "git commit failed" };
  }
}

async function gitPushBranch(workspace: WorkspaceContext, input: RuntimeToolInput) {
  if (!workspace.workspaceDir) {
    return { ok: false, reason: "workspaceDir is not available" };
  }
  const gitSettings = getGitRuntimeSettings();
  const remote = gitSettings.githubRemote;
  const token = gitSettings.token;
  const branch = normalizeGitBranchName(input.branch);
  if (!branch) {
    return { ok: false, reason: "branch name required" };
  }
  try {
    // 使用 http.extraHeader 传递认证，避免 token 出现在 argv / 进程列表中。
    const extraEnv: Record<string, string> = {};
    if (token) {
      // Git over HTTPS 使用 Basic auth：用户名 + token 作为密码。
      extraEnv.GIT_CONFIG_COUNT = "1";
      extraEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      extraEnv.GIT_CONFIG_VALUE_0 = createGitBasicAuthHeader(token, gitSettings.githubOwner ?? gitSettings.userName);
    }
    await execFileAsync("git", ["push", "-u", remote, `HEAD:refs/heads/${branch}`], {
      cwd: workspace.workspaceDir,
      timeout: 60_000,
      env: { ...process.env, ...extraEnv },
    });
    return { ok: true, branch, remote };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "git push failed";
    // 脱敏：确保 token 不到日志中
    // extraHeader 方式已避免 token 出现在 argv 里，这里做二次保险
    return { ok: false, reason: token ? errMsg.replace(token, "***") : errMsg };
  }
}

function createGitBasicAuthHeader(token: string, username?: string) {
  const credentialUser = username?.trim() || "x-access-token";
  const encoded = Buffer.from(`${credentialUser}:${token}`, "utf-8").toString("base64");
  return `Authorization: Basic ${encoded}`;
}

function detectGitRemoteOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  // https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

async function githubCreatePr(workspace: WorkspaceContext, input: RuntimeToolInput) {
  // GitHub API 需要 token，不支持 password
  const gitSettings = getGitRuntimeSettings();
  const token = gitSettings.token;
  if (!token) {
    return { ok: false, reason: "GITHUB_TOKEN 未配置" };
  }
  if (!workspace.workspaceDir) {
    return { ok: false, reason: "workspaceDir is not available" };
  }
  const title = String(input.title ?? "").slice(0, 200);
  const body = String(input.body ?? "").slice(0, 5_000);
  const headBranch = String(input.head ?? "");
  const baseBranch = String(input.base ?? gitSettings.githubBaseBranch);

  // 推断 owner/repo
  let owner = gitSettings.githubOwner;
  let repo = gitSettings.githubRepo;
  if (!owner || !repo) {
    try {
      const { stdout } = await execFileAsync("git", ["remote", "get-url", gitSettings.githubRemote], { cwd: workspace.workspaceDir, timeout: 5_000 });
      const info = detectGitRemoteOwnerRepo(stdout.trim());
      if (info) { owner = info.owner; repo = info.repo; }
    } catch { /* fall through */ }
  }
  if (!owner || !repo) {
    return { ok: false, reason: "无法推断 GitHub owner/repo，请配置 GITHUB_OWNER/GITHUB_REPO" };
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ title, body, head: headBranch, base: baseBranch }),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, reason: `GitHub API 创建 PR 失败: ${response.status} ${JSON.stringify(payload).slice(0, 500)}`.replace(token, "***") };
    }
    return {
      ok: true,
      url: payload.html_url as string,
      number: payload.number as number,
      status: (payload.state as string) === "open" ? "ready" : "draft",
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.replace(token, "***") : "GitHub API 调用失败" };
  }
}
