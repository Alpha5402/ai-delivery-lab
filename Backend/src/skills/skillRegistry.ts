import type { WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import type { ConfirmationPolicyAddon, SkillManifest, SkillMatchReason, SkillStepSpec } from "./skillTypes.js";
import { skillManifestSchema } from "./skillTypes.js";
import { matchFileGlobs, matchRouteHints } from "./globMatcher.js";
import { buildSkillMatchContext, enrichMatchReason } from "./skillMatchContext.js";

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

/** 注销一个 Skill。返回 false 如果不存在或是 builtin。 */
export function unregisterSkill(id: string): boolean {
  const skill = skills.get(id);
  if (!skill || skill.source === "builtin") return false;
  skills.delete(id);
  return true;
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
  score: number;
  hitKeywords: string[];
  hitFileGlobs: string[];
  hitFiles: string[];
  hitRouteHints: string[];
};

/**
 * 基于 run context + workspace 选择最匹配的 Skill。
 * workspace 可选：不传时 project 信号为空，回退到纯关键词匹配。
 */
function selectWithReason(run: WorkflowRun, workspace?: WorkspaceContext): SelectionResult | undefined {
  const ctx = buildSkillMatchContext(run, workspace);

  if (!ctx.requirement) return undefined;

  const pattern = ctx.requirement.pattern;
  const scope = ctx.solution?.scope;

  const PATTERN_SCORE = 2;
  const SCOPE_SCORE = 2;
  const FILEGLOB_SCORE = 2;
  const ROUTEHINT_SCORE = 2;
  const MAX_FILEGLOB_BONUS = 6;
  const MAX_ROUTE_BONUS = 4;

  let best: SelectionResult | undefined;

  for (const skill of skills.values()) {
    let score = 0;

    if (skill.requirementPatterns.includes(pattern)) score += PATTERN_SCORE;
    if (scope && skill.scopes.includes(scope)) score += SCOPE_SCORE;

    // keywords
    const hitKeywords: string[] = [];
    if (skill.match.keywords) {
      for (const kw of skill.match.keywords) {
        if (ctx.requirementText.includes(kw.toLowerCase())) {
          hitKeywords.push(kw);
          score += 1;
        }
      }
    }

    // fileGlobs
    const hitFileGlobs: string[] = [];
    const hitFiles: string[] = [];
    const globs = skill.match.fileGlobs ?? [];
    if (globs.length > 0 && ctx.fileTree.length > 0) {
      for (const fp of ctx.fileTree) {
        const matched = matchFileGlobs(fp, globs);
        if (matched.length > 0) {
          hitFiles.push(fp);
          for (const m of matched) {
            if (!hitFileGlobs.includes(m)) hitFileGlobs.push(m);
          }
        }
      }
      score += Math.min(hitFileGlobs.length * FILEGLOB_SCORE, MAX_FILEGLOB_BONUS);
    }

    // routeHints
    const hitRouteHints: string[] = [];
    const hints = skill.match.routeHints ?? [];
    if (hints.length > 0) {
      hitRouteHints.push(...matchRouteHints(hints, {
        fileTree: ctx.fileTree,
        keyFileNames: ctx.keyFileNames,
        textCorpus: ctx.projectTextCorpus,
      }));
      score += Math.min(hitRouteHints.length * ROUTEHINT_SCORE, MAX_ROUTE_BONUS);
    }

    // 最低入选：至少命中一个关键词，或至少命中一个 routeHint，
    // 或 fileGlob 需要 ≥2 个命中（防止单一 broad glob 误匹配）
    const hasKeyword = hitKeywords.length > 0;
    const hasRouteHint = hitRouteHints.length > 0;
    const hasStrongFileGlob = hitFileGlobs.length >= 2;
    if (!hasKeyword && !hasRouteHint && !hasStrongFileGlob) {
      continue;
    }

    if (!best || score > best.score) {
      best = { skill, score, hitKeywords, hitFileGlobs, hitFiles, hitRouteHints };
    }
  }

  return best;
}

/**
 * 基于当前 run 选择最匹配的 Skill（只返回 manifest，向后兼容）。
 * workspace 可选，不传时 project 信号为空。
 */
export function selectSkill(run: WorkflowRun, workspace?: WorkspaceContext): SkillManifest | undefined {
  return selectWithReason(run, workspace)?.skill;
}

/**
 * 构建命中原因摘要，供 runtime trace 和 UI 展示。
 * workspace 可选，不传时 project 信号为空。
 */
export function buildMatchReason(run: WorkflowRun, workspace?: WorkspaceContext): SkillMatchReason | undefined {
  const sel = selectWithReason(run, workspace);
  if (!sel) return undefined;

  const ctx = buildSkillMatchContext(run, workspace);

  return enrichMatchReason({
    skillId: sel.skill.id,
    skillName: sel.skill.name,
    matchedPattern: ctx.requirement?.pattern ?? "unknown",
    matchedScope: ctx.solution?.scope,
    hitKeywords: sel.hitKeywords,
    score: sel.score,
  }, sel.skill, ctx);
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
  workspace?: WorkspaceContext,
): SkillStepSpecResult {
  const sel = selectWithReason(run, workspace);
  if (!sel) return {};

  const stepSpec: SkillStepSpec | undefined = sel.skill.steps?.[stepId];

  return {
    skillId: sel.skill.id,
    instructionAddon: stepSpec?.instructionAddon,
    outputContractAddon: stepSpec?.outputContractAddon,
    contextHints: stepSpec?.contextHints,
    verificationPolicyAddon: stepSpec?.verificationPolicyAddon,
    confirmationPolicyAddon: stepSpec?.confirmationPolicyAddon,
    skillMatchReason: buildMatchReason(run, workspace),
  };
}
