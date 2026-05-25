import type { z } from "zod";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { getCurrentWorkspace } from "../services/workspaceService.js";
import type { WorkflowRun, WorkflowStepId } from "../domain/workflow.js";
import { stepAgents } from "../domain/workflow.js";
import { runRuntimeTool } from "./toolRegistry.js";
import type { AgentRuntimeTrace, RuntimeToolCall } from "./types.js";

type RuntimePrompt = {
  instruction: string;
  outputContract: string;
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
  for (const filePath of selectInitialReadFiles(Object.keys(workspace.repositoryScan.keyFiles))) {
    toolCalls.push(await runRuntimeTool(workspace, "read_file", { path: filePath }));
  }
  toolCalls.push(await runRuntimeTool(workspace, "detect_test_commands"));

  if (workspace.hasRepository) {
    toolCalls.push(await runRuntimeTool(workspace, "git_status"));
  }

  const trace: AgentRuntimeTrace = {
    runtime: "simple-agent-runtime",
    workspaceId: workspace.id,
    workspaceDir: workspace.workspaceDir,
    observations: [
      `工作区：${workspace.repoName}`,
      `扫描文件数：${workspace.repositoryScan.filesInspected}`,
      `技术栈：${workspace.repositoryScan.stack.join(" / ")}`,
      `当前 Step：${stepId}`,
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
        workflow: run,
        runtime: trace,
      }),
    },
  ], schema, { label: stepAgents[stepId] });

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

function scoreKeyFile(filePath: string, priority: string[]) {
  const normalized = filePath.toLowerCase();
  return priority.reduce((score, pattern, index) => (
    normalized.includes(pattern) ? score + priority.length - index : score
  ), 0);
}
