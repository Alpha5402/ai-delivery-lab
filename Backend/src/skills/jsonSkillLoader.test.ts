import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSkill, listSkills, registerSkill } from "./skillRegistry.js";
import { loadJsonSkillsFromDir } from "./jsonSkillLoader.js";

const TMP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "test-skills-tmp",
);

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("jsonSkillLoader", () => {
  it("loads valid .json skill from directory", () => {
    writeFileSync(path.join(TMP_DIR, "valid.skill.json"), JSON.stringify({
      id: "json-test-skill",
      name: "JSON Test Skill",
      version: "1.0.0",
      requirementPatterns: ["frontend-only"],
      scopes: ["frontend"],
      match: { keywords: ["test"] },
      steps: {
        module_mapping: { instructionAddon: "test addon" },
      },
    }));

    const result = loadJsonSkillsFromDir(TMP_DIR);
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(0);

    const skill = getSkill("json-test-skill");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("json");
  });

  it("ignores non-json files", () => {
    writeFileSync(path.join(TMP_DIR, "notes.txt"), "not a skill");
    writeFileSync(path.join(TMP_DIR, "valid.skill.json"), JSON.stringify({
      id: "json-ignore-test",
      name: "Ignore Test",
      version: "1.0.0",
      requirementPatterns: ["frontend-only"],
      scopes: ["frontend"],
      match: { keywords: ["test"] },
    }));

    const result = loadJsonSkillsFromDir(TMP_DIR);
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("handles missing directory without error", () => {
    const result = loadJsonSkillsFromDir("/tmp/does-not-exist-9x8y7z6w");
    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("reports invalid json without throwing", () => {
    writeFileSync(path.join(TMP_DIR, "bad.skill.json"), "{ not valid json }");

    const result = loadJsonSkillsFromDir(TMP_DIR);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].file).toBe("bad.skill.json");
  });

  it("reports schema validation failure without throwing", () => {
    writeFileSync(path.join(TMP_DIR, "bad-schema.skill.json"), JSON.stringify({
      id: "",
      name: "",
      version: "1",
      requirementPatterns: [],
      scopes: [],
      match: {},
    }));

    const result = loadJsonSkillsFromDir(TMP_DIR);
    expect(result.failed).toBe(1);
    expect(result.errors[0].message).toBeTruthy();
  });
});

describe("jsonSkill — registry integration", () => {
  it("JSON skill can be selected by keyword", () => {
    writeFileSync(path.join(TMP_DIR, "kw.skill.json"), JSON.stringify({
      id: "json-kw-test",
      name: "Keyword Test",
      version: "1.0.0",
      requirementPatterns: ["frontend-only"],
      scopes: ["frontend"],
      match: { keywords: ["分页查询测试"] },
    }));

    loadJsonSkillsFromDir(TMP_DIR);

    // Also register a builtin for comparison
    registerSkill({
      id: "builtin-ref",
      name: "Builtin Ref",
      version: "1.0.0",
      requirementPatterns: ["frontend-only"],
      scopes: ["frontend"],
      match: { keywords: ["分页"] },
      source: "builtin",
      steps: {},
    });

    const all = listSkills();
    expect(all.some((s) => s.id === "json-kw-test")).toBe(true);
    expect(all.some((s) => s.source === "json")).toBe(true);
    expect(all.some((s) => s.source === "builtin")).toBe(true);
  });
});
