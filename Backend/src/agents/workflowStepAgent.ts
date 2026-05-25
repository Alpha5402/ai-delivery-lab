import type { z } from "zod";
import { runSimpleAgentRuntime } from "../agentRuntime/simpleAgentRuntime.js";
import {
  codeGenerationPlanSchema,
  moduleMappingSchema,
  pullRequestResultSchema,
  repoWriteResultSchema,
  stepAgents,
  type WorkflowRun,
  type WorkflowStepId,
  verificationResultSchema,
} from "../domain/workflow.js";
import { recordMetric } from "../services/metricsService.js";

const agentSpecs: Record<Exclude<WorkflowStepId, "requirement_intake" | "clarification" | "solution_design">, {
  schema: z.ZodTypeAny;
  instruction: string;
  outputContract: string;
}> = {
  module_mapping: {
    schema: moduleMappingSchema,
    instruction: "定位需求会影响的真实模块。必须先依据 runtime 中的文件列表和 Agent Guide 判断模块边界，不要只凭技术栈猜测。",
    outputContract: "输出 JSON：touchedModules 为模块数组，每项含 name, reason, files；reusableSkill 为可复用 Skill 名称。",
  },
  code_generation: {
    schema: codeGenerationPlanSchema,
    instruction: "制定小步代码生成计划。每个任务都要指向真实或可合理新增的文件，并说明是否需要测试。只输出计划，不声称已经写入仓库。",
    outputContract: "输出 JSON：strategy 为代码生成策略；tasks 为任务数组，每项含 id, title, files, testRequired。",
  },
  repo_write: {
    schema: repoWriteResultSchema,
    instruction: "生成可审计的仓库写入计划。当前 runtime 第一版不会自动写文件，所以必须把 filesChanged 表述为计划写入或建议修改，不要声称已经落盘。",
    outputContract: "输出 JSON：branch 与 filesChanged。filesChanged 表示计划写入的文件清单和预估增删行，不要生成 PR 链接。",
  },
  verification: {
    schema: verificationResultSchema,
    instruction: "基于 runtime 检测到的测试入口和工具观测生成验证结论。若 runtime 没有真实执行测试命令，应把 lint/unitTests 标为 failed，并说明需要运行的验证项。",
    outputContract: "输出 JSON：lint, unitTests, coverage, testSuites。不要声称未执行的测试已经通过。",
  },
  pull_request: {
    schema: pullRequestResultSchema,
    instruction: "生成 PR 草稿信息和提交前 checklist。若 runtime 没有真实创建 PR，必须使用 pending://pull-request。",
    outputContract: "输出 JSON：title, url, status, checklist。若没有真实 PR URL，url 使用 pending://pull-request 并把 status 设为 draft。",
  },
};

export async function runWorkflowStepAgent(stepId: WorkflowStepId, run: WorkflowRun) {
  if (stepId === "requirement_intake" || stepId === "clarification" || stepId === "solution_design") {
    throw new Error(`Unsupported generic workflow step: ${stepId}`);
  }

  const spec = agentSpecs[stepId];
  const result = await runSimpleAgentRuntime(stepId, run, spec.schema, {
    instruction: spec.instruction,
    outputContract: spec.outputContract,
  });

  recordMetric({
    agent: stepAgents[stepId],
    calls: 1,
    inputTokens: result.tokens.inputTokens,
    outputTokens: result.tokens.outputTokens,
    latencyMs: result.tokens.latencyMs,
    estimatedCost: 0,
  });

  return {
    ...(result.output as Record<string, unknown>),
    runtimeTrace: result.trace,
  };
}
