import type { WorkspaceContext } from "./types";

/**
 * 会话级 workspace 缓存（in-memory only）。
 * 不再写 localStorage，后端 SQLite 是 source-of-truth。
 * 此缓存仅用于同一 tab 内跨页面导航时避免重复请求。
 */
let sessionWorkspace: WorkspaceContext | null = null;

export function saveWorkspace(workspace: WorkspaceContext) {
  sessionWorkspace = workspace;
}

export function loadWorkspace(): WorkspaceContext | null {
  return sessionWorkspace;
}

export function clearWorkspace() {
  sessionWorkspace = null;
}
