import { registerSkill } from "../skillRegistry.js";
import { backendAddPagination } from "./backendAddPagination.skill.js";
import { crossStackAddField } from "./crossStackAddField.skill.js";
import { frontendDisplayComputedMetric } from "./frontendDisplayComputedMetric.skill.js";
import { generalCodeReview } from "./generalCodeReview.skill.js";
import type { SkillManifest } from "../skillTypes.js";

const builtinSkills: SkillManifest[] = [
  backendAddPagination,
  crossStackAddField,
  frontendDisplayComputedMetric,
  generalCodeReview,
];

/**
 * 启动时调用一次，注册所有内置 Skill。
 * 新增 Skill 只需在此 import 并 registerSkill。
 */
export function registerBuiltinSkills(): void {
  for (const skill of builtinSkills) {
    registerSkill(skill);
  }
}

export function getBuiltinSkill(id: string): SkillManifest | undefined {
  return builtinSkills.find((skill) => skill.id === id);
}

export function isBuiltinSkillId(id: string): boolean {
  return Boolean(getBuiltinSkill(id));
}

export function resetBuiltinSkill(id: string): SkillManifest | undefined {
  const skill = getBuiltinSkill(id);
  if (!skill) return undefined;
  registerSkill(skill);
  return skill;
}
