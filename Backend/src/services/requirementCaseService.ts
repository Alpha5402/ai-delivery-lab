import { randomUUID } from "node:crypto";
import type {
  ClarificationOutput,
  CodeGenerationPlan,
  ModuleMapping,
  PullRequestResult,
  RequirementDraft,
  SolutionDsl,
  VerificationResult,
  WorkflowRun,
} from "../domain/workflow.js";
import type { RecalledRequirementCase, RequirementCase, WorkspaceContext } from "../domain/workspace.js";
import {
  deleteRequirementCaseFromStore,
  getRequirementCaseFromStore,
  listRequirementCasesFromStore,
  saveRequirementCaseToStore,
} from "./workspaceStore.js";
import { cosineSimilarity, getEmbedding } from "./embeddingService.js";
import { callJsonLlmWithSchema } from "./llmClient.js";
import { z } from "zod";

function getStepOutput<T>(run: WorkflowRun, stepId: string): T | undefined {
  return run.steps.find((step) => step.id === stepId)?.output as T | undefined;
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function tokenize(value: string) {
  return unique(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_/-]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 2),
  );
}

const weakReasonTokens = new Set([
  "前端",
  "后端",
  "根据",
  "前端根据",
  "计算",
  "展示",
  "新增",
  "修改",
  "实现",
  "页面",
  "功能",
  "需求",
  "用户",
  "代码",
]);

function isUsefulReasonToken(token: string) {
  const normalized = token.toLowerCase();
  if (weakReasonTokens.has(normalized)) return false;
  if (/^(frontend|backend|fullstack|react|vite|express|sequelize|node|typescript|javascript)$/i.test(normalized)) return false;
  if (/^[\p{L}]+$/u.test(normalized) && normalized.length <= 2) return false;
  return true;
}

const caseSimilarityReasonSchema = z.object({
  reason: z.string().min(8).max(120),
});

async function buildDemandSimilarityReason(item: RequirementCase, requirement: RequirementDraft, evidence: {
  keywordHits: string[];
  fileHits: string[];
  embeddingScore?: number;
}) {
  try {
    const result = await callJsonLlmWithSchema([
      {
        role: "system",
        content: [
          "你是 AI Delivery Workspace 的历史需求案例召回解释器。",
          "你的任务是比较当前需求和一个历史案例，输出给用户看的“相似点”。",
          "必须只解释需求目标、业务对象、页面/文件指向、用户价值上的相似处。",
          "禁止输出技术栈、需求模式、关键词命中、embedding、score、向量、RAG 等实现细节。",
          "不要说“关键词重合”。不要编造未提供的信息。",
          "如果只能判断大体相似，也要用谨慎表述。",
          "输出 JSON: { \"reason\": \"相似点：...\" }",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          currentRequirement: {
            title: requirement.title,
            rawText: requirement.rawText,
          },
          historicalCase: {
            title: item.title,
            rawRequirement: item.rawRequirement,
            requirementSummary: item.requirementSummary,
            solutionSummary: item.solutionSummary,
            acceptedConstraints: item.acceptedConstraints.slice(0, 8),
            touchedFiles: item.touchedFiles.slice(0, 8),
            codeTasks: item.codeTasks.slice(0, 8),
          },
          retrievalEvidence: {
            keywordHits: evidence.keywordHits.slice(0, 6),
            fileHits: evidence.fileHits.slice(0, 4),
            embeddingScore: evidence.embeddingScore,
          },
        }),
      },
    ], caseSimilarityReasonSchema, { label: "Requirement Case Similarity Reason", maxAttempts: 1 });

    return result.content.reason.startsWith("相似点：")
      ? result.content.reason
      : `相似点：${result.content.reason}`;
  } catch {
    const usefulHits = evidence.keywordHits.filter(isUsefulReasonToken).slice(0, 3);
    if (evidence.fileHits.length > 0) {
      return `相似点：两次需求都指向相近的业务页面或文件：${evidence.fileHits.slice(0, 2).join("、")}。`;
    }
    if (usefulHits.length > 0) {
      return `相似点：两次需求都涉及 ${usefulHits.join("、")}。`;
    }
    return "相似点：历史案例与当前需求在目标语义上接近。";
  }
}

