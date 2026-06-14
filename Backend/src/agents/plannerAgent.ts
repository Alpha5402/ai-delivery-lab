import type { RuntimeMemoryContext } from "../services/workflowMemory.js";
import {
  type ClarificationOutput,
  type RequirementDraft,
  type SolutionDsl,
  solutionDslSchema,
} from "../domain/workflow.js";
import { callJsonLlmWithSchema, getLlmUsageFromError } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";
import type { SkillStepSpecResult } from "../skills/skillRegistry.js";

export type PlannerContext = {
  runtimeMemory?: RuntimeMemoryContext;
  skillSpec?: SkillStepSpecResult;
};

export async function runPlannerAgent(
  requirement: RequirementDraft,
  clarification: ClarificationOutput,
  context?: PlannerContext,
): Promise<SolutionDsl> {
  const systemLines = [
    "你是 AI Delivery Workspace 的方案生成 AI。",
    "请根据用户需求和确认结果输出 JSON，字段必须为 requirementId, scope, userStory, acceptanceCriteria, dataContract。",
    "scope 只能是 frontend, backend, fullstack。",
    "acceptanceCriteria 使用可验证条目，不要输出 Markdown。",
    "",
    "## 方案边界",
    "你必须把澄清阶段的已确认 decisions 转换成可执行方案，不要重新提出开放问题。",
    "如果仍存在 questions[]，只把会阻塞实现的风险写入验收标准或 dataContract.assumptions，不要擅自扩大范围。",
    "方案必须聚焦本次交付，不要加入用户没有要求的重构、视觉改版、架构迁移或依赖升级。",
    "",
    "## 字段要求",
    "requirementId 使用稳定短 id，可基于需求标题或任务类型生成。",
    "userStory 用一句话描述用户/角色、目标能力和业务价值。",
    "acceptanceCriteria 必须是可验证条目：包含用户可见行为、边界条件、错误/空状态、测试或验证期望。",
    "每条 acceptanceCriteria 应能被后续代码生成和验证阶段直接消费，避免“优化体验”“保证质量”这类空泛表述。",
    "dataContract 必须使用固定字段：affectedSurfaces, inputs, outputs, stateChanges, apiContract, constraints, assumptions, outOfScope, verificationHints。",
    "每个字段都使用 string[]；不适用时输出 []，不要自造字段名。",
    "affectedSurfaces 写用户可见页面/接口/模块；inputs 写输入数据/props/API 参数；outputs 写用户可见输出/响应字段/持久化结果。",
    "constraints 写用户确认过的硬约束；assumptions 只写仍需后续验证但不阻塞的假设；outOfScope 写明确不做的范围。",
    "verificationHints 写后续生成代码和验证阶段必须覆盖的测试/命令/边界条件。",
    "当 scope=fullstack 时，apiContract 必须包含前后端交互契约或字段映射；当 scope=frontend/backend 时，说明本侧输入输出和不触碰的边界。",
    "",
    "## 可执行性要求",
    "acceptanceCriteria 必须能被编号引用；后续 code_generation 会用 1-based 编号映射任务。",
    "不要把实现文件名写死到方案里，除非需求或上下文已经明确指定。",
  ];

  if (context?.runtimeMemory) {
    systemLines.push(
      "你必须优先遵守 runtimeMemory 中用户明确确认/修正的约束。",
      "如果用户反馈与你原计划冲突，以用户反馈为准。",
      "澄清阶段用户确认的决策必须写入 acceptanceCriteria。",
      "不要重新引入已被用户否定的范围或设计。",
    );
  }

  if (context?.skillSpec?.instructionAddon) {
    systemLines.push(
      "",
      "## 项目 Skill 注入",
      context.skillSpec.instructionAddon,
    );
  }
  if (context?.skillSpec?.outputContractAddon) {
    systemLines.push(
      "",
      "## 项目 Skill 输出约束",
      context.skillSpec.outputContractAddon,
    );
  }

  const userPayload: Record<string, unknown> = { requirement, clarification };
  if (context?.runtimeMemory) {
    userPayload.runtimeMemory = context.runtimeMemory.summary;
  }

  const result = await callJsonLlmWithSchema([
    {
      role: "system",
      content: systemLines.join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(userPayload),
    },
  ], solutionDslSchema, { label: "生成方案" }).catch((error) => {
    const usage = getLlmUsageFromError(error);
    if (usage) {
      recordMetric({
        agent: "生成方案",
        calls: 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        estimatedCost: 0,
      });
    }
    throw error;
  });

  recordMetric({
    agent: "生成方案",
    calls: 1,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    estimatedCost: 0,
  });

  return {
    ...result.content,
    runtimeTrace: context?.skillSpec?.skillId ? {
      selectedSkillId: context.skillSpec.skillId,
      skillMatchReason: context.skillSpec.skillMatchReason,
      skillDiagnostics: context.skillSpec.skillDiagnostics,
    } : context?.skillSpec?.skillDiagnostics ? {
      skillDiagnostics: context.skillSpec.skillDiagnostics,
    } : undefined,
    __metrics: [{
      agent: "生成方案",
      calls: 1,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      estimatedCost: 0,
    }],
  } as SolutionDsl;
}
