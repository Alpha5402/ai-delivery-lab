import type { ClarificationOutput, RequirementDraft, WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import { stepOrder } from "../domain/workflow.js";
import type { SkillStepSpecResult } from "../skills/skillRegistry.js";

export type StepResolveContext = {
  run: WorkflowRun;
  stepId: WorkflowStepId;
  followUp?: {
    previousOutput: unknown;
    reasons?: string[];
  };
  runOptions?: WorkflowStepRunOptions;
};

export type WorkflowStepRunOptions = {
  pullRequest?: {
    branch?: string;
    commitMessage?: string;
  };
};

export type StepOutputResolver = (ctx: StepResolveContext) => Promise<unknown>;

export type StepResolverDefinition = {
  stepId: WorkflowStepId;
  agentProfileId: string;
  resolve: StepOutputResolver;
};

const resolvers = new Map<WorkflowStepId, StepResolverDefinition>();

export function registerStepResolver(def: StepResolverDefinition): void {
  resolvers.set(def.stepId, def);
}

export function getStepResolver(stepId: WorkflowStepId): StepResolverDefinition | undefined {
  return resolvers.get(stepId);
}

export function listStepResolvers(): StepResolverDefinition[] {
  return [...resolvers.values()];
}

/** 通过注册表解析 step output。返回 null 表示未注册该 step。 */
export async function resolveRegisteredStepOutput(ctx: StepResolveContext): Promise<unknown | null> {
  const resolver = resolvers.get(ctx.stepId);
  if (!resolver) {
    return null; // 未注册时返回 null，调用方走 fallback
  }
  return resolver.resolve(ctx);
}

/**
 * 注册 default 7 步 resolver。
 * 这些函数内部复用原有的 agent 实现，保持行为等价。
 * 必须在 app 启动时调用一次。
 */
export function registerDefaultStepResolvers(
  impl: {
    runClarifierAgent: (...args: any[]) => Promise<any>;
    runPlannerAgent: (...args: any[]) => Promise<any>;
    runWorkflowStepAgent: (stepId: WorkflowStepId, run: WorkflowRun, options?: WorkflowStepRunOptions) => Promise<unknown>;
    getStepOutput: <T>(run: WorkflowRun, stepId: WorkflowStepId) => T;
    buildRuntimeMemoryContext: (run: WorkflowRun, stepId: WorkflowStepId) => unknown;
    resolveSkillStepSpec?: (run: WorkflowRun, stepId: WorkflowStepId) => SkillStepSpecResult;
  },
): void {
  for (const stepId of stepOrder) {
    let resolve: StepOutputResolver;

    switch (stepId) {
      case "requirement_intake":
        resolve = async (ctx) => impl.getStepOutput<RequirementDraft>(ctx.run, "requirement_intake");
        break;

      case "clarification": {
        resolve = async (ctx) => {
          const requirement = impl.getStepOutput<RequirementDraft>(ctx.run, "requirement_intake");
          const clarificationStep = ctx.run.steps.find((s) => s.id === "clarification");
          const runtimeMemory = impl.buildRuntimeMemoryContext(ctx.run, "clarification");

          const userInterventions = (clarificationStep?.interventions ?? [])
            .filter((m) => m.role === "user")
            .map((m) => m.content);

          const previousOutput = (clarificationStep?.output ?? ctx.followUp?.previousOutput) as
            | ClarificationOutput
            | undefined;

          if (ctx.followUp || userInterventions.length > 0 || previousOutput) {
            return impl.runClarifierAgent(requirement, {
              previousOutput: (ctx.followUp?.previousOutput as ClarificationOutput) ?? previousOutput,
              reasons: ctx.followUp?.reasons,
              userInterventions: userInterventions.length > 0 ? userInterventions : undefined,
              runtimeMemory,
            });
          }
          return impl.runClarifierAgent(requirement, { runtimeMemory });
        };
        break;
      }

      case "solution_design": {
        resolve = async (ctx) => {
          const requirement = impl.getStepOutput<RequirementDraft>(ctx.run, "requirement_intake");
          const clarification = impl.getStepOutput<ClarificationOutput>(ctx.run, "clarification");
          const runtimeMemory = impl.buildRuntimeMemoryContext(ctx.run, "solution_design");
          const skillSpec = impl.resolveSkillStepSpec?.(ctx.run, "solution_design");
          return impl.runPlannerAgent(requirement, clarification, { runtimeMemory, skillSpec });
        };
        break;
      }

      default:
        // module_mapping, code_generation, verification, pull_request
        resolve = async (ctx) => impl.runWorkflowStepAgent(ctx.stepId, ctx.run, ctx.runOptions);
        break;
    }

    registerStepResolver({
      stepId,
      agentProfileId: `${stepId}-agent`,
      resolve,
    });
  }
}
