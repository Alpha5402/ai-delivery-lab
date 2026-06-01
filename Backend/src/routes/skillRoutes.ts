import { Router } from "express";
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
skillRoutes.post("/json", (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const id = String(body.id ?? "");
    const existing = getSkill(id);
    if (existing) {
      res.status(409).json({ message: `Skill already exists: ${id} (source: ${existing.source})` });
      return;
    }
    // 先 validate，再写文件，最后注册内存（避免文件失败时内存已改）
    skillManifestSchema.parse(body);
    writeJsonSkillFile(id, body);
    const skill = registerJsonSkill(body);
    res.status(201).json(skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid skill";
    res.status(400).json({ message });
  }
});

/** 更新 JSON Skill */
skillRoutes.patch("/json/:id", (req, res) => {
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
    const body = { ...(req.body as Record<string, unknown>), id: req.params.id };
    skillManifestSchema.parse(body);
    writeJsonSkillFile(req.params.id, body);
    const skill = registerJsonSkill(body);
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
