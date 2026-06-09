import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { generateAgentReadme } from "../agents/repositoryContextAgent.js";
import type {
  ImportWorkspaceInput,
  QuickProjectInput,
  RepositoryScanResult,
  WorkspaceContext,
} from "../domain/workspace.js";
import { logWorkspaceEvent, summarizeError } from "./workspaceLogger.js";
import { deleteWorkspaceFromStore, getSavedProject, getSavedWorkspace, listRecentProjects, listSavedWorkspaces, saveWorkspaceToStore, touchSavedWorkspace } from "./workspaceStore.js";
import { getGitRuntimeSettings } from "./workflowSettingsService.js";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolveWorkspaceRoot();
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo"]);
const maxFilesToInspect = 320;
const maxKeyFileChars = 8_000;
const gitCloneTimeoutMs = 300_000;

let currentWorkspace: WorkspaceContext | null = null;

export async function importWorkspace(input: ImportWorkspaceInput) {
  const repoName = deriveRepoName(input.repoUrl);
  logWorkspaceEvent("import.request", { repoUrl: input.repoUrl, repoName });
  const scan = await scanRepository(input.repoUrl, repoName);
  currentWorkspace = await createWorkspaceContext({
    mode: "repo-import",
    hasRepository: true,
    repoUrl: input.repoUrl,
    repoName,
    scan,
  });
  saveWorkspaceToStore(currentWorkspace);
  logWorkspaceEvent("import.success", {
    workspaceId: currentWorkspace.id,
    repoName,
    workspaceDir: currentWorkspace.workspaceDir,
    source: scan.source,
    filesInspected: scan.filesInspected,
    stack: scan.stack,
    packageManagers: scan.packageManagers,
  });
  return currentWorkspace;
}

export async function createQuickProjectWorkspace(input: QuickProjectInput) {
  const repoName = input.title.trim();
  logWorkspaceEvent("quickProject.request", { repoName, stackPreference: input.stackPreference });
  const scan: RepositoryScanResult = {
    repoName,
    scannedAt: new Date().toISOString(),
    source: "quick-project",
    filesInspected: 0,
    fileTree: [
      "src/",
      "src/features/",
      "src/routes/",
      "src/services/",
      "tests/",
    ],
    directories: ["src", "src/features", "src/routes", "src/services", "tests"],
    packageManagers: ["npm"],
    scripts: {
      frontend: ["dev", "build", "test"],
      backend: ["dev", "build", "test"],
    },
    stack: input.stackPreference === "react-only" ? ["React", "TypeScript", "Vite"] : ["React", "TypeScript", "Vite", "Node API"],
    testEntrypoints: ["Vitest for pure logic", "API contract tests once backend exists"],
    notes: [`Project brief: ${input.description}`],
    keyFiles: {
      "PROJECT_BRIEF.md": input.description,
    },
  };

  currentWorkspace = await createWorkspaceContext({
    mode: "quick-project",
    hasRepository: false,
    repoName,
    scan,
  });
  saveWorkspaceToStore(currentWorkspace);
  logWorkspaceEvent("quickProject.success", { workspaceId: currentWorkspace.id, repoName });
  return currentWorkspace;
}

export function getCurrentWorkspace() {
  return currentWorkspace;
}

export function listParsedWorkspaces() {
  return listSavedWorkspaces();
}

