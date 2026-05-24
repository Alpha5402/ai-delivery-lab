import { stepAgents, stepLabels, stepOrder } from "./stepDefinitions";
import type { StepRun, WorkflowRun } from "./types";

export const wordCountRequirement = {
  title: "文章详情页新增字数统计",
  rawText: "在 Conduit 的文章详情页正文下方展示本文共 XXX 字，预计阅读 X 分钟。前端基于 Article.body 计算，不改后端。",
  pattern: "frontend-only" as const,
  targetRepo: "conduit" as const,
};

const outputs = {
  requirement_intake: wordCountRequirement,
  clarification: {
    summary: "这是一个 L1 纯前端需求，展示位置在 Article 页面正文下方，数据来源为 Article.body。",
    questions: [
      {
        id: "q-reading-speed",
        question: "预计阅读时间按什么速度计算？",
        answer: "中文/英文混合统一按每分钟 300 字/词估算，最少 1 分钟。",
        riskIfUnanswered: "不同估算规则会导致展示数字不稳定。",
      },
      {
        id: "q-empty-body",
        question: "正文为空时如何展示？",
        answer: "展示本文共 0 字，预计阅读 1 分钟。",
        riskIfUnanswered: "空正文可能出现 0 分钟或 NaN。",
      },
    ],
    confidence: 0.92,
  },
  solution_design: {
    requirementId: "conduit-article-word-count",
    scope: "frontend" as const,
    userStory: "作为读者，我希望在文章详情页看到字数和预计阅读时间，以便快速判断阅读成本。",
    acceptanceCriteria: [
      "文章详情页正文下方展示字数统计。",
      "阅读时间根据 Article.body 计算，最少 1 分钟。",
      "不修改后端接口或数据库结构。",
      "纯逻辑函数具备单元测试。",
    ],
    dataContract: {
      input: { articleBody: "string" },
      output: { wordCount: "number", readingMinutes: "number" },
    },
  },
  module_mapping: {
    touchedModules: [
      {
        name: "Article detail page",
        reason: "正文展示区域是新增统计信息的直接挂载点。",
        files: ["frontend/src/pages/Article.tsx"],
      },
      {
        name: "Article utilities",
        reason: "字数统计属于可复用纯逻辑，应独立测试。",
        files: ["frontend/src/lib/readingStats.ts", "frontend/src/lib/readingStats.test.ts"],
      },
    ],
    reusableSkill: "frontend-display-derived-field",
  },
  code_generation: {
    strategy: "新增 readingStats 纯函数，在 Article 页面渲染统计卡片，并补充 Vitest 单测。",
    tasks: [
      {
        id: "task-util",
        title: "实现 calculateReadingStats(body)",
        files: ["frontend/src/lib/readingStats.ts"],
        testRequired: true,
      },
      {
        id: "task-ui",
        title: "在文章正文下方展示统计信息",
        files: ["frontend/src/pages/Article.tsx"],
        testRequired: false,
      },
    ],
  },
  repo_write: {
    branch: "feature/article-reading-stats",
    filesChanged: [
      { path: "frontend/src/lib/readingStats.ts", changeType: "created" as const, additions: 34, deletions: 0 },
      { path: "frontend/src/lib/readingStats.test.ts", changeType: "tested" as const, additions: 41, deletions: 0 },
      { path: "frontend/src/pages/Article.tsx", changeType: "modified" as const, additions: 12, deletions: 1 },
    ],
  },
  verification: {
    lint: "passed" as const,
    unitTests: "passed" as const,
    coverage: 88,
    testSuites: [
      { name: "readingStats.test.ts", status: "passed" as const, durationMs: 44 },
      { name: "Article.render.test.tsx", status: "passed" as const, durationMs: 91 },
    ],
  },
  pull_request: {
    title: "feat(article): show word count and reading time",
    url: "https://github.com/example/conduit-realworld-example-app/pull/42",
    status: "draft" as const,
    checklist: ["需求澄清已确认", "Lint 通过", "单测通过", "变更范围仅限前端"],
  },
};

export function createMockWorkflowRun(): WorkflowRun {
  const steps: StepRun[] = stepOrder.map((stepId, index) => ({
    id: stepId,
    label: stepLabels[stepId],
    agent: stepAgents[stepId],
    status: index <= 2 ? "success" : index === 3 ? "waiting-human" : "idle",
    input: index === 0 ? { source: "pm" } : outputs[stepOrder[index - 1]],
    output: index <= 3 ? outputs[stepId] : undefined,
    startedAt: index <= 3 ? "2026-05-24T10:00:00+08:00" : undefined,
    finishedAt: index <= 2 ? "2026-05-24T10:00:06+08:00" : undefined,
    logs: index <= 3 ? [`${stepAgents[stepId]} 已生成结构化输出`] : [],
    humanEditable: ["clarification", "solution_design", "module_mapping", "code_generation"].includes(stepId),
  }));

  return {
    id: "run-conduit-reading-stats",
    title: wordCountRequirement.title,
    createdAt: "2026-05-24T10:00:00+08:00",
    activeStepId: "module_mapping",
    steps,
  };
}
