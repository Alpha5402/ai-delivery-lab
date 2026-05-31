import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { registerJsonSkill } from "./skillRegistry.js";

export type JsonSkillLoadResult = {
  loaded: number;
  failed: number;
  errors: Array<{ file: string; message: string }>;
};

/**
 * 从指定目录加载所有 .json Skill 文件并注册。
 * 目录不存在时不报错，返回空结果。
 * 单个文件无效时记录日志，不阻断其他文件的加载。
 */
export function loadJsonSkillsFromDir(dir: string): JsonSkillLoadResult {
  const result: JsonSkillLoadResult = { loaded: 0, failed: 0, errors: [] };

  if (!existsSync(dir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed to read file";
      result.failed += 1;
      result.errors.push({ file: entry, message });
      console.error(JSON.stringify({
        scope: "skills",
        event: "json_skill.read_failed",
        file: entry,
        message,
        timestamp: new Date().toISOString(),
      }));
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid JSON";
      result.failed += 1;
      result.errors.push({ file: entry, message });
      console.error(JSON.stringify({
        scope: "skills",
        event: "json_skill.parse_failed",
        file: entry,
        message,
        timestamp: new Date().toISOString(),
      }));
      continue;
    }

    try {
      registerJsonSkill(parsed);
      result.loaded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "schema validation failed";
      result.failed += 1;
      result.errors.push({ file: entry, message });
      console.error(JSON.stringify({
        scope: "skills",
        event: "json_skill.invalid",
        file: entry,
        message,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  return result;
}

/**
 * 加载并注册 JSON Skill。默认目录为 env.SKILL_CONFIG_DIR 或 ./skills。
 */
export function loadAndRegisterJsonSkills(dir?: string): JsonSkillLoadResult {
  const target = dir ?? env.SKILL_CONFIG_DIR ?? path.resolve(process.cwd(), "skills");
  return loadJsonSkillsFromDir(target);
}
