import type { RequirementDraft, SolutionDsl, WorkflowRun } from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import { matchFileGlobs, matchRouteHints } from "./globMatcher.js";
import type { SkillManifest, SkillMatchReason } from "./skillTypes.js";

export type SkillMatchContext = {
  run: WorkflowRun;
  requirement?: RequirementDraft;
  solution?: SolutionDsl;
  requirementText: string;
  /** 项目级文本语料：repoName + stack + notes + directories + keyFile 文件名 + 截断内容 */
  projectTextCorpus: string;
  fileTree: string[];
  directories: string[];
  stack: string[];
  keyFileNames: string[];
};

/**
 * 从 run + workspace 构建 Skill 匹配上下文。
 * workspace 可选：不传时 project 信号为空，关键词匹配行为不变。
 */
export function buildSkillMatchContext(
  run: WorkflowRun,
  workspace?: WorkspaceContext,
): SkillMatchContext {
  const requirement = run.steps.find((s) => s.id === "requirement_intake")?.output as
    | RequirementDraft
    | undefined;
  const solution = run.steps.find((s) => s.id === "solution_design")?.output as
    | SolutionDsl
    | undefined;
  const requirementText = (requirement?.rawText ?? "").toLowerCase();

  const fileTree = workspace?.repositoryScan?.fileTree ?? [];
  const directories = workspace?.repositoryScan?.directories ?? [];
  const stack = workspace?.repositoryScan?.stack ?? [];
  const keyFiles = workspace?.repositoryScan?.keyFiles ?? {};
  const keyFileNames = Object.keys(keyFiles);
  const notes = workspace?.repositoryScan?.notes ?? [];
  const repoName = workspace?.repoName ?? "";

  // 拼接项目文本语料（截断，总量控制在 12k chars 以内）
  const corpusParts: string[] = [repoName, ...stack, ...directories.slice(0, 30), ...notes];
  for (const [name, content] of Object.entries(keyFiles)) {
    corpusParts.push(name);
    if (typeof content === "string") {
      corpusParts.push(content.slice(0, 600));
    }
  }
  const projectTextCorpus = corpusParts.join("\n").toLowerCase().slice(0, 12_000);

  return {
    run,
    requirement,
    solution,
    requirementText,
    projectTextCorpus,
    fileTree,
    directories,
    stack,
    keyFileNames,
  };
}

/**
 * 增强 match reason：记录 fileGlobs / routeHints / files 命中。
 */
export function enrichMatchReason(
  reason: SkillMatchReason,
  skill: SkillManifest,
  ctx: SkillMatchContext,
): SkillMatchReason {
  const hitFileGlobs: string[] = [];
  const hitFiles: string[] = [];
  const globs = skill.match.fileGlobs ?? [];
  if (globs.length > 0) {
    for (const fp of ctx.fileTree) {
      const matched = matchFileGlobs(fp, globs);
      if (matched.length > 0) {
        hitFiles.push(fp);
        for (const m of matched) {
          if (!hitFileGlobs.includes(m)) hitFileGlobs.push(m);
        }
      }
    }
  }

  const hitRouteHints: string[] = [];
  const hints = skill.match.routeHints ?? [];
  if (hints.length > 0) {
    hitRouteHints.push(
      ...matchRouteHints(hints, {
        fileTree: ctx.fileTree,
        keyFileNames: ctx.keyFileNames,
        textCorpus: ctx.projectTextCorpus,
      }),
    );
  }

  return {
    ...reason,
    hitFileGlobs: hitFileGlobs.length > 0 ? hitFileGlobs : undefined,
    hitFiles: hitFiles.length > 0 ? hitFiles.slice(0, 10) : undefined,
    hitRouteHints: hitRouteHints.length > 0 ? hitRouteHints : undefined,
  };
}
