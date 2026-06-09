import { Router } from "express";
import { generateSkillKeywords, buildKeywordInput } from "../agents/skillKeywordAgent.js";
import { getSkill, listSkills, registerJsonSkill, unregisterSkill } from "../skills/skillRegistry.js";
import { skillManifestSchema } from "../skills/skillTypes.js";
import { deleteJsonSkillFile, writeJsonSkillFile } from "../skills/jsonSkillLoader.js";

export const skillRoutes = Router();

/** 列出所有已注册 Skill 的摘要元信息 */
skillRoutes.get("/", (_req, res) => {
  const skills = listSkills().map((skill) => ({
    id: skill.id,
    name: skill.name,
    version: skill.version,
    source: skill.source ?? "builtin",
    requirementPatterns: skill.requirementPatterns,
    scopes: skill.scopes,
    matchKeywords: skill.match.keywords,
    stepIds: Object.keys(skill.steps ?? {}),
  }));
  res.json(skills);
});

/** 查看单个 Skill 的完整 manifest */
skillRoutes.get("/:id", (req, res) => {
  const skill = getSkill(req.params.id);
  if (!skill) {
    res.status(404).json({ message: `Skill not found: ${req.params.id}` });
    return;
  }
  res.json(skill);
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
    res.status(201).json(skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid skill";
    res.status(400).json({ message });
  }
});

/** 更新 JSON Skill */
skillRoutes.patch("/json/:id", async (req, res) => {
  const existing = getSkill(req.params.id);
  if (!existing) {
    res.status(404).json({ message: `Skill not found: ${req.params.id}` });
    return;
  }
  if (existing.source === "builtin") {
    res.status(409).json({ message: "Builtin skill cannot be modified" });
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
    res.json(skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid skill";
    res.status(400).json({ message });
  }
});

/** 删除 JSON Skill */
skillRoutes.delete("/json/:id", (req, res) => {
  const existing = getSkill(req.params.id);
  if (!existing) {
    res.status(404).json({ message: `Skill not found: ${req.params.id}` });
    return;
  }
  if (existing.source === "builtin") {
    res.status(409).json({ message: "Builtin skill cannot be deleted" });
    return;
  }
  deleteJsonSkillFile(req.params.id);
  unregisterSkill(req.params.id);
  res.status(204).send();
});
