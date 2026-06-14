import type { RequirementDraft, WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import type { ConfirmationPolicyAddon, SkillManifest, SkillMatchReason, SkillStepSpec } from "./skillTypes.js";
import { skillManifestSchema } from "./skillTypes.js";
import { matchFileGlobs, matchRouteHints } from "./globMatcher.js";
import { buildSkillMatchContext, enrichMatchReason } from "./skillMatchContext.js";
import { getExcludedPublicSkillIds, getProjectSkillSettings } from "../services/projectSettingsService.js";

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

/** 测试辅助：清空所有非 builtin Skill（仅用于测试隔离） */
export function resetNonBuiltinSkills(): void {
  for (const [id, skill] of skills.entries()) {
    if (skill.source !== "builtin") skills.delete(id);
  }
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
  priority: number;
  hitKeywords: string[];
  hitFileGlobs: string[];
  hitFiles: string[];
  hitRouteHints: string[];
};

export type SkillSelectionDiagnostics = {
  stepId?: WorkflowStepId;
  projectId?: string;
  requirementPattern?: string;
  inferredScope?: string;
  projectSkillCount: number;
  publicSkillCount: number;
  excludedPublicSkillIds: string[];
  selectedSkillId?: string;
  selectedSkillSource?: SkillManifest["source"];
  selectedSkillHasStep?: boolean;
  selectedSkillMissingStepId?: string;
  candidates: Array<{
    id: string;
    name: string;
    source?: SkillManifest["source"];
    score: number;
    eligible: boolean;
    hasStep: boolean;
    patternMatched: boolean;
    scopeMatched: boolean;
    hitKeywords: string[];
    hitRouteHints: string[];
    hitFileGlobs: string[];
    rejectionReasons: string[];
  }>;
};

function mergeProjectSkills(projectId: string | undefined): SkillManifest[] {
  return getProjectSkillSettings(projectId).flatMap((setting) => {
    const base = setting.baseSkillId ? skills.get(setting.baseSkillId) : undefined;
    if (!base) {
      if (!setting.name || !setting.version || !setting.requirementPatterns?.length || !setting.scopes?.length || !setting.match || !setting.steps) {
        return [];
      }
      return [{
        id: setting.id,
        source: "project" as const,
        name: setting.name,
        description: setting.description,
        version: setting.version,
        requirementPatterns: setting.requirementPatterns,
        scopes: setting.scopes,
        match: setting.match,
        steps: setting.steps as SkillManifest["steps"],
      }];
    }
    return [{
      ...base,
      id: setting.id,
      baseSkillId: setting.baseSkillId,
      source: "project" as const,
      name: setting.name ?? base.name,
      description: setting.description ?? base.description,
      version: setting.version ?? base.version,
      requirementPatterns: setting.requirementPatterns ?? base.requirementPatterns,
      scopes: setting.scopes ?? base.scopes,
      match: {
        ...base.match,
        ...(setting.match ?? {}),
      },
      steps: {
        ...(base.steps ?? {}),
        ...(setting.steps ?? {}),
      } as SkillManifest["steps"],
    }];
  });
}

/**
 * 基于 run context + workspace 选择最匹配的 Skill。
 * workspace 可选：不传时 project 信号为空，回退到纯关键词匹配。
 */
function selectWithReason(run: WorkflowRun, workspace?: WorkspaceContext): SelectionResult | undefined {
  const ctx = buildSkillMatchContext(run, workspace);

  if (!ctx.requirement) return undefined;

  const pattern = ctx.requirement.pattern;
  const scope = ctx.solution?.scope ?? inferScopeFromPattern(pattern);

  const PATTERN_SCORE = 2;
  const SCOPE_SCORE = 2;
  const FILEGLOB_SCORE = 2;
  const ROUTEHINT_SCORE = 2;
  const MAX_FILEGLOB_BONUS = 6;
  const MAX_ROUTE_BONUS = 4;

  let best: SelectionResult | undefined;

  const excludedPublicSkillIds = getExcludedPublicSkillIds(run.projectId);
  const candidates = [
    ...mergeProjectSkills(run.projectId).map((skill) => ({ skill, priority: 1 })),
    ...[...skills.values()]
      .filter((skill) => !excludedPublicSkillIds.has(skill.id))
      .map((skill) => ({ skill, priority: 0 })),
  ];

  for (const { skill, priority } of candidates) {
    const isProjectSkill = skill.source === "project";
    const patternMatched = skill.requirementPatterns.includes(pattern);
    if (!patternMatched && !isProjectSkill) {
      continue;
    }
    const scopeMatched = Boolean(scope && skill.scopes.includes(scope));
    if (scope && !scopeMatched && !isProjectSkill) {
      continue;
    }

    let score = 0;

    if (patternMatched) score += PATTERN_SCORE;
    if (scopeMatched) score += SCOPE_SCORE;

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
    const hasProjectExplicitSignal = isProjectSkill && (hasKeyword || hasRouteHint);
    if (!hasKeyword && !hasRouteHint && !hasStrongFileGlob) {
      continue;
    }
    if (!patternMatched && !hasProjectExplicitSignal) {
      continue;
    }

    if (!best || score > best.score || (score === best.score && priority > best.priority)) {
      best = { skill, score, priority, hitKeywords, hitFileGlobs, hitFiles, hitRouteHints };
    }
  }

  return best;
}

function inferScopeFromPattern(pattern: RequirementDraft["pattern"]) {
  if (pattern === "frontend-only") return "frontend";
  if (pattern === "cross-stack") return "fullstack";
  return undefined;
}

export function explainSkillSelection(
  run: WorkflowRun,
  stepId?: WorkflowStepId,
  workspace?: WorkspaceContext,
): SkillSelectionDiagnostics {
  const ctx = buildSkillMatchContext(run, workspace);
  const pattern = ctx.requirement?.pattern;
  const scope = ctx.solution?.scope ?? (pattern ? inferScopeFromPattern(pattern) : undefined);
  const projectSkills = mergeProjectSkills(run.projectId);
  const excludedPublicSkillIds = getExcludedPublicSkillIds(run.projectId);
  const publicSkills = [...skills.values()].filter((skill) => !excludedPublicSkillIds.has(skill.id));

  const candidates = [...projectSkills, ...publicSkills].map((skill) => {
    const isProjectSkill = skill.source === "project";
    const patternMatched = pattern ? skill.requirementPatterns.includes(pattern) : false;
    const scopeMatched = Boolean(scope && skill.scopes.includes(scope));
    const hitKeywords = (skill.match.keywords ?? []).filter((kw) => ctx.requirementText.includes(kw.toLowerCase()));
    const hitRouteHints = matchRouteHints(skill.match.routeHints ?? [], {
      fileTree: ctx.fileTree,
      keyFileNames: ctx.keyFileNames,
      textCorpus: ctx.projectTextCorpus,
    });
    const hitFileGlobs: string[] = [];
    for (const fp of ctx.fileTree) {
      for (const matched of matchFileGlobs(fp, skill.match.fileGlobs ?? [])) {
        if (!hitFileGlobs.includes(matched)) hitFileGlobs.push(matched);
      }
    }
    const hasKeyword = hitKeywords.length > 0;
    const hasRouteHint = hitRouteHints.length > 0;
    const hasStrongFileGlob = hitFileGlobs.length >= 2;
    const hasProjectExplicitSignal = isProjectSkill && (hasKeyword || hasRouteHint);
    const rejectionReasons: string[] = [];
    if (!patternMatched && !isProjectSkill) rejectionReasons.push(`pattern mismatch: ${pattern ?? "unknown"}`);
    if (scope && !scopeMatched && !isProjectSkill) rejectionReasons.push(`scope mismatch: ${scope}`);
    if (!hasKeyword && !hasRouteHint && !hasStrongFileGlob) rejectionReasons.push("no keyword/routeHint/strong fileGlob hit");
    if (!patternMatched && !hasProjectExplicitSignal) rejectionReasons.push("pattern mismatch without project explicit signal");
    const hasStep = Boolean(stepId && skill.steps?.[stepId]);
    if (stepId && !hasStep) rejectionReasons.push(`missing step config: ${stepId}`);
    const score = (patternMatched ? 2 : 0) +
      (scopeMatched ? 2 : 0) +
      hitKeywords.length +
      Math.min(hitFileGlobs.length * 2, 6) +
      Math.min(hitRouteHints.length * 2, 4);
    const eligible = rejectionReasons.filter((reason) => !reason.startsWith("missing step config")).length === 0;
    return {
      id: skill.id,
      name: skill.name,
      source: skill.source,
      score,
      eligible,
      hasStep,
      patternMatched,
      scopeMatched,
      hitKeywords,
      hitRouteHints,
      hitFileGlobs,
      rejectionReasons,
    };
  }).sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.score - left.score);

  const selected = selectWithReason(run, workspace);
  const selectedSkillHasStep = Boolean(selected?.skill && stepId && selected.skill.steps?.[stepId]);
  return {
    stepId,
    projectId: run.projectId,
    requirementPattern: pattern,
    inferredScope: scope,
    projectSkillCount: projectSkills.length,
    publicSkillCount: publicSkills.length,
    excludedPublicSkillIds: [...excludedPublicSkillIds],
    selectedSkillId: selected?.skill.id,
    selectedSkillSource: selected?.skill.source,
    selectedSkillHasStep: selected ? selectedSkillHasStep : undefined,
    selectedSkillMissingStepId: selected && stepId && !selectedSkillHasStep ? stepId : undefined,
    candidates: candidates.slice(0, 8),
  };
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
  skillDiagnostics?: SkillSelectionDiagnostics;
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
  const skillDiagnostics = explainSkillSelection(run, stepId, workspace);
  const sel = selectWithReason(run, workspace);
  if (!sel) return { skillDiagnostics };

  const stepSpec: SkillStepSpec | undefined = sel.skill.steps?.[stepId];
  if (!stepSpec) return { skillDiagnostics };

  return {
    skillId: sel.skill.id,
    instructionAddon: stepSpec?.instructionAddon,
    outputContractAddon: stepSpec?.outputContractAddon,
    contextHints: stepSpec?.contextHints,
    verificationPolicyAddon: stepSpec?.verificationPolicyAddon,
    confirmationPolicyAddon: stepSpec?.confirmationPolicyAddon,
    skillMatchReason: buildMatchReason(run, workspace),
    skillDiagnostics,
  };
}
