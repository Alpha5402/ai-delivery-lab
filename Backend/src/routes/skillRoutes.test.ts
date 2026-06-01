import express from "express";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBuiltinSkills } from "../skills/builtin/index.js";
import { resetNonBuiltinSkills } from "../skills/skillRegistry.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.resolve(testDir, "../../test-skills-crud-tmp");

import { skillRoutes } from "./skillRoutes.js";

async function fetchFromApp(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use(express.json());
  app.use("/api/skills", skillRoutes);

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as { port: number };

  try {
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: { "Content-Type": "application/json" },
    };
    if (opts.body != null) init.body = JSON.stringify(opts.body);
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, init);
    const resBody = await res.json().catch(() => null);
    return { status: res.status, body: resBody };
  } finally {
    server.close();
  }
}

describe("skillRoutes CRUD", () => {
  beforeEach(() => {
    process.env.SKILL_CONFIG_DIR = TMP_DIR;
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    resetNonBuiltinSkills();
    registerBuiltinSkills();
  });

  afterEach(() => {
    delete process.env.SKILL_CONFIG_DIR;
    rmSync(TMP_DIR, { recursive: true, force: true });
    resetNonBuiltinSkills();
  });

  const VALID_SKILL = {
    id: "test-crud-skill",
    name: "Test CRUD Skill",
    version: "1.0.0",
    requirementPatterns: ["frontend-only"],
    scopes: ["frontend"],
    match: { keywords: ["crud-test"] },
  };

  it("POST creates a new JSON skill and writes to temp dir", async () => {
    const { status, body } = await fetchFromApp("/api/skills/json", { method: "POST", body: VALID_SKILL });
    expect(status).toBe(201);
    expect((body as { id: string }).id).toBe("test-crud-skill");

    // verify file is written to temp dir
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(TMP_DIR, "test-crud-skill.skill.json"))).toBe(true);

    // verify in list
    const list = await fetchFromApp("/api/skills");
    const items = list.body as Array<{ id: string }>;
    expect(items.some((s) => s.id === "test-crud-skill")).toBe(true);
  });

  it("POST rejects duplicate builtin id", async () => {
    const { status, body } = await fetchFromApp("/api/skills/json", {
      method: "POST",
      body: { ...VALID_SKILL, id: "frontend-display-computed-metric" },
    });
    expect(status).toBe(409);
    expect((body as { message: string }).message).toContain("already exists");
  });

  it("POST rejects invalid manifest", async () => {
    const { status } = await fetchFromApp("/api/skills/json", {
      method: "POST",
      body: { id: "", name: "", version: "1", match: {} },
    });
    expect(status).toBe(400);
  });

  it("POST rejects id with path traversal (../)", async () => {
    const { status } = await fetchFromApp("/api/skills/json", {
      method: "POST",
      body: { ...VALID_SKILL, id: "../evil" },
    });
    expect(status).toBe(400);
  });

  it("POST rejects id with slash (a/b)", async () => {
    const { status } = await fetchFromApp("/api/skills/json", {
      method: "POST",
      body: { ...VALID_SKILL, id: "a/b" },
    });
    expect(status).toBe(400);
  });

  it("PATCH updates existing JSON skill", async () => {
    await fetchFromApp("/api/skills/json", { method: "POST", body: VALID_SKILL });
    const { status, body } = await fetchFromApp("/api/skills/json/test-crud-skill", {
      method: "PATCH",
      body: { name: "Updated", version: "2.0.0", requirementPatterns: ["frontend-only"], scopes: ["frontend"], match: { keywords: ["test", "updated"] } },
    });
    expect(status).toBe(200);
    expect((body as { name: string }).name).toBe("Updated");
  });

  it("PATCH builtin returns 409", async () => {
    const { status } = await fetchFromApp("/api/skills/json/frontend-display-computed-metric", {
      method: "PATCH",
      body: { name: "Hacked", version: "1", requirementPatterns: ["frontend-only"], scopes: ["frontend"], match: { keywords: ["x"] } },
    });
    expect(status).toBe(409);
  });

  it("DELETE removes JSON skill from registry and file", async () => {
    await fetchFromApp("/api/skills/json", { method: "POST", body: VALID_SKILL });
    const { status } = await fetchFromApp("/api/skills/json/test-crud-skill", { method: "DELETE" });
    expect(status).toBe(204);

    // verify removed from list
    const list = await fetchFromApp("/api/skills");
    const items = list.body as Array<{ id: string }>;
    expect(items.some((s) => s.id === "test-crud-skill")).toBe(false);

    // verify file cleaned
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(TMP_DIR, "test-crud-skill.skill.json"))).toBe(false);
  });

  it("DELETE builtin returns 409", async () => {
    const { status } = await fetchFromApp("/api/skills/json/frontend-display-computed-metric", { method: "DELETE" });
    expect(status).toBe(409);
  });
});
