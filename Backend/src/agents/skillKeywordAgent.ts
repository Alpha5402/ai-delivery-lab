import { z } from "zod";
import { callJsonLlmWithSchema } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";
import type { SkillManifest } from "../skills/skillTypes.js";

const keywordResultSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(30),
  rationale: z.string().optional(),
});

export type SkillKeywordInput = {
  id: string;
  name: string;
  description?: string;
  requirementPatterns: string[];
  scopes: string[];
  stepIds: string[];
  instructionText: string;
  fileGlobs?: string[];
  routeHints?: string[];
};

/** Deterministic fallback: 从 skill 描述中提取候选关键词 */
function deterministicKeywords(input: SkillKeywordInput): string[] {
  const sources = [
    input.name,
    input.description ?? "",
    input.instructionText,
    ...(input.fileGlobs ?? []),
    ...(input.routeHints ?? []),
    ...input.requirementPatterns,
    ...input.scopes,
  ];
  const text = sources.join(" ").toLowerCase();
  // 提取中英文词：中文按常见分隔，英文按单词边界
  const words = new Set<string>();
  // 中文词（2-8 字）
  const chinese = text.match(/[一-鿿]{2,8}/g) ?? [];
  for (const w of chinese) words.add(w);
  // 英文词
  const english = text.match(/[a-z][a-z0-9_-]{1,20}/gi) ?? [];
  for (const w of english) words.add(w.toLowerCase());
  // 过滤太短的
  return [...words].filter((w) => w.length > 1).slice(0, 20);
}

/** 调用 LLM 生成关键词；失败时 fallback 到 deterministic */
export async function generateSkillKeywords(
  input: SkillKeywordInput,
): Promise<{ keywords: string[]; source: "llm" | "fallback" }> {
  try {
    const result = await callJsonLlmWithSchema([
      {
        role: "system",
        content: [
          "你是 AI Delivery Workspace 的 Skill 关键词生成 AI。",
          "根据 Skill 的名称、描述、适用模式、范围、提示词，生成 5-20 个检索关键词。",
          "要求：",
          "  - 优先中英文技术词、业务词",
          "  - 短词优先（2-6 字）",
          "  - 不要输出泛泛的\"功能\"/\"页面\"/\"模块\"",
          "  - 输出 JSON: { keywords: string[], rationale?: string }",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(input),
      },
    ], keywordResultSchema, { label: "Skill Keyword Agent" });

    recordMetric({
      agent: "Skill Keyword Agent",
      calls: 1,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      estimatedCost: 0,
    });

    return { keywords: result.content.keywords.slice(0, 20), source: "llm" };
  } catch {
    return { keywords: deterministicKeywords(input), source: "fallback" };
  }
}

/** 从 SkillManifest 提取关键词生成输入 */
export function buildKeywordInput(skill: SkillManifest): SkillKeywordInput {
  const stepIds = Object.keys(skill.steps ?? {});
  const instructionText = stepIds
    .map((sid) => (skill.steps as Record<string, { instructionAddon?: string }>)?.[sid]?.instructionAddon ?? "")
    .join(" ");
  return {
    id: skill.id,
    name: skill.name,
    description: (skill as { description?: string }).description,
    requirementPatterns: [...skill.requirementPatterns],
    scopes: [...skill.scopes],
    stepIds,
    instructionText,
    fileGlobs: skill.match.fileGlobs,
    routeHints: skill.match.routeHints,
  };
}
