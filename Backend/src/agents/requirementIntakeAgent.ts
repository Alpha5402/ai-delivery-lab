import { z } from "zod";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";

const requirementTitleSchema = z.object({
  title: z.string().min(4).max(40),
});

export async function generateRequirementTitle(rawText: string): Promise<string> {
  try {
    const result = await callJsonLlmWithSchema([
      {
        role: "system",
        content: [
          "你是 AI Delivery Workspace 的接收需求 AI。",
          "请把用户输入的交付需求总结成一句中文任务标题。",
          "标题必须完整、自然，不要截断单词或字段名。",
          "不要使用引号、句号、Markdown 或编号。",
          "输出 JSON：{ \"title\": string }。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({ rawText }),
      },
    ], requirementTitleSchema, { label: "接收需求" });

    recordMetric({
      agent: "接收需求",
      calls: 1,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      estimatedCost: 0,
    });

    return normalizeRequirementTitle(result.content.title, rawText);
  } catch {
    return normalizeRequirementTitle("", rawText);
  }
}

function normalizeRequirementTitle(title: string, rawText: string) {
  const cleaned = title
    .replace(/["'`#$\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length >= 4) return trimAtBoundary(cleaned, 36);

  return deriveFallbackTitle(rawText);
}

function deriveFallbackTitle(rawText: string) {
  const firstSentence = rawText
    .replace(/\s+/g, " ")
    .split(/[。！？!?；;\n]/)[0]
    ?.trim() ?? "";
  const cleaned = firstSentence
    .replace(/^(请|帮我|帮忙|需要|希望|我想要|实现|新增|添加|增加|优化|修复)\s*/u, "")
    .trim();

  return trimAtBoundary(cleaned || "新的交付任务", 36);
}

function trimAtBoundary(value: string, limit: number) {
  if (value.length <= limit) return value;

  const candidate = value.slice(0, limit);
  const lastDelimiter = Math.max(
    candidate.lastIndexOf("，"),
    candidate.lastIndexOf(","),
    candidate.lastIndexOf("、"),
    candidate.lastIndexOf(" "),
  );

  if (lastDelimiter >= 8) return candidate.slice(0, lastDelimiter).trim();
  return candidate.trim();
}
