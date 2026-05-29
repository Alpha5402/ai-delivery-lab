/**
 * Step Router
 *
 * 基于 RequirementDraft.pattern 与 SolutionDsl.scope 决定动态行为:
 *  - module_mapping 是否需要追加前端/后端关注;
 *  - verification 哪些命令必须执行 / 可以跳过;
 *  - 是否需要触发追问澄清。
 *
 * 设计原则: 主干 8 步流程仍然确定性,这里只调整每步内部的"措辞 + 命令选择",
 *   不引入跳步等不可控行为。
 */

import type {
  ClarificationOutput,
  RequirementDraft,
  SolutionDsl,
  WorkflowRun,
} from "../domain/workflow.js";

export type ScopeHint = "frontend" | "backend" | "fullstack" | "unknown";

export type RouterContext = {
  pattern: RequirementDraft["pattern"] | "unknown";
  scope: ScopeHint;
  /** 上游确认过的 confidence,可用于决定澄清是否需要追问 */
  clarificationConfidence: number | null;
};

export function deriveRouterContext(run: WorkflowRun): RouterContext {
  const requirement = run.steps.find((s) => s.id === "requirement_intake")?.output as RequirementDraft | undefined;
  const solution = run.steps.find((s) => s.id === "solution_design")?.output as SolutionDsl | undefined;
  const clarification = run.steps.find((s) => s.id === "clarification")?.output as ClarificationOutput | undefined;

  return {
    pattern: requirement?.pattern ?? "unknown",
    scope: deriveScope(requirement?.pattern, solution?.scope),
    clarificationConfidence: clarification?.confidence ?? null,
  };
}

function deriveScope(
  pattern: RequirementDraft["pattern"] | undefined,
  scopeFromDsl: SolutionDsl["scope"] | undefined,
): ScopeHint {
  if (scopeFromDsl) return scopeFromDsl;
  if (pattern === "frontend-only") return "frontend";
  if (pattern === "cross-stack") return "fullstack";
  return "unknown";
}

/**
 * 给 module_mapping 的 LLM instruction 追加 scope 提示。
 */
export function moduleMappingInstructionAddon(ctx: RouterContext): string {
  if (ctx.scope === "frontend") {
    return "  · 当前需求 scope=frontend,只关注前端组件/路由/样式/前端测试,不要列出后端 routes/models/migrations。";
  }
  if (ctx.scope === "backend") {
    return "  · 当前需求 scope=backend,只关注后端 routes/services/migrations/单测,不要列出前端组件。";
  }
  if (ctx.scope === "fullstack") {
    return "  · 当前需求 scope=fullstack,前后端都要列出 touchedModules,且 API 契约要在双方都能找到对应文件。";
  }
  return "  · 当前需求 scope 未确定,优先列出主入口模块。";
}

/**
 * 给 verification 决定哪些命令是必选/可选。
 *  - frontend scope: typecheck + lint + test 必选,build 可选;
 *  - backend scope: typecheck + test 必选;
 *  - fullstack: 全部必选;
 *  - unknown: 兜底全部跑。
 *
 * 可选传入 skill 的 verificationPolicyAddon 以合并到最终策略。
 */
export function verificationCommandPolicy(
  ctx: RouterContext,
  skillAddon?: { required?: string[]; optional?: string[] },
) {
  const base = (() => {
    switch (ctx.scope) {
      case "frontend":
        return {
          required: ["npm:typecheck", "npm:lint", "npm:test"],
          optional: ["npm:build", "tsc:noemit"],
        };
      case "backend":
        return {
          required: ["npm:typecheck", "npm:test"],
          optional: ["npm:lint", "npm:build", "tsc:noemit"],
        };
      case "fullstack":
        return {
          required: ["npm:typecheck", "npm:lint", "npm:test", "npm:build"],
          optional: ["tsc:noemit"],
        };
      default:
        return {
          required: ["npm:typecheck", "npm:lint", "npm:test"],
          optional: ["npm:build", "tsc:noemit"],
        };
    }
  })();

  if (skillAddon) {
    // 合并：skill 的 required 追加到 base.required（去重），optional 同理
    const required = [...new Set([...base.required, ...(skillAddon.required ?? [])])];
    const optional = [...new Set([...base.optional, ...(skillAddon.optional ?? [])])]
      .filter((cmd) => !required.includes(cmd)); // optional 中不在 required 里的才保留
    return { required, optional };
  }

  return base;
}

/**
 * 决定 clarification 是否需要追问一轮:
 *  - confidence < 0.6 → 必须追问;
 *  - 否则 → 不追问。
 */
export function shouldFollowUpClarification(ctx: RouterContext): boolean {
  if (ctx.clarificationConfidence === null) return false;
  return ctx.clarificationConfidence < 0.6;
}
