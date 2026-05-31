import { Router } from "express";
import { getSkill, listSkills } from "../skills/skillRegistry.js";

export const skillRoutes = Router();

/** 列出所有已注册 Skill 的摘要元信息（不含完整 instructionAddon 全文） */
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
