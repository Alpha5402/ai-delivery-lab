import type { z } from "zod";
import { callJsonLlmWithSchema, getLlmUsageFromError } from "../services/llmClient.js";
import { getCurrentWorkspace } from "../services/workspaceService.js";
import type { WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import { stepAgents } from "../domain/workflow.js";
import { buildRuntimeMemoryContext } from "../services/workflowMemory.js";
import { recordMetric } from "../services/metricsService.js";
import { runRuntimeTool } from "./toolRegistry.js";
import type { AgentRuntimeTrace, RuntimeToolCall } from "./types.js";

type RuntimePrompt = {
  instruction: string;
  outputContract: string;
  extraContext?: Record<string, unknown>;
  extraReadFiles?: string[];
};

type RuntimeResult<T> = {
  output: T;
  trace: AgentRuntimeTrace;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
};

function isCodeReviewRetryIntervention(content: string) {
  return content.includes("entry=code_review_retry") ||
    content.includes("来自代码审查的重试要求") ||
    content.includes("code_generation_should_use_code_review_context=true");
}

function buildAgentVisibleWorkflow(
  run: WorkflowRun,
  stepId: WorkflowStepId,
  options?: { includeCodeReviewRetryContext?: boolean },
): WorkflowRun {
  const stepIndex = run.steps.findIndex((step) => step.id === stepId);
  const visibleSteps = stepIndex >= 0 ? run.steps.slice(0, stepIndex + 1) : run.steps;

  return {
    ...run,
    steps: visibleSteps.map((step) => ({
      ...step,
      history: [],
      logs: step.logs.slice(-8),
      interventions: step.id === "code_generation" && !options?.includeCodeReviewRetryContext
        ? step.interventions?.filter((message) => !isCodeReviewRetryIntervention(message.content))
        : step.interventions,
    })),
  };
}

export async function runSimpleAgentRuntime<T>(
  stepId: Exclude<WorkflowStepId, "requirement_intake" | "clarification" | "solution_design">,
  run: WorkflowRun,
  schema: z.ZodType<T>,
  prompt: RuntimePrompt,
): Promise<RuntimeResult<T>> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error("No workspace is available. Import a repository or create a quick project first.");
  }

  const toolCalls: RuntimeToolCall[] = [];
  toolCalls.push(await runRuntimeTool(workspace, "read_agent_guide"));
  toolCalls.push(await runRuntimeTool(workspace, "list_files", { limit: 80 }));
  const readFiles = mergeReadFiles(
    selectInitialReadFiles(Object.keys(workspace.repositoryScan.keyFiles)),
    prompt.extraReadFiles ?? [],
  );
  for (const filePath of readFiles) {
    toolCalls.push(await runRuntimeTool(workspace, "read_file", { path: filePath }));
  }
  toolCalls.push(await runRuntimeTool(workspace, "detect_test_commands"));

  if (workspace.hasRepository) {
    toolCalls.push(await runRuntimeTool(workspace, "git_status"));
  }

  // 构建 Runtime Memory 上下文
  const includeCodeReviewRetryContext = stepId === "code_generation" &&
    prompt.extraContext?.generationMode === "code-review-retry";
  const runtimeMemory = buildRuntimeMemoryContext(run, stepId);
  const workflow = buildAgentVisibleWorkflow(run, stepId, { includeCodeReviewRetryContext });
  const runtimeMemorySummary = !includeCodeReviewRetryContext && stepId === "code_generation"
    ? runtimeMemory.summary
      .split("\n")
      .filter((line) => !isCodeReviewRetryIntervention(line))
      .join("\n")
    : runtimeMemory.summary;

  const trace: AgentRuntimeTrace = {
    runtime: "simple-agent-runtime",
    workspaceId: workspace.id,
    workspaceDir: workspace.workspaceDir,
    observations: [
      `工作区：${workspace.repoName}`,
      `扫描文件数：${workspace.repositoryScan.filesInspected}`,
      `技术栈：${workspace.repositoryScan.stack.join(" / ")}`,
      `当前 Step：${stepId}`,
      `Runtime Memory: ${runtimeMemory.allUserDecisions.length} 条用户决策`,
    ],
    toolCalls,
  };

  const result = await callJsonLlmWithSchema([
    {
      role: "system",
      content: [
        `你是 ${stepAgents[stepId]}，运行在一个简易 Claude Code-like Agent Runtime 中。`,
        "你必须使用中文输出，路径、命令、代码标识符可以保留英文。",
        "你必须基于 runtime 工具观测结果、readme-for-agent.md 和 workflow JSON 做判断。",
        "你必须优先遵守 runtimeMemory 中用户明确确认/修正的约束。",
        "如果用户反馈与你原计划冲突，以用户反馈为准。",
        "不要重复提出已被用户回答的问题。",
        "不要声称已经执行没有出现在 runtime.toolCalls 中的工具或命令。",
        "不要编造文件路径；优先使用 runtime.toolCalls 中 list_files/read_agent_guide 暴露的信息。",
        "每个 Step 仍然必须只返回满足 schema 的 JSON object。",
        prompt.instruction,
        `输出契约：${prompt.outputContract}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        stepId,
        workflow,
        runtime: trace,
        runtimeMemory: runtimeMemorySummary,
        ...(prompt.extraContext ? { stepContext: prompt.extraContext } : {}),
      }),
    },
  ], schema, { label: stepAgents[stepId] }).catch((error) => {
    const usage = getLlmUsageFromError(error);
    if (usage) {
      recordMetric({
        agent: stepAgents[stepId],
        calls: 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        estimatedCost: 0,
      });
    }
    throw error;
  });

  return {
    output: result.content,
    trace,
    tokens: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    },
  };
}

export function selectInitialReadFiles(keyFiles: string[]) {
  const priority = [
    "readme.md",
    "package.json",
    "app.",
    "main.",
    "routes/",
    "controllers/",
    "models/",
    "services/",
  ];

  return [...keyFiles]
    .sort((left, right) => scoreKeyFile(right, priority) - scoreKeyFile(left, priority))
    .slice(0, 6);
}

function mergeReadFiles(initialFiles: string[], extraFiles: string[]) {
  const safeExtraFiles = extraFiles.filter((file) => (
    file && !file.includes("..") && !file.startsWith("/") && !file.endsWith("/")
  ));
  return Array.from(new Set([...initialFiles, ...safeExtraFiles])).slice(0, 16);
}

function scoreKeyFile(filePath: string, priority: string[]) {
  const normalized = filePath.toLowerCase();
  return priority.reduce((score, pattern, index) => (
    normalized.includes(pattern) ? score + priority.length - index : score
  ), 0);
}