export function openParsedWorkspace(workspaceId: string) {
  const workspace = getSavedWorkspace(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  currentWorkspace = workspace;
  touchSavedWorkspace(workspace.id);
  logWorkspaceEvent("workspace.openSaved", {
    workspaceId: workspace.id,
    repoName: workspace.repoName,
    workspaceDir: workspace.workspaceDir,
    source: workspace.repositoryScan.source,
  });
  return workspace;
}

export function listRecentProjectWorkspaces(limit?: number) {
  return listRecentProjects(limit);
}

export function getProjectWorkspace(projectId: string) {
  const project = getSavedProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  touchSavedWorkspace(projectId);
  const workspace = getSavedWorkspace(projectId);
  if (workspace) {
    currentWorkspace = workspace;
  }

  return project;
}

export async function deleteProjectWorkspace(projectId: string, deleteDirectory = false) {
  const workspace = getSavedWorkspace(projectId);
  if (!workspace) {
    throw new Error(`Project not found: ${projectId}`);
  }

  if (deleteDirectory && workspace.workspaceDir) {
    await rm(workspace.workspaceDir, { recursive: true, force: true });
  }

  const deletedRows = deleteWorkspaceFromStore(projectId);
  if (deletedRows < 1) {
    throw new Error(`Workspace delete did not remove a database row: ${projectId}`);
  }

  if (currentWorkspace?.id === projectId) {
    currentWorkspace = null;
  }

  logWorkspaceEvent("workspace.deleted", {
    workspaceId: projectId,
    repoName: workspace.repoName,
    workspaceDir: workspace.workspaceDir,
    deleteDirectory,
  });
}

export function deriveRepoName(repoUrl: string) {
  const trimmed = repoUrl.trim().replace(/\.git$/i, "");
  const parts = trimmed.split(/[/:]/).filter(Boolean);
  return sanitizeName(parts.at(-1) ?? "imported-repository");
}

export function isValidGitUrl(value: string) {
  return /^(https?:\/\/|git@)[^\s]+(\.git)?$/i.test(value.trim()) || existsSync(value.trim());
}

async function scanRepository(repoUrl: string, repoName: string): Promise<RepositoryScanResult> {
  if (!isValidGitUrl(repoUrl)) {
    logWorkspaceEvent("scan.invalidInput", { repoUrl, repoName });
    throw new Error("请输入有效的 Git URL 或本地仓库路径");
  }

  const localPath = repoUrl.trim();
  if (existsSync(localPath)) {
    logWorkspaceEvent("scan.local.start", { repoPath: localPath, repoName });
    return scanLocalRepository(localPath, repoName, repoUrl, "local");
  }

  const clonePath = await resolveClonePath(repoName);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    logWorkspaceEvent("clone.start", { repoUrl, clonePath, repoName, timeoutMs: gitCloneTimeoutMs });
    // 对 GitHub HTTPS URL 注入认证（和 push 方式一致，使用 http.extraHeader）
    const cloneEnv: Record<string, string> = {};
    const gitSettings = getGitRuntimeSettings();
    const cloneToken = gitSettings.token;
    if (cloneToken && repoUrl.startsWith("https://github.com/")) {
      cloneEnv.GIT_CONFIG_COUNT = "1";
      cloneEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      cloneEnv.GIT_CONFIG_VALUE_0 = createGitBasicAuthHeader(cloneToken, gitSettings.githubOwner ?? gitSettings.userName);
    }
    await execFileAsync("git", ["clone", "--depth", "1", repoUrl, clonePath], {
      timeout: gitCloneTimeoutMs,
      env: cloneToken ? { ...process.env, ...cloneEnv } : undefined,
    });
    logWorkspaceEvent("clone.success", { repoUrl, clonePath, repoName });
    return scanLocalRepository(clonePath, repoName, repoUrl, "cloned");
  } catch (error) {
    await rm(clonePath, { recursive: true, force: true }).catch(() => undefined);
    logWorkspaceEvent("clone.failed", { repoUrl, clonePath, repoName, error: summarizeError(error) });
    const gitSettings = getGitRuntimeSettings();
    throw new Error(`仓库克隆失败：${formatGitCloneError(error, gitSettings.token ? describeTokenForDiagnostics(gitSettings.token, gitSettings.tokenSource) : undefined)}`);
  }
}

async function scanLocalRepository(repoPath: string, repoName: string, repoUrl: string | undefined, source: "cloned" | "local") {
  logWorkspaceEvent("scan.files.start", { repoPath, repoName, source, maxFilesToInspect });
  const files = await collectFiles(repoPath);
  const packageJsonFiles = files.filter((file) => file.endsWith("package.json"));
  const scripts: Record<string, string[]> = {};
  const dependencies = new Set<string>();
  const keyFiles = await collectKeyFiles(repoPath, files);
  logWorkspaceEvent("scan.files.collected", {
    repoPath,
    repoName,
    source,
    filesInspected: files.length,
    packageJsonFiles,
    keyFiles: Object.keys(keyFiles),
    previewFiles: files.slice(0, 24),
  });

  for (const packageFile of packageJsonFiles) {
    const relativeDir = path.dirname(packageFile) === "." ? "root" : path.dirname(packageFile);
    try {
      const parsed = JSON.parse(await readFile(path.join(repoPath, packageFile), "utf-8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      scripts[relativeDir] = Object.keys(parsed.scripts ?? {});
      for (const dep of Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) })) {
        dependencies.add(dep);
      }
      logWorkspaceEvent("scan.packageJson.parsed", {
        packageFile,
        packageScope: relativeDir,
        scripts: scripts[relativeDir],
        dependencyCount: dependencies.size,
      });
    } catch {
      scripts[relativeDir] = [];
      logWorkspaceEvent("scan.packageJson.failed", { packageFile, packageScope: relativeDir });
    }
  }

  const directories = topDirectories(files);
  const packageManagers = detectPackageManagers(files);
  const stack = inferStack(files, dependencies);
  const testEntrypoints = inferTestEntrypoints(files, scripts);
  const notes = inferNotes(files, dependencies);
  logWorkspaceEvent("scan.inferred", {
    repoName,
    source,
    directories,
    packageManagers,
    stack,
    testEntrypoints,
    notes,
    keyFiles: Object.keys(keyFiles),
  });

  return {
    repoUrl,
    repoPath,
    repoName,
    scannedAt: new Date().toISOString(),
    source,
    filesInspected: files.length,
    fileTree: files,
    directories,
    packageManagers,
    scripts,
    stack,
    testEntrypoints,
    notes,
    keyFiles,
  } satisfies RepositoryScanResult;
}

