import type { RequirementDraft, SolutionDsl, WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import type { ConfirmationPolicyAddon, SkillManifest, SkillMatchReason, SkillStepSpec } from "./skillTypes.js";
import { skillManifestSchema } from "./skillTypes.js";

const skills = new Map<string, SkillManifest>();

/** 注册一个 TypeScript builtin Skill。重复 id 会覆盖。 */
export function registerSkill(skill: SkillManifest): void {
  skills.set(skill.id, { ...skill, source: "builtin" });
}

/** 注册一个 JSON Skill（声明式，Zod 校验）。 */
export function registerJsonSkill(raw: unknown): SkillManifest {
  const parsed = skillManifestSchema.parse(raw);
  const skill: SkillManifest = { ...parsed, source: "json" };
  skills.set(skill.id, skill);
  return skill;
}

/** 列出所有已注册 Skill 的元信息（供 API / 调试页使用）。 */
export function listSkills(): SkillManifest[] {
  return [...skills.values()];
}

/** 按 id 获取单个 Skill。 */
export function getSkill(id: string): SkillManifest | undefined {
  return skills.get(id);
}

type SelectionResult = {
  skill: SkillManifest;
  hitKeywords: string[];
};

/**
 * 基于当前 run 的上下文选择最匹配的 Skill。
 * 同时返回命中原因（hitKeywords）供 UI 展示。
 */
function selectWithReason(run: WorkflowRun): SelectionResult | undefined {
  const requirement = run.steps.find((s) => s.id === "requirement_intake")?.output as RequirementDraft | undefined;
  const solution = run.steps.find((s) => s.id === "solution_design")?.output as SolutionDsl | undefined;

  if (!requirement) return undefined;

  const rawText = (requirement.rawText ?? "").toLowerCase();
  const pattern = requirement.pattern;
  const scope = solution?.scope;

  // 打分制：pattern / scope 是加分项而非硬门槛。
  // 这样 unclear 模式 + fullstack scope 的需求仍然能靠关键词命中 Skill。
  const PATTERN_SCORE = 2;
  const SCOPE_SCORE = 2;

  let best: { skill: SkillManifest; score: number; hitKeywords: string[] } | undefined;

  for (const skill of skills.values()) {
    let score = 0;

    // pattern 匹配加分
    if (skill.requirementPatterns.includes(pattern)) {
      score += PATTERN_SCORE;
    }

    // scope 匹配加分（无 scope 时不扣分，仅在有 scope 且匹配时加分）
    if (scope && skill.scopes.includes(scope)) {
      score += SCOPE_SCORE;
    }

    // 关键词命中计数
    const hitKeywords: string[] = [];
    if (skill.match.keywords) {
      for (const kw of skill.match.keywords) {
        if (rawText.includes(kw.toLowerCase())) {
          hitKeywords.push(kw);
          score += 1;
        }
      }
    }

    // 至少命中一个关键词才进入候选；pattern/scope 仅为加分项（tiebreaker）
    if (hitKeywords.length === 0) continue;

    if (!best || score > best.score) {
      best = { skill, score, hitKeywords };
    }
  }

  return best ? { skill: best.skill, hitKeywords: best.hitKeywords } : undefined;
}

/** 基于当前 run 选择最匹配的 Skill（只返回 manifest，向后兼容）。 */
export function selectSkill(run: WorkflowRun): SkillManifest | undefined {
  return selectWithReason(run)?.skill;
}

/** 构建命中原因摘要，供运行时 trace 和 UI 展示。 */
export function buildMatchReason(run: WorkflowRun): SkillMatchReason | undefined {
  const sel = selectWithReason(run);
  if (!sel) return undefined;

  const requirement = run.steps.find((s) => s.id === "requirement_intake")?.output as RequirementDraft | undefined;
  const solution = run.steps.find((s) => s.id === "solution_design")?.output as SolutionDsl | undefined;

  return {
    skillId: sel.skill.id,
    skillName: sel.skill.name,
    matchedPattern: requirement?.pattern ?? "unknown",
    matchedScope: solution?.scope,
    hitKeywords: sel.hitKeywords,
  };
}

/** getSkillStepSpec 的返回类型 */
export type SkillStepSpecResult = {
  skillId?: string;
  instructionAddon?: string;
  outputContractAddon?: string;
  contextHints?: string[];
  verificationPolicyAddon?: { required?: string[]; optional?: string[] };
  /** 确认策略增强（PR2 只透传，PR3 执行） */
  confirmationPolicyAddon?: ConfirmationPolicyAddon;
  /** 命中原因，前端 SkillBadge tooltip 展示 */
  skillMatchReason?: SkillMatchReason;
};

/**
 * 为给定 run 的指定 step 获取 Skill 注入规格。
 * 如果未命中任何 Skill，返回空对象。
 */
export function getSkillStepSpec(
  run: WorkflowRun,
  stepId: WorkflowStepId,
): SkillStepSpecResult {
  const sel = selectWithReason(run);
  if (!sel) return {};

  const stepSpec: SkillStepSpec | undefined = sel.skill.steps?.[stepId];

  return {
    skillId: sel.skill.id,
    instructionAddon: stepSpec?.instructionAddon,
    outputContractAddon: stepSpec?.outputContractAddon,
    contextHints: stepSpec?.contextHints,
    verificationPolicyAddon: stepSpec?.verificationPolicyAddon,
    confirmationPolicyAddon: stepSpec?.confirmationPolicyAddon,
    skillMatchReason: buildMatchReason(run),
  };
}
