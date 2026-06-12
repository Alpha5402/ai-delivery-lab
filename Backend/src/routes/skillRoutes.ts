import { Router } from "express";
import { generateSkillKeywords, buildKeywordInput } from "../agents/skillKeywordAgent.js";
import { getSkill, listSkills, registerJsonSkill, unregisterSkill } from "../skills/skillRegistry.js";
import { skillManifestSchema } from "../skills/skillTypes.js";
import { deleteJsonSkillFile, writeJsonSkillFile } from "../skills/jsonSkillLoader.js";
import { isBuiltinSkillId, resetBuiltinSkill } from "../skills/builtin/index.js";
import type { SkillManifest } from "../skills/skillTypes.js";

export const skillRoutes = Router();

function withSkillSourceMeta<T extends SkillManifest>(skill: T) {
  const builtin = isBuiltinSkillId(skill.id);
  return {
    ...skill,
    source: skill.source ?? "builtin",
    builtin,
    overridden: builtin && skill.source === "json",
  };
}

/** 列出所有已注册 Skill 的摘要元信息 */
skillRoutes.get("/", (_req, res) => {
  const skills = listSkills().map((skill) => {
    const meta = withSkillSourceMeta(skill);
    return {
      id: meta.id,
      name: meta.name,
      version: meta.version,
      source: meta.source,
      builtin: meta.builtin,
      overridden: meta.overridden,
      requirementPatterns: meta.requirementPatterns,
      scopes: meta.scopes,
      matchKeywords: meta.match.keywords,
      stepIds: Object.keys(meta.steps ?? {}),
    };
  });
  res.json(skills);
});

/** 查看单个 Skill 的完整 manifest */
skillRoutes.get("/:id", (req, res) => {
  const skill = getSkill(req.params.id);
  if (!skill) {
    res.status(404).json({ message: `Skill not found: ${req.params.id}` });
    return;
  }
  res.json(withSkillSourceMeta(skill));
});

// ---- JSON Skill CRUD ----

/** 新增 JSON Skill */
skillRoutes.post("/json", async (req, res) => {
  try {
    const raw: Record<string, unknown> = req.body as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const existing = getSkill(id);
    if (existing) {
      res.status(409).json({ message: `Skill already exists: ${id} (source: ${existing.source})` });
      return;
    }
    // 先 validate，再写文件，最后注册内存
    skillManifestSchema.parse(raw);
    // 自动生成 keywords（如果没有提供或请求重新生成）
    const match = raw.match as Record<string, unknown> | undefined;
    const needKeywords = !match?.keywords || (match?.keywords as unknown[]).length === 0 || raw._regenerateKeywords === true;
    if (needKeywords) {
      const parsed = skillManifestSchema.parse(raw);
      const input = buildKeywordInput(parsed as Parameters<typeof buildKeywordInput>[0]);
      const { keywords } = await generateSkillKeywords(input);
      raw.match = { ...(match ?? {}), keywords };
    }
    delete raw._regenerateKeywords;
    writeJsonSkillFile(id, raw);
    const skill = registerJsonSkill(raw);
    res.status(201).json(withSkillSourceMeta(skill));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid skill";
    res.status(400).json({ message });
  }
});

/** 更新 JSON Skill；内置 Skill 会写入同 id 的 JSON 覆盖层。 */
skillRoutes.patch("/json/:id", async (req, res) => {
  const existing = getSkill(req.params.id);
  if (!existing) {
    res.status(404).json({ message: `Skill not found: ${req.params.id}` });
    return;
  }
  try {
    const raw: Record<string, unknown> = { ...(req.body as Record<string, unknown>), id: req.params.id };
    skillManifestSchema.parse(raw);
    const match = raw.match as Record<string, unknown> | undefined;
    const needKeywords = !match?.keywords || (match?.keywords as unknown[]).length === 0 || raw._regenerateKeywords === true;
    if (needKeywords) {
      const parsed = skillManifestSchema.parse(raw);
      const input = buildKeywordInput(parsed as Parameters<typeof buildKeywordInput>[0]);
      const { keywords } = await generateSkillKeywords(input);
      raw.match = { ...(match ?? {}), keywords };
    }
    delete raw._regenerateKeywords;
    writeJsonSkillFile(req.params.id, raw);
    const skill = registerJsonSkill(raw);
    res.json(withSkillSourceMeta(skill));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid skill";
    res.status(400).json({ message });
  }
});

/** 重置内置 Skill：删除 JSON 覆盖层，并恢复内置 manifest。 */
skillRoutes.post("/:id/reset", (req, res) => {
  const id = req.params.id;
  if (!isBuiltinSkillId(id)) {
    res.status(409).json({ message: `Only builtin skill can be reset: ${id}` });
    return;
  }
  deleteJsonSkillFile(id);
  const restored = resetBuiltinSkill(id);
  if (!restored) {
    res.status(404).json({ message: `Skill not found: ${id}` });
    return;
  }
  res.json(withSkillSourceMeta(restored));
});

/** 删除 JSON Skill；如果目标是内置覆盖层，则恢复内置版本。 */
skillRoutes.delete("/json/:id", (req, res) => {
  const existing = getSkill(req.params.id);
  if (!existing) {
    res.status(404).json({ message: `Skill not found: ${req.params.id}` });
    return;
  }
  if (isBuiltinSkillId(req.params.id)) {
    deleteJsonSkillFile(req.params.id);
    resetBuiltinSkill(req.params.id);
    res.status(204).send();
    return;
  }
  deleteJsonSkillFile(req.params.id);
  unregisterSkill(req.params.id);
  res.status(204).send();
});