async function collectKeyFiles(repoPath: string, files: string[]) {
  const wanted = files.filter((file) => {
    const normalized = file.replaceAll(path.sep, "/").toLowerCase();
    return normalized === "readme.md"
      || normalized === "package.json"
      || normalized === "backend/package.json"
      || normalized === "frontend/package.json"
      || normalized.endsWith("/vite.config.js")
      || normalized.endsWith("/vite.config.ts")
      || normalized.endsWith("/main.jsx")
      || normalized.endsWith("/main.tsx")
      || normalized.endsWith("/app.jsx")
      || normalized.endsWith("/app.tsx")
      || normalized.endsWith("/routes/index.js")
      || normalized.endsWith("/index.js")
      || normalized.includes("controllers/")
      || normalized.includes("middleware/")
      || normalized.includes("models/")
      || normalized.includes("routes/")
      || normalized.includes("frontend/src/components/")
      || normalized.includes("frontend/src/pages/")
      || normalized.includes("frontend/src/views/")
      || normalized.includes("frontend/src/routes/")
      || normalized.includes("frontend/src/services/")
      || normalized.includes("frontend/src/store/");
  }).slice(0, 36);

  const keyFiles: Record<string, string> = {};
  for (const file of wanted) {
    try {
      keyFiles[file] = (await readFile(path.join(repoPath, file), "utf-8")).slice(0, maxKeyFileChars);
    } catch {
      // Ignore unreadable optional context files; the file list is still available in scan facts.
    }
  }
  return keyFiles;
}

async function collectFiles(root: string) {
  const results: string[] = [];

  async function walk(current: string) {
    if (results.length >= maxFilesToInspect) {
      return;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFilesToInspect) {
        break;
      }

      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolute);
        if (fileStat.size <= 512_000) {
          results.push(relative);
        }
      }
    }
  }

  await walk(root);
  return results.sort();
}

function topDirectories(files: string[]) {
  return [...new Set(files
    .filter((file) => file.includes(path.sep))
    .map((file) => file.split(path.sep)[0])
    .filter(Boolean))]
    .slice(0, 18);
}

function detectPackageManagers(files: string[]) {
  const managers = [];
  if (files.includes("package-lock.json")) managers.push("npm");
  if (files.includes("pnpm-lock.yaml")) managers.push("pnpm");
  if (files.includes("yarn.lock")) managers.push("yarn");
  if (files.includes("bun.lockb")) managers.push("bun");
  return managers.length > 0 ? managers : ["unknown"];
}

function inferStack(files: string[], dependencies: Set<string>) {
  const stack = new Set<string>();
  if (dependencies.has("react") || files.some((file) => /\.(tsx|jsx)$/.test(file))) stack.add("React");
  if (dependencies.has("vite") || files.some((file) => file.startsWith("vite.config"))) stack.add("Vite");
  if (dependencies.has("express")) stack.add("Express");
  if (dependencies.has("sequelize")) stack.add("Sequelize");
  if (dependencies.has("pg")) stack.add("PostgreSQL");
  if (dependencies.has("vitest")) stack.add("Vitest");
  if (files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) stack.add("TypeScript");
  if (files.some((file) => file.endsWith(".js") || file.endsWith(".mjs"))) stack.add("JavaScript");
  return stack.size > 0 ? [...stack] : ["Unknown stack"];
}

function inferTestEntrypoints(files: string[], scripts: Record<string, string[]>) {
  const testEntrypoints = new Set<string>();
  for (const [scope, scriptNames] of Object.entries(scripts)) {
    for (const scriptName of scriptNames) {
      if (/test|lint|check|typecheck/i.test(scriptName)) {
        testEntrypoints.add(`${scope}: npm run ${scriptName}`);
      }
    }
  }
  if (files.some((file) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file))) {
    testEntrypoints.add("Detected colocated test/spec files");
  }
  return testEntrypoints.size > 0 ? [...testEntrypoints] : ["No test entrypoint detected yet"];
}

