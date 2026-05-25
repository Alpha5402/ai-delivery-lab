import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../config/env.js";
import type { RepositorySnapshot } from "../domain/workflow.js";

const execFileAsync = promisify(execFile);

export async function getRepositorySnapshot(): Promise<RepositorySnapshot> {
  if (!env.CONDUIT_REPO_PATH || !existsSync(env.CONDUIT_REPO_PATH)) {
    return {
      name: env.CONDUIT_REPO_PATH ? path.basename(env.CONDUIT_REPO_PATH) : "repository-not-configured",
      branch: "unknown",
      baseCommit: "unknown",
      health: "checking",
    };
  }

  try {
    const [branch, commit, status] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["rev-parse", "--short", "HEAD"]),
      git(["status", "--porcelain"]),
    ]);

    return {
      name: path.basename(env.CONDUIT_REPO_PATH),
      branch,
      baseCommit: commit,
      health: status.length > 0 ? "dirty" : "ready",
    };
  } catch {
    return {
      name: path.basename(env.CONDUIT_REPO_PATH),
      branch: "unknown",
      baseCommit: "unknown",
      health: "checking",
    };
  }
}

async function git(args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: env.CONDUIT_REPO_PATH });
  return stdout.trim();
}
