import { z } from "zod";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";

const requirementTitleSchema = z.object({
  title: z.string().min(4).max(40),
});

const TITLE_LIMIT = 28;

export async function generateRequirementTitle(rawText: string): Promise<string> {
  try {
    const result = await callJsonLlmWithSchema([
      {
        role: "system",
        content: [
          "你是 AI Delivery Workspace 的接收需求 AI。",
          "请把用户输入的交付需求总结成一句中文任务标题。",
          "标题必须是重新概括后的自然短句，不要把原文去掉标点后直接拼接。",
          "标题聚焦交付对象和核心改动，优先使用「页面/模块 + 动作 + 能力」结构。",
          "标题控制在 8-18 个中文字符左右；必要字段名可以保留，但不要截断单词或字段名。",
          "不要使用引号、句号、Markdown 或编号。",
          "示例：输入「在文章详情页展示正文纯文本字数，保持现有样式，并补充计算逻辑测试。」输出「文章详情页新增字数统计」。",
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
    .replace(/["'`#$\\。！？!?；;]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (isUsableGeneratedTitle(cleaned, rawText)) return trimAtBoundary(cleaned, TITLE_LIMIT);

  return deriveFallbackTitle(rawText);
}

function isUsableGeneratedTitle(title: string, rawText: string) {
  if (title.length < 4) return false;
  if (title.length > 40) return false;

  const rawNormalized = normalizeForComparison(rawText);
  const titleNormalized = normalizeForComparison(title);
  if (!titleNormalized) return false;

  // 典型坏结果：把原始需求去掉标点和空白后直接取一段作为标题。
  if (rawNormalized.startsWith(titleNormalized) && titleNormalized.length > 18) {
    return false;
  }

  return true;
}

export function deriveFallbackTitle(rawText: string) {
  const normalized = rawText
    .replace(/\s+/g, " ")
    .replace(/["'`#$\\]/g, "")
    .trim();
  const clauses = normalized
    .split(/[。！？!?；;\n，,、]/)
    .map((clause) => cleanupRequirementClause(clause))
    .filter((clause) => clause.length >= 4);

  const bestClause = clauses
    .sort((a, b) => scoreTitleClause(b) - scoreTitleClause(a))[0]
    ?? cleanupRequirementClause(normalized)
    ?? "新的交付任务";

  return trimAtBoundary(compactTitle(bestClause), TITLE_LIMIT) || "新的交付任务";
}

function cleanupRequirementClause(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^(请|帮我|帮忙|麻烦|需要|希望|我想要|我想|实现|新增|添加|增加|优化|修复)+\s*/u, "")
    .replace(/^在(.+?(?:页面|模块|组件|文件|目录|页|中|里|上|下))\s*/u, "$1")
    .replace(/^(给|为)\s*/u, "")
    .replace(/^(并|且|同时|然后|再)\s*/u, "")
    .replace(/(即可|就好|就行|一下)$/u, "")
    .trim();
}

function scoreTitleClause(value: string) {
  let score = 0;
  if (/[页屏区栏表单列表详情工作区中心]/u.test(value)) score += 4;
  if (/(新增|展示|显示|支持|修复|优化|重构|接入|生成|提交|验证|统计|配置|登录|推送)/u.test(value)) score += 4;
  if (/(测试|保持|同时|并|要求|约束|验收|例如)/u.test(value)) score -= 3;
  if (value.length >= 8 && value.length <= TITLE_LIMIT) score += 3;
  if (value.length > TITLE_LIMIT) score -= Math.ceil((value.length - TITLE_LIMIT) / 4);
  return score;
}

function compactTitle(value: string) {
  return value
    .replace(/正文纯文本字数/u, "字数")
    .replace(/纯文本字数/u, "字数")
    .replace(/计算逻辑测试/u, "测试")
    .replace(/单元测试用例/u, "单元测试")
    .replace(/前端根据\s*/iu, "")
    .replace(/进行/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForComparison(value: string) {
  return value
    .replace(/[\s"'`#$\\。！？!?；;，,、：:（）()【】\[\]{}<>《》-]/g, "")
    .trim();
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