function inferNotes(files: string[], dependencies: Set<string>) {
  const notes: string[] = [];
  if (files.some((file) => file.toLowerCase() === "readme.md")) {
    notes.push("README.md exists and should be read before code generation.");
  }
  if (files.filter((file) => file.endsWith("package.json")).length > 1) {
    notes.push("Multiple package.json files suggest monorepo or split frontend/backend packages.");
  }
  if (dependencies.has("sequelize")) {
    notes.push("Database schema changes likely require model, migration, API, type and fixture updates.");
  }
  if (dependencies.has("react")) {
    notes.push("Frontend changes should preserve existing component and routing conventions.");
  }
  return notes;
}

async function createWorkspaceContext(input: {
  mode: "repo-import" | "quick-project";
  hasRepository: boolean;
  repoUrl?: string;
  repoName: string;
  scan: RepositoryScanResult;
}): Promise<WorkspaceContext> {
  const architectureSummary = summarizeArchitecture(input.scan);
  logWorkspaceEvent("readme.generate", {
    repoName: input.repoName,
    source: input.scan.source,
    architectureSummary,
    directories: input.scan.directories,
    scripts: input.scan.scripts,
  });
  const agentReadme = await generateAgentReadme(input.repoName, input.scan);
  return {
    id: `workspace-${sanitizeName(input.repoName)}-${Date.now().toString(36)}`,
    mode: input.mode,
    hasRepository: input.hasRepository,
    repoUrl: input.repoUrl,
    workspaceDir: input.scan.repoPath,
    repoName: input.repoName,
    architectureSummary: agentReadme.sections.architecture,
    repositoryScan: input.scan,
    agentReadme,
    createdAt: new Date().toISOString(),
  };
}

function summarizeArchitecture(scan: RepositoryScanResult) {
  const sourceLabel = scan.source === "cloned" ? "已浅克隆并扫描仓库" : scan.source === "local" ? "已扫描本地仓库" : "已生成快速项目上下文";
  return `${sourceLabel}：识别到 ${scan.stack.join(" / ")}，检查 ${scan.filesInspected} 个文件，测试入口包括 ${scan.testEntrypoints.slice(0, 2).join("；")}。`;
}

function sanitizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}

function resolveWorkspaceRoot() {
  const cwd = process.cwd();
  return path.basename(cwd) === "Backend"
    ? path.resolve(cwd, "..", "workspace")
    : path.resolve(cwd, "workspace");
}

async function resolveClonePath(repoName: string) {
  const preferredPath = path.join(workspaceRoot, repoName);
  if (!existsSync(preferredPath)) {
    return preferredPath;
  }

  return path.join(workspaceRoot, `${repoName}-${Date.now().toString(36)}`);
}

function isGitAuthFailureDetail(detail: string) {
  const lower = detail.toLowerCase();
  return lower.includes("invalid credentials") ||
    lower.includes("authentication failed") ||
    lower.includes("bad credentials");
}

function describeTokenForDiagnostics(token: string, source: "settings" | "env" | "none") {
  const digest = createHash("sha256").update(token).digest("hex");
  return {
    source,
    length: token.length,
    sha256: digest,
    authMethod: "git http.extraHeader: Authorization: Basic base64(username:<token>)",
  };
}

function createGitBasicAuthHeader(token: string, username?: string) {
  const credentialUser = username?.trim() || "x-access-token";
  const encoded = Buffer.from(`${credentialUser}:${token}`, "utf-8").toString("base64");
  return `Authorization: Basic ${encoded}`;
}

function formatGitCloneError(
  error: unknown,
  tokenDiagnostics?: ReturnType<typeof describeTokenForDiagnostics>,
) {
  if (!error || typeof error !== "object") {
    return "git clone failed";
  }

  const maybeError = error as { message?: string; stderr?: string; stdout?: string; code?: string | number };
  const details = [maybeError.stderr, maybeError.stdout, maybeError.message]
    .filter((item): item is string => Boolean(item))
    .join("\n")
    .trim();

  const fallback = details || `git clone failed${maybeError.code ? ` (${maybeError.code})` : ""}`;
  if (tokenDiagnostics && isGitAuthFailureDetail(fallback)) {
    return `GitHub Token 无效、已过期，或没有访问该仓库的权限。请在设置中更新 Token，或确认 fine-grained token 已授权目标 owner/repo。
Token 诊断：source=${tokenDiagnostics.source}, length=${tokenDiagnostics.length}, sha256=${tokenDiagnostics.sha256}, auth=${tokenDiagnostics.authMethod}
${fallback}`;
  }

  return fallback;
}
