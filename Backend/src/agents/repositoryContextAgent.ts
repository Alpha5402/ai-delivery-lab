import { z } from "zod";
import type { AgentReadmeResult, RepositoryScanResult } from "../domain/workspace.js";
import { callJsonLlmWithSchema, getLlmUsageFromError, type ChatMessage } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";
import { logWorkspaceEvent } from "../services/workspaceLogger.js";

const stringListSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  return value;
}, z.array(z.string().min(1)));

const architectureSectionSchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("\n");
  }
  return value;
}, z.string().min(1));

const agentReadmeSchema = z.object({
  fileName: z.literal("readme-for-agent.md"),
  content: z.string().min(1),
  sections: z.object({
    architecture: architectureSectionSchema,
    stack: stringListSchema,
    conventions: stringListSchema,
    testing: stringListSchema,
    riskNotes: stringListSchema,
  }),
});

export async function generateAgentReadme(repoName: string, scan: RepositoryScanResult): Promise<AgentReadmeResult> {
  logWorkspaceEvent("readme.agent.start", {
    repoName,
    source: scan.source,
    filesInspected: scan.filesInspected,
    keyFiles: Object.keys(scan.keyFiles),
  });

  const result = await callJsonLlmWithSchema(buildRepositoryContextMessages(repoName, scan), agentReadmeSchema, { label: "Repository Context Agent" })
    .catch((error) => {
      const usage = getLlmUsageFromError(error);
      if (usage) {
        recordMetric({
          agent: "Repository Context Agent",
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
    agent: "Repository Context Agent",
    calls: 1,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    estimatedCost: 0,
  });

  logWorkspaceEvent("readme.agent.success", {
    repoName,
    attempts: result.attempts,
    validationRetries: result.validationErrors.length,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    contentLength: result.content.content.length,
  });

  return result.content;
}

export function buildRepositoryContextMessages(repoName: string, scan: RepositoryScanResult): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 Repository Context Agent，负责为后续代码生成 Agent 编写 readme-for-agent.md。",
        "你必须使用中文输出。除文件名、路径、命令、代码标识符之外，不要使用英文段落标题或英文说明。",
        "你必须基于用户提供的扫描事实、fileTree 文件目录和关键文件摘录总结，不得编造未扫描到的目录、脚本或测试命令。",
        "注意力重点：目录结构、模块边界、核心运行原理、前后端如何交互、数据模型/状态流、后续 Agent 改代码时应该先读哪些文件。",
        "不要把 readme-for-agent.md 写成启动手册。Prerequisites、Common Commands、Dev mode 只能作为很短的补充信息，不能成为主体。",
        "输出必须是 JSON object，字段为 fileName, content, sections。",
        "fileName 必须是 readme-for-agent.md。",
        "content 必须是完整中文 Markdown，适合后续 Agent 直接阅读。",
        "sections 必须包含 architecture, stack, conventions, testing, riskNotes。",
        "sections 必须是 object，不是 array。",
        "sections.architecture 必须是 string，不是 array，用一段中文总结架构。",
        "sections.stack / conventions / testing / riskNotes 必须是 string array，不是 string。",
        "严格示例：\"sections\": { \"architecture\": \"前后端分离架构...\", \"stack\": [\"React + Vite\", \"Express + Sequelize\"], \"conventions\": [\"...\"], \"testing\": [\"...\"], \"riskNotes\": [\"...\"] }。",
        "architecture 要描述真实模块边界、前后端关系、数据层、重要业务域和请求链路，而不是只罗列技术栈。",
        "content 推荐结构：项目定位、目录结构、核心模块与职责、前后端交互链路、数据模型与持久化、测试与风险、后续 Agent 阅读顺序。",
        "目录结构必须优先基于 scan.fileTree 和 keyFiles；README 中的启动命令只能用于校验脚本，不应主导总结。",
        "testing 要只列扫描到或关键文件中明确存在的测试入口。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        repoName,
        scan,
        outputLanguage: "zh-CN",
        focus: [
          "目录结构",
          "模块边界",
          "核心运行原理",
          "前后端交互",
          "数据模型和状态流",
          "后续代码生成 Agent 的阅读顺序",
        ],
        avoidOverFocusingOn: [
          "安装依赖",
          "启动命令",
          "环境准备",
        ],
      }),
    },
  ];
}
