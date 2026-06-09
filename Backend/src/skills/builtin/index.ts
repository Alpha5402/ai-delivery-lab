import { registerSkill } from "../skillRegistry.js";
import { backendAddPagination } from "./backendAddPagination.skill.js";
import { crossStackAddField } from "./crossStackAddField.skill.js";
import { frontendDisplayComputedMetric } from "./frontendDisplayComputedMetric.skill.js";
import { generalCodeReview } from "./generalCodeReview.skill.js";

/**
 * 启动时调用一次，注册所有内置 Skill。
 * 新增 Skill 只需在此 import 并 registerSkill。
 */
export function registerBuiltinSkills(): void {
  registerSkill(backendAddPagination);
  registerSkill(crossStackAddField);
  registerSkill(frontendDisplayComputedMetric);
  registerSkill(generalCodeReview);
}