function isRunSuccessful(run: WorkflowRun) {
  return run.steps.length > 0 && run.steps.every((step) => step.status === "success");
}

export function extractRequirementCaseFromRun(run: WorkflowRun, workspace: WorkspaceContext): RequirementCase {
  if (!isRunSuccessful(run)) {
    throw new Error("只有已完成的交付任务可以收藏为历史案例");
  }

  const requirement = getStepOutput<RequirementDraft>(run, "requirement_intake");
  const clarification = getStepOutput<ClarificationOutput>(run, "clarification");
  const solution = getStepOutput<SolutionDsl>(run, "solution_design");
  const mapping = getStepOutput<ModuleMapping>(run, "module_mapping");
  const codegen = getStepOutput<CodeGenerationPlan>(run, "code_generation");
  const verification = getStepOutput<VerificationResult>(run, "verification");
  const pullRequest = getStepOutput<PullRequestResult>(run, "pull_request");

  const rawRequirement = requirement?.rawText ?? run.title;
  const acceptedConstraints = [
    ...(solution?.acceptanceCriteria ?? []),
    ...((clarification?.decisions ?? []).map((decision) => `${decision.title}: ${decision.finalAnswer}`)),
  ];
  const touchedFiles = unique([
    ...((mapping?.touchedModules ?? []).flatMap((module) => module.files)),
    ...((codegen?.tasks ?? []).flatMap((task) => [...task.files, ...((task as { testFiles?: string[] }).testFiles ?? [])])),
  ]);
  const codeTasks = unique((codegen?.tasks ?? []).map((task) => task.title));
  const verificationParts = [
    verification ? `lint ${verification.lint}` : "",
    verification ? `unit_tests ${verification.unitTests}` : "",
    verification ? `build ${verification.build}` : "",
    verification ? `typecheck ${verification.typecheck}` : "",
    pullRequest?.url && !pullRequest.url.startsWith("pending://") ? `PR ${pullRequest.url}` : "",
  ];
  const tags = unique([
    requirement?.pattern ?? "",
    solution?.scope ?? "",
    ...workspace.repositoryScan.stack.slice(0, 6),
  ]);
  const keywordText = [
    run.title,
    rawRequirement,
    clarification?.summary,
    solution?.userStory,
    ...(solution?.acceptanceCriteria ?? []),
    ...codeTasks,
    ...touchedFiles,
    ...tags,
  ].filter(Boolean).join(" ");
  const embeddingText = buildRequirementCaseEmbeddingText({
    title: run.title,
    rawRequirement,
    requirementSummary: clarification?.summary ?? solution?.userStory ?? rawRequirement,
    acceptedConstraints: unique(acceptedConstraints),
    solutionSummary: solution?.userStory ?? codegen?.strategy ?? run.title,
    codeTasks,
    touchedFiles,
  });
  const timestamp = new Date().toISOString();

  return {
    id: `case-${randomUUID()}`,
    projectId: run.projectId ?? workspace.id,
    workspaceId: workspace.id,
    createdFromRunId: run.id,
    title: run.title,
    rawRequirement,
    requirementPattern: requirement?.pattern ?? "unclear",
    requirementSummary: clarification?.summary ?? solution?.userStory ?? rawRequirement,
    acceptedConstraints: unique(acceptedConstraints),
    solutionSummary: solution?.userStory ?? codegen?.strategy ?? run.title,
    touchedFiles,
    codeTasks,
    verificationSummary: unique(verificationParts).join(" · ") || "未记录验证结果",
    pullRequestUrl: pullRequest?.url && !pullRequest.url.startsWith("pending://") ? pullRequest.url : undefined,
    tags,
    stack: workspace.repositoryScan.stack,
    keywords: tokenize(keywordText).slice(0, 80),
    embeddingText,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function saveRequirementCaseFromRun(run: WorkflowRun, workspace: WorkspaceContext) {
  const item = extractRequirementCaseFromRun(run, workspace);
  const embeddingResult = await getEmbedding(item.embeddingText ?? "");
  return saveRequirementCaseToStore({
    ...item,
    embedding: embeddingResult?.embedding,
    embeddingModel: embeddingResult?.model,
    embeddingUpdatedAt: embeddingResult ? new Date().toISOString() : undefined,
  });
}

export function listRequirementCases(projectId: string) {
  return listRequirementCasesFromStore(projectId);
}

export function getRequirementCase(projectId: string, caseId: string) {
  return getRequirementCaseFromStore(projectId, caseId);
}

export function deleteRequirementCase(projectId: string, caseId: string) {
  return deleteRequirementCaseFromStore(projectId, caseId);
}

function buildRequirementCaseEmbeddingText(input: {
  title: string;
  rawRequirement: string;
  requirementSummary: string;
  acceptedConstraints: string[];
  solutionSummary: string;
  codeTasks: string[];
  touchedFiles: string[];
}) {
  return [
    `标题：${input.title}`,
    `原始需求：${input.rawRequirement}`,
    `需求摘要：${input.requirementSummary}`,
    input.acceptedConstraints.length ? `已确认约束：${input.acceptedConstraints.join("；")}` : "",
    `方案摘要：${input.solutionSummary}`,
    input.codeTasks.length ? `代码任务：${input.codeTasks.join("；")}` : "",
    input.touchedFiles.length ? `触达文件：${input.touchedFiles.join("；")}` : "",
  ].filter(Boolean).join("\n");
}

function buildRequirementQueryText(requirement: RequirementDraft) {
  return [
    `标题：${requirement.title}`,
    `当前需求：${requirement.rawText}`,
  ].join("\n");
}

function scoreCaseByRules(item: RequirementCase, requirement: RequirementDraft, workspace?: WorkspaceContext) {
  const requirementTokens = new Set(tokenize(`${requirement.title} ${requirement.rawText}`));
  const nonRequirementReasonTokens = new Set([
    item.requirementPattern,
    requirement.pattern,
    "frontend-only",
    "cross-stack",
    "interaction",
    "unclear",
    "frontend",
    "backend",
    "fullstack",
    ...(workspace?.repositoryScan.stack ?? []),
    ...item.stack,
  ].flatMap((value) => tokenize(value)));
  const reasons: string[] = [];
  const evidence = {
    keywordHits: [] as string[],
    fileHits: [] as string[],
  };
  let score = 0;
  let hasSubstantiveMatch = false;

  if (item.requirementPattern === requirement.pattern) {
    score += 2;
  }

  const keywordHits = item.keywords.filter((keyword) =>
    requirementTokens.has(keyword) &&
    !nonRequirementReasonTokens.has(keyword) &&
    isUsefulReasonToken(keyword),
  );
  if (keywordHits.length >= 2) {
    hasSubstantiveMatch = true;
    score += Math.min(keywordHits.length * 3, 24);
    evidence.keywordHits = keywordHits.slice(0, 8);
  }

  const stack = workspace?.repositoryScan.stack ?? [];
  const stackHits = item.stack.filter((entry) => stack.includes(entry));
  if (stackHits.length > 0) {
    score += Math.min(stackHits.length, 4);
  }

  const requirementText = `${requirement.title} ${requirement.rawText}`.toLowerCase();
  const fileHits = item.touchedFiles.filter((file) => {
    const base = file.split("/").pop()?.toLowerCase();
    return base ? requirementText.includes(base.replace(/\.[^.]+$/, "")) : false;
  });
  if (fileHits.length > 0) {
    hasSubstantiveMatch = true;
    score += Math.min(fileHits.length * 4, 12);
    evidence.fileHits = fileHits.slice(0, 4);
  }

  if (!hasSubstantiveMatch) {
    return { score: 0, reasons, evidence };
  }

  return { score, reasons, evidence };
}

export async function searchRequirementCases(projectId: string, requirement: RequirementDraft, workspace?: WorkspaceContext): Promise<RecalledRequirementCase[]> {
  const queryEmbedding = await getEmbedding(buildRequirementQueryText(requirement));
  const cases = await Promise.all(listRequirementCasesFromStore(projectId).map(async (item) => {
    if (item.embedding?.length || !queryEmbedding) return item;
    const embeddingText = item.embeddingText ?? buildRequirementCaseEmbeddingText({
      title: item.title,
      rawRequirement: item.rawRequirement,
      requirementSummary: item.requirementSummary,
      acceptedConstraints: item.acceptedConstraints,
      solutionSummary: item.solutionSummary,
      codeTasks: item.codeTasks,
      touchedFiles: item.touchedFiles,
    });
    const embeddingResult = await getEmbedding(embeddingText);
    return embeddingResult
      ? saveRequirementCaseToStore({
        ...item,
        embeddingText,
        embedding: embeddingResult.embedding,
        embeddingModel: embeddingResult.model,
        embeddingUpdatedAt: new Date().toISOString(),
      })
      : item;
  }));

  const ranked = cases
    .map((item) => {
      const ruleMatch = scoreCaseByRules(item, requirement, workspace);
      const embeddingScore = queryEmbedding && item.embedding
        ? cosineSimilarity(queryEmbedding.embedding, item.embedding)
        : 0;
      const embeddingPoints = embeddingScore >= 0.72 ? Math.round(embeddingScore * 40) : 0;
      const score = ruleMatch.score + embeddingPoints;
      return {
        id: item.id,
        title: item.title,
        summary: item.solutionSummary || item.requirementSummary,
        score,
        ruleScore: ruleMatch.score,
        embeddingScore: embeddingScore > 0 ? Number(embeddingScore.toFixed(4)) : undefined,
        touchedFiles: item.touchedFiles.slice(0, 8),
        createdFromRunId: item.createdFromRunId,
        item,
        evidence: {
          ...ruleMatch.evidence,
          embeddingScore,
        },
      };
    })
    .filter((item) => (
      (item.ruleScore ?? 0) >= 12 ||
      ((item.embeddingScore ?? 0) >= 0.78 && item.score >= 30) ||
      ((item.embeddingScore ?? 0) >= 0.72 && (item.ruleScore ?? 0) >= 6 && item.score >= 30)
    ))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return Promise.all(ranked.map(async ({ item, evidence, ...result }) => ({
    ...result,
    matchedReasons: unique([await buildDemandSimilarityReason(item, requirement, evidence)]),
  })));
}

export function buildHistoricalCasePromptContext(cases: RecalledRequirementCase[] | undefined) {
  if (!cases?.length) return "";
  return [
    "## 已召回相似历史需求案例（必须阅读，但仅作参考）",
    "这些案例来自用户主动收藏的同项目成功交付任务，并且只有在需求文本、业务对象、页面/文件指向存在共性时才会召回。技术栈、仓库类型或需求模式不构成召回理由。你必须先阅读匹配原因、历史触达文件和历史方案摘要，再决定当前任务可复用的做法。",
    "硬性约束：召回内容仅供代码生成阶段参考，不能影响需求确认、澄清或方案本身。",
    "硬性约束：不论历史案例多相似，都必须以当前用户需求、当前澄清结论、当前方案和当前代码为准。",
    "硬性约束：历史案例不能替代当前需求、当前代码和当前 diff 证据；若历史案例与当前代码结构冲突，以当前代码结构为准。",
    "硬性约束：不要因为历史案例曾成功就声称当前任务已完成；当前每个 task 仍必须真实写入文件并能被 diff/测试/审查验证。",
    ...cases.map((item, index) => [
      `### 案例 ${index + 1}: ${item.title}`,
      `- 摘要: ${item.summary}`,
      `- 匹配原因: ${item.matchedReasons.join("；") || "规则相似"}`,
      item.touchedFiles.length ? `- 历史触达文件: ${item.touchedFiles.join(", ")}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n");
}
