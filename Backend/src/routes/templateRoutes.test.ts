import express from "express";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { templateRoutes } from "./templateRoutes.js";
import { registerBuiltinTemplates } from "../workflowTemplates/templateRegistry.js";

/** Helper: start a real Express server on a random port, make a GET request, then stop. */
async function fetchFromApp(path: string): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use("/api/templates", templateRoutes);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

describe("templateRoutes (HTTP layer)", () => {
  registerBuiltinTemplates();

  it("GET /api/templates returns list with default template", async () => {
    const { status, body } = await fetchFromApp("/api/templates");
    expect(status).toBe(200);
    const list = body as Array<{ id: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((t) => t.id === "default-software-delivery")).toBe(true);
  });

  it("GET /api/templates/default returns full template with 8 steps", async () => {
    const { status, body } = await fetchFromApp("/api/templates/default");
    expect(status).toBe(200);
    const t = body as { id: string; steps: Array<{ id: string }> };
    expect(t.id).toBe("default-software-delivery");
    expect(t.steps).toHaveLength(8);
    expect(t.steps[0].id).toBe("requirement_intake");
  });

  it("GET /api/templates/nonexistent returns 404", async () => {
    const { status } = await fetchFromApp("/api/templates/nonexistent");
    expect(status).toBe(404);
  });

  it("GET /api/templates/default steps have required metadata", async () => {
    const { body } = await fetchFromApp("/api/templates/default");
    const t = body as { steps: Array<{ id: string; label: string; agent: string; defaultExecutionMode: string }> };
    for (const step of t.steps) {
      expect(step.id).toBeTruthy();
      expect(step.label).toBeTruthy();
      expect(step.agent).toBeTruthy();
      expect(["automatic", "manual-confirmation"]).toContain(step.defaultExecutionMode);
    }
  });
});
