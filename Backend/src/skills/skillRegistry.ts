import type { ClarificationOutput, RequirementDraft, SolutionDsl, WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import type { SkillManifest, SkillStepSpec } from "./skillTypes.js";

const skills = new Map<string, SkillManifest>();

/** 注册一个 Skill。重复 id 会覆盖（最后注册者胜出）。 */
export function registerSkill(skill: SkillManifest): void {
  skills.set(skill.id, skill);
}

/** 列出所有已注册 Skill 的元信息（供 API / 调试页使用）。 */
export function listSkills(): SkillManifest[] {
  return [...skills.values()];
}

/** 按 id 获取单个 Skill。 */
export function getSkill(id: string): SkillManifest | undefined {
  return skills.get(id);
}

/**
 * 基于当前 run 的上下文选择最匹配的 Skill。
 * 匹配策略：
 * 1. pattern 必须匹配（在 Skill 声明的 requirementPatterns 范围内）
 * 2. scope 必须匹配（在 Skill 声明的 scopes 范围内）
 * 3. 如果提供了 keywords，对需求文本进行关键词命中计数
 * 4. 取匹配关键词最多的 Skill；平局时返回第一个注册的
 */
export function selectSkill(run: WorkflowRun): SkillManifest | undefined {
  const requirement = run.steps.find((s) => s.id === "requirement_intake")?.output as RequirementDraft | undefined;
  const solution = run.steps.find((s) => s.id === "solution_design")?.output as SolutionDsl | undefined;

  if (!requirement) return undefined;

  const rawText = (requirement.rawText ?? "").toLowerCase();
  const pattern = requirement.pattern;
  const scope = solution?.scope;

  let best: { skill: SkillManifest; score: number } | undefined;

  for (const skill of skills.values()) {
    // 1. pattern 匹配
    if (!skill.requirementPatterns.includes(pattern)) continue;

    // 2. scope 匹配（如果 solution 已产出）
    if (scope && !skill.scopes.includes(scope)) continue;

    // 3. 关键词命中计数
    let score = 0;
    if (skill.match.keywords) {
      for (const kw of skill.match.keywords) {
        if (rawText.includes(kw.toLowerCase())) {
          score += 1;
        }
      }
    }

    // 无关键词命中时至少给 0.5 分（仅 pattern + scope 匹配）
    if (score === 0 && skill.match.keywords && skill.match.keywords.length > 0) {
      continue; // 声明了关键词但没有命中 → 不匹配
    }

    if (!best || score > best.score) {
      best = { skill, score };
    }
  }

  return best?.skill;
}

/**
 * 为给定 run 的指定 step 获取 Skill 注入规格。
 * 如果未命中任何 Skill，返回空对象。
 */
export function getSkillStepSpec(
  run: WorkflowRun,
  stepId: WorkflowStepId,
): {
  skillId?: string;
  instructionAddon?: string;
  outputContractAddon?: string;
  contextHints?: string[];
  verificationPolicyAddon?: { required?: string[]; optional?: string[] };
} {
  const skill = selectSkill(run);
  if (!skill) return {};

  const stepSpec: SkillStepSpec | undefined = skill.steps[stepId];
  if (!stepSpec) return { skillId: skill.id };

  return {
    skillId: skill.id,
    instructionAddon: stepSpec.instructionAddon,
    outputContractAddon: stepSpec.outputContractAddon,
    contextHints: stepSpec.contextHints,
    verificationPolicyAddon: stepSpec.verificationPolicyAddon,
  };
}
