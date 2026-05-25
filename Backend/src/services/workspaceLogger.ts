export type WorkspaceLogMeta = Record<string, unknown>;

export function logWorkspaceEvent(event: string, meta: WorkspaceLogMeta = {}) {
  const payload = {
    scope: "workspace",
    event,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  console.log(JSON.stringify(payload));
}

export function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return { message: String(error) };
}
