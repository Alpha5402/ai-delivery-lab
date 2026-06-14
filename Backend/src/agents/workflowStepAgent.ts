import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z as zod } from "zod";
import { z } from "zod";
import { runSimpleAgentRuntime } from "../agentRuntime/simpleAgentRuntime.js";
import { runRuntimeTool } from "../agentRuntime/toolRegistry.js";
import {
  type CodeGenerationPlan,
  codeReviewResultSchema,
  type FileChange,
  llmCodeGenerationPlanSchema,
  pullRequestResultSchema,
  type RepoWriteResult,
  repoWriteResultSchema,
  stepAgents,
  type VerificationCommandResult,
  type VerificationResult,
  type VerificationStatus,
  type WorkflowRun,
  type WorkflowStepId,
  verificationResultSchema,
} from "../domain/workflow.js";
import { callJsonLlmWithSchema, callTextLlm, getLlmUsageFromError, type LlmUsage } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";
import { getCurrentWorkspace } from "../services/workspaceService.js";
import { getSkillStepSpec } from "../skills/skillRegistry.js";
import {
  deriveRouterContext,
  verificationCommandPolicy,
} from "../services/stepRouter.js";
import { analyzeRouteBindings } from "../services/routeBindingAnalysis.js";

const execFileAsync = promisify(execFile);
const maxDiffBufferBytes = 2 * 1024 * 1024;
const maxWriterInputChars = 40_000;
const protectedWriterFilenames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
]);

type WorkflowStepRunOptions = {
  pullRequest?: {
    branch?: string;
    commitMessage?: string;
  };
};

const codeWriterBeginMarker = "<<<AI_DELIVERY_FILE_CONTENT_BEGIN>>>";
const codeWriterEndMarker = "<<<AI_DELIVERY_FILE_CONTENT_END>>>";
type GeneratedCodePatch = NonNullable<CodeGenerationPlan["patches"]>[number] & {
  skipped?: boolean;
  skipReason?: string;
};

function recordLlmUsage(agent: string, usage: LlmUsage) {
  recordMetric({
    agent,
    calls: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: usage.latencyMs,
    estimatedCost: 0,
  });
}

function buildMetricPayload(agent: string, calls: number, inputTokens: number, outputTokens: number, latencyMs: number) {
  return {
    agent,
    calls,
    inputTokens,
    outputTokens,
    latencyMs,
    estimatedCost: 0,
  };
}

function extractEmbeddedMetrics(value: unknown) {
  if (!value || typeof value !== "object" || !("__metrics" in value)) return [];
  const metrics = (value as { __metrics?: unknown }).__metrics;
  return Array.isArray(metrics) ? metrics : [];
}

const agentSpecs: Record<Exclude<WorkflowStepId, "requirement_intake" | "clarification" | "solution_design" | "verification" | "module_mapping">, {
  schema: z.ZodTypeAny;
  instruction: string;
  outputContract: string;
}> = {
  code_generation: {
    schema: llmCodeGenerationPlanSchema,
    instruction: [
      "本阶段同时负责定位代码、拆解任务、生成代码计划，并驱动后续受控 writer 真实写入文件。",
      "必须依据 runtime 文件列表、Agent Guide、历史案例、确认需求和生成方案判断目标文件；历史案例只能作参考，当前需求和当前代码优先。",
      "不要依赖或引用 module_mapping；新版 workflow 不再有独立定位代码阶段。",
      "",
      "## 任务拆解规则",
      "strategy 只能概括 tasks 中真实列出的工作；禁止在 strategy 中声称会做某一步，但 tasks 没有对应任务。",
      "每个 task 必须对应一个清晰可执行的文件级修改意图，不能只是“修改相关文件”。",
      "每个 task 必须填写 files、acceptanceCriteriaRefs、expectedChange、testRequired、testIntent。",
      "acceptanceCriteriaRefs 使用 solution_design.acceptanceCriteria 的 1-based 编号字符串，例如 [\"1\", \"3\"]；如果任务是技术支撑且不直接对应验收标准，必须在 expectedChange 说明支撑关系。",
      "expectedChange 必须说明目标文件要发生的具体变化，例如新增纯函数、接入组件展示、调整状态同步、补充边界处理。",
      "testIntent 必须说明要测试什么；testRequired=false 时必须说明为什么无需新增/修改测试。",
      "testRequired=true 时必须填写 testFiles，列出本阶段要一并创建或修改的单元测试/组件测试文件；不要把补测试留给后续阶段。",
      "",
      "## 文件路径规则",
      "files/testFiles 只能填写具体文件路径，不能填写目录路径，不能以 / 结尾，路径末尾必须包含具体文件名。",
      "优先使用 runtime.list_files/read_agent_guide 中真实存在的文件；新增文件必须放在项目现有目录约定下，并能从任务解释看出必要性。",
      "页面/路由类需求必须修改当前路由入口已经 import 的真实页面组件；不要新建一个同名平行页面来绕开现有路由。",
      "例如项目已存在并由入口引用 frontend/src/routes/Article/Article.jsx 时，禁止新增 frontend/src/routes/Article.jsx 作为替代实现。",
      "新增组件或 helper 后，必须在真实页面组件中 import 并使用；否则不算完成接入。",
      "绝对不要使用绝对路径或包含 .. 的路径。",
      "除非需求明确涉及入口挂载、Provider 或 Router，不要修改 main/index/app/router 入口文件。",
      "",
      "## 覆盖要求",
      "所有 acceptanceCriteria 至少要被一个 task 的 acceptanceCriteriaRefs 覆盖；若某条验收无需代码改动，创建一个验证/说明 task 并在 expectedChange 中说明。",
      "用户确认的 decisions 和 runtimeMemory 中的约束必须反映到 tasks、expectedChange 或 testIntent。",
      "计划阶段不要声称已生成真实 diff、已修改文件、已落盘或已补测试；真实写入会由后续受控 writer 基于你的计划逐文件完成。",
      "禁止在 JSON 字段里输出大段源码；默认不要输出 patches。只有当片段能帮助审查且不超过 200 字符时，才可在 patches.content 中输出关键行/小片段；该片段仅用于展示，不代表实际文件变更。",
    ].join("\n"),
    outputContract: "输出 JSON：strategy:string；tasks:Array<{id,title,files,acceptanceCriteriaRefs,expectedChange,testRequired,testIntent,testFiles?,coverLayer?}>。files/testFiles 的每一项都必须是具体文件路径，不得是目录。testRequired=true 时 testFiles 必填且 testIntent 必须描述测试目标。patches 可选且仅用于 <=200 字符的展示片段，不是可落盘补丁。",
  },
  repo_write: {
    schema: repoWriteResultSchema,
    instruction: "Legacy 兼容：生成可审计的仓库写入计划。新 workflow 已并入生成代码阶段。当前 runtime 默认不会自动写文件，所以必须把 mode 设为 \"planned\"，并把变更放进 pendingChanges；不要声称已经落盘。如果 runtime trace 中包含 write_file/git_checkout_branch 调用并且成功，可以把 mode 设为 \"applied\" 并把变更放进 appliedChanges。",
    outputContract: "输出 JSON：branch、mode (planned|applied)、pendingChanges、appliedChanges、diffSummary、filesChanged（向后兼容，可与 pendingChanges 等价）。不要生成 PR 链接。",
  },
  code_review: {
    schema: codeReviewResultSchema,
    instruction: [
      "审查生成代码的变更。必须基于真实 diff、changedFiles、codeGenerationTasks 和 acceptanceCriteria 进行审查，不要凭空评价未变更文件。",
      "重点：验收标准满足度 > 功能正确性 > 安全/副作用 > 测试覆盖 > 可维护性 > 风格。",
      "每个 blocker/major finding 必须说明它违反了哪条验收标准、确认决策或代码任务；无法映射时标记为 implementation-risk。",
      "常见必须检查的问题：遗留调试注释或 TODO、幽灵代码/未使用变量、只改 UI 未接数据、测试文件没有断言、mock 掩盖真实逻辑、硬编码临时值、错误边界缺失、异步状态未处理、类型绕过、diff 中出现无关重构。",
      "blocker/major findings 必须输出 decision=request-changes。只有没有 blocker/major 且 checklist 无 failed 时才能 decision=approve。",
      "不要输出大段源码，只引用文件路径、行号、摘要和建议。字段名必须严格使用 outputContract，不要使用 path/lines/suggestion/message 等别名。",
    ].join("\n"),
    outputContract: "输出 JSON object：summary:string；decision:\"approve\"|\"request-changes\"；findings:Array<{id:string,severity:\"blocker\"|\"major\"|\"minor\"|\"nit\",title:string,detail:string,file?:string,line?:number,recommendation?:string}>；checklist:Array<{id:string,label:string,status:\"passed\"|\"warning\"|\"failed\"|\"not_applicable\",detail?:string}>；reviewedFiles:string[]；riskAreas:string[]。checklist 不能是字符串数组。",
  },
  pull_request: {
    schema: pullRequestResultSchema,
    instruction: "生成 PR 草稿信息和提交前 checklist。若 runtime 没有真实创建 PR，必须使用 pending://pull-request。",
    outputContract: "输出 JSON：title, url, status, checklist。若没有真实 PR URL，url 使用 pending://pull-request 并把 status 设为 draft。",
  },
};

function buildStepPrompt(stepId: Exclude<WorkflowStepId, "requirement_intake" | "clarification" | "solution_design" | "verification" | "module_mapping">, run: WorkflowRun) {
  const spec = agentSpecs[stepId];
  let instruction = spec.instruction;
  let outputContract = spec.outputContract;

  const skillSpec = getSkillStepSpec(run, stepId, getCurrentWorkspace() ?? undefined);
  if (skillSpec.instructionAddon) {
    instruction = `${instruction}\n${skillSpec.instructionAddon}`;
  }
  if (skillSpec.outputContractAddon) {
    outputContract = `${outputContract}\n${skillSpec.outputContractAddon}`;
  }

  return { spec, instruction, outputContract, skillSpec };
}

function isCodeReviewRetryGeneration(run: WorkflowRun) {
  const step = run.steps.find((item) => item.id === "code_generation");
  return Boolean(step?.interventions?.some((message) =>
    message.role === "system" &&
    message.content.includes("entry=code_review_retry") &&
    message.content.includes("code_generation_should_use_code_review_context=true"),
  ));
}

function getCodeReviewRetryContext(run: WorkflowRun) {
  const review = run.steps.find((item) => item.id === "code_review")?.output as Record<string, unknown> | undefined;
  if (!review) {
    return {
      targetFiles: [] as string[],
      findings: [] as Array<Record<string, unknown>>,
      failedChecklist: [] as Array<Record<string, unknown>>,
      summary: "",
    };
  }

  const findings = Array.isArray(review.findings)
    ? review.findings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const failedChecklist = Array.isArray(review.checklist)
    ? review.checklist.filter((item): item is Record<string, unknown> => (
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).status === "failed"
    ))
    : [];
  const reviewedFiles = Array.isArray(review.reviewedFiles)
    ? review.reviewedFiles.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const findingFiles = findings
    .map((finding) => finding.file)
    .filter((file): file is string => typeof file === "string" && file.trim().length > 0);

  return {
    targetFiles: Array.from(new Set(findingFiles.length > 0 ? findingFiles : reviewedFiles)),
    findings,
    failedChecklist,
    summary: typeof review.summary === "string" ? review.summary : "",
  };
}

export async function runWorkflowStepAgent(stepId: WorkflowStepId, run: WorkflowRun, options?: WorkflowStepRunOptions) {
  if (stepId === "requirement_intake" || stepId === "clarification" || stepId === "solution_design") {
    throw new Error(`Unsupported generic workflow step: ${stepId}`);
  }
  if (stepId === "module_mapping") {
    throw new Error("module_mapping has been removed from the current workflow. Code location is handled inside code_generation.");
  }

  // verification 是特殊 step：不用 LLM 当事实来源，而是先真实执行命令再让 LLM 做 diagnosis。
  if (stepId === "verification") {
    return runVerificationStep(run);
  }

  // Legacy repo_write：旧 run 如果还有该 step，则沿用历史行为。新 run 已并入 code_generation。
  if (stepId === "repo_write") {
    const applied = await tryApplyCodegenPatches(run);
    if (applied) {
      return applied;
    }
  }

  // pull_request: 优先真实执行 git 操作 + GitHub API 创建 PR
  if (stepId === "pull_request") {
    return runPullRequestStep(run, options?.pullRequest);
  }

  // code_review: 读取真实 diff 内容作为审查上下文
  if (stepId === "code_review") {
    return runCodeReviewStep(run);
  }

  // 三层叠加 prompt:
  // layer 1: agentSpecs 的基础 instruction
  // layer 2: stepRouter 的 scope/pattern 动态 addon
  // layer 3: Skill 注入 addon
  const { spec, instruction, outputContract, skillSpec } = buildStepPrompt(stepId, run);
  const isCodeReviewRetry = stepId === "code_generation" && isCodeReviewRetryGeneration(run);
  const codeReviewRetryContext = isCodeReviewRetry ? getCodeReviewRetryContext(run) : null;
  const runtimeInstruction = stepId === "code_generation"
    ? [
      instruction,
      isCodeReviewRetry
        ? [
          "## 本次生成入口",
          "本次是从代码审查 Retry 回到生成代码阶段，语义是 review fixup，不是完整重放。",
          "只生成修复代码审查意见所必需的最小任务，不要重新列出已经完成且无需修改的原始任务。",
          "优先修改 stepContext.reviewRetry.targetFiles 中的文件；只有当审查意见明确要求新增测试/组件/helper 时，才新增必要文件。",
          "必须逐条处理 stepContext.reviewRetry.findings 和 failedChecklist。",
          "不要只输出“已修复”，必须让受控 writer 真实编辑/新建文件，并确保下一轮 diff 能看到本次增量修复。",
        ].join("\n")
        : [
          "## 本次生成入口",
          "本次是按需求生成或普通重放，不是代码审查 Retry。",
          "禁止引用、总结、延续或暗示任何代码审查意见；即使历史 workflow 曾有 code_review 输出，也不得作为本阶段输入。",
          "必须只基于当前需求、确认结果、生成方案、真实文件结构和注入 Skill 生成代码计划。",
        ].join("\n"),
    ].join("\n")
    : instruction;

  const workspace = getCurrentWorkspace();
  const routeBindings = stepId === "code_generation" && workspace
    ? analyzeRouteBindings(workspace)
    : [];
  const routeBindingReadFiles = routeBindings.flatMap((binding) => [binding.importerFile, binding.boundFile]);
  const codeGenerationReadFiles = stepId === "code_generation"
    ? Array.from(new Set([
      ...routeBindingReadFiles,
      ...(codeReviewRetryContext?.targetFiles ?? []),
    ]))
    : [];

  const result = await runSimpleAgentRuntime(stepId, run, spec.schema, {
    instruction: runtimeInstruction,
    outputContract,
    extraReadFiles: stepId === "code_generation" ? codeGenerationReadFiles : undefined,
    extraContext: stepId === "code_generation"
      ? {
        generationMode: isCodeReviewRetry ? "code-review-retry" : "requirement",
        reviewRetry: codeReviewRetryContext,
        routeBindings,
        routeBindingRule: "页面/路由类需求必须修改 routeBindings.boundFile 指向的真实渲染组件。禁止新增同名平行页面或只修改未被入口 import 的文件。",
      }
      : undefined,
  });

  const llmMetric = buildMetricPayload(
    stepAgents[stepId],
    1,
    result.tokens.inputTokens,
    result.tokens.outputTokens,
    result.tokens.latencyMs,
  );
  recordMetric(llmMetric);

  const output = result.output as CodeGenerationPlan | Record<string, unknown>;
  const repoWriteResult = stepId === "code_generation"
    ? await runCodeWriterFromPlan(run, output as CodeGenerationPlan)
    : null;
  if (stepId === "code_generation" && !hasReviewableDiff(repoWriteResult)) {
    throw new Error("生成代码未产生可审查 diff，已中止。请检查 writer 输出或重试当前阶段。");
  }

  return {
    ...(output as Record<string, unknown>),
    ...(repoWriteResult ?? {}),
    ...(repoWriteResult ? { repoWriteResult } : {}),
    __metrics: [
      llmMetric,
      ...extractEmbeddedMetrics(repoWriteResult),
    ],
    runtimeTrace: {
      ...result.trace,
      ...(repoWriteResult?.runtimeTrace && typeof repoWriteResult.runtimeTrace === "object" && "toolCalls" in repoWriteResult.runtimeTrace
        ? { toolCalls: [...(result.trace.toolCalls ?? []), ...((repoWriteResult.runtimeTrace as { toolCalls?: unknown[] }).toolCalls ?? [])] }
        : {}),
      selectedSkillId: skillSpec.skillId,
      skillMatchReason: skillSpec.skillMatchReason,
      skillDiagnostics: skillSpec.skillDiagnostics,
    },
  };
}

/**
 * Verification 专用执行器：
 *  1. 用 detect_workflow_commands 探测 typecheck/lint/test/build 候选；
 *  2. 真实串行执行，把执行结果作为 commands[] 注入返回；
 *  3. status 字段由真实 exitCode 决定，LLM 仅做 diagnosis（短摘要）。
 *
 * 这样 verification 的通过/失败完全是事实来源，LLM 不能把失败说成通过。
 */
/** 从 code_generation 提取声明的单元测试文件 */
function getGeneratedTestFiles(run: WorkflowRun): string[] {
  const codegen = run.steps.find((s) => s.id === "code_generation")?.output as CodeGenerationPlan | undefined;
  return [...new Set(codegen?.tasks?.flatMap((t) => (t as { testFiles?: string[] }).testFiles ?? []) ?? [])].filter(Boolean);
}

async function runVerificationStep(run: WorkflowRun) {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error("No workspace is available for verification step.");
  }

  const testFiles = getGeneratedTestFiles(run);
  const detection = await runRuntimeTool(workspace, "detect_workflow_commands", { projectId: run.projectId });
  const candidates = (detection.output as {
    candidates: Array<{ label: string; available: boolean; argv: string[]; command?: string; description: string; reason: string; cwd?: string; scope?: string | null }>;
  }).candidates ?? [];

  // 动态:基于 pattern/scope + Skill addon + 是否有 testFiles 决定命令策略
  const ctx = deriveRouterContext(run);
  const skillSpecForVerify = getSkillStepSpec(run, "verification", getCurrentWorkspace() ?? undefined);
  const policy = verificationCommandPolicy(ctx, skillSpecForVerify.verificationPolicyAddon);
  // 有生成测试文件时，test 提升为 required
  if (testFiles.length > 0 && !policy.required.includes("npm:test")) {
    policy.required = [...policy.required, "npm:test"];
  }

  const commandResults: VerificationCommandResult[] = [];
  const toolTraces = [detection];

  // 顺序执行:typecheck → lint → test → build。
  // required 命令即使 not_configured 也明确记录,optional 命令仅 available 时执行。
  const order = ["npm:typecheck", "npm:lint", "npm:test", "npm:build"];
  const orderedCandidates = [
    ...order.map((label) => candidates.find((c) => c.label === label)).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)),
    ...candidates.filter((candidate) => candidate.label.startsWith("custom:")),
  ];
  for (const candidate of orderedCandidates) {
    const label = candidate.label;
    if (!candidate) continue;

    const isCustomCommand = label.startsWith("custom:");
    const isRequired = isCustomCommand || policy.required.includes(label);
    const isOptional = policy.optional.includes(label);
    if (!isRequired && !isOptional) continue;

    if (!candidate.available) {
      // 仅 required 命令未配置时记录 not_configured;optional 不记录避免噪音。
      if (isRequired) {
        commandResults.push({
          label: labelToVerificationLabel(label),
          command: candidate.argv.join(" "),
          cwd: workspace.workspaceDir ?? "",
          exitCode: null,
          durationMs: 0,
          status: "not_configured",
          stdoutPreview: "",
          stderrPreview: candidate.reason,
        });
      }
      continue;
    }

    const call = await runRuntimeTool(workspace, "run_command", {
      label,
      cwd: candidate.cwd,
      command: candidate.command,
      description: candidate.description,
    });
    toolTraces.push(call);
    const cmd = call.output as {
      label: string;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number;
      status: VerificationStatus;
      stdoutPreview: string;
      stderrPreview: string;
      warningKind?: VerificationCommandResult["warningKind"];
      warningSummary?: string;
      failureKind?: VerificationCommandResult["failureKind"];
      failureSummary?: string;
      suggestedAction?: string;
    };
    commandResults.push({
      label: labelToVerificationLabel(label),
      command: cmd.command,
      cwd: cmd.cwd,
      exitCode: cmd.exitCode,
      durationMs: cmd.durationMs,
      status: cmd.status,
      stdoutPreview: cmd.stdoutPreview,
      stderrPreview: cmd.stderrPreview,
      warningKind: cmd.warningKind,
      warningSummary: cmd.warningSummary,
      failureKind: cmd.failureKind,
      failureSummary: cmd.failureSummary,
      suggestedAction: cmd.suggestedAction,
    });
  }

  function statusFor(label: VerificationCommandResult["label"]): VerificationStatus {
    const items = commandResults.filter((c) => c.label === label);
    if (items.length === 0) return "not_configured";
    if (items.some((c) => c.status === "failed")) return "failed";
    if (items.every((c) => c.status === "not_configured")) return "not_configured";
    if (items.some((c) => c.status === "passed")) return "passed";
    return items[0].status;
  }

  // unitTests: 有真实命令结果时优先用执行结果；只有无 testFiles 且无测试命令执行时才 skipped
  const unitTestResult = statusFor("unit_tests");
  const noTestDeclared = testFiles.length === 0 && unitTestResult === "not_configured";
  const result: VerificationResult = {
    typecheck: statusFor("typecheck"),
    lint: statusFor("lint"),
    unitTests: noTestDeclared ? "skipped" : unitTestResult,
    build: statusFor("build"),
    coverage: null,
    testSuites: [],
    commands: commandResults,
    diagnosis: noTestDeclared
      ? "本次生成代码未声明单元测试文件，质量门禁默认放行。"
      : buildHeuristicDiagnosis(commandResults),
  };

  const parsed = verificationResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`verificationResult schema validation failed: ${parsed.error.message}`);
  }

  recordMetric({
    agent: stepAgents.verification,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: commandResults.reduce((acc, c) => acc + c.durationMs, 0),
    estimatedCost: 0,
  });

  return {
    ...parsed.data,
    runtimeTrace: {
      runtime: "simple-agent-runtime" as const,
      workspaceId: workspace.id,
      workspaceDir: workspace.workspaceDir,
      observations: [
        `verification 真实执行了 ${commandResults.filter((c) => c.status === "passed" || c.status === "failed").length} 个命令`,
        `检测到的脚本：${formatDetectedScripts((detection.output as { detectedScripts?: unknown }).detectedScripts)}`,
      ],
      toolCalls: toolTraces,
      selectedSkillId: skillSpecForVerify.skillId,
      skillMatchReason: skillSpecForVerify.skillMatchReason,
      skillDiagnostics: skillSpecForVerify.skillDiagnostics,
    },
    runId: run.id,
  };
}

function formatDetectedScripts(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([scope, scripts]) => {
        const list = Array.isArray(scripts) ? scripts.join(", ") : String(scripts ?? "");
        return list ? `${scope}: ${list}` : `${scope}: 无`;
      });
    return entries.length > 0 ? entries.join("；") : "无";
  }
  return "无";
}

function labelToVerificationLabel(label: string): VerificationCommandResult["label"] {
  if (label === "npm:typecheck") return "typecheck";
  if (label === "npm:lint") return "lint";
  if (label === "npm:test") return "unit_tests";
  if (label === "npm:build") return "build";
  return "custom";
}

function buildHeuristicDiagnosis(results: VerificationCommandResult[]): string {
  const failed = results.filter((c) => c.status === "failed");
  if (failed.length === 0) return "";
  const lines = failed.map((c) => {
    if (c.failureSummary) {
      return `${c.label}(exit=${c.exitCode}): ${c.failureSummary}${c.suggestedAction ? ` 建议：${c.suggestedAction}` : ""}`;
    }
    const tail = c.stderrPreview.split(/\r?\n/).slice(-3).join(" ");
    return `${c.label}(exit=${c.exitCode}): ${tail}`;
  });
  return lines.join("\n");
}

function hasReviewableDiff(result: (RepoWriteResult & { runtimeTrace: unknown }) | null): result is RepoWriteResult & { runtimeTrace: unknown } {
  return Boolean(
    result?.filesChanged?.some((file) => file.contentPreview?.trim() || file.additions > 0 || file.deletions > 0),
  );
}

export async function runCodeReviewStep(run: WorkflowRun) {
  const { spec, instruction, outputContract, skillSpec } = buildStepPrompt("code_review", run);
  const workspace = getCurrentWorkspace();
  const routeBindings = workspace ? analyzeRouteBindings(workspace) : [];
  const routeBindingReadFiles = routeBindings.flatMap((binding) => [binding.importerFile, binding.boundFile]);
  const codegenOutput = run.steps.find((s) => s.id === "code_generation")?.output as (CodeGenerationPlan & {
    repoWriteResult?: RepoWriteResult;
    filesChanged?: FileChange[];
    appliedChanges?: FileChange[];
  }) | undefined;
  const legacyRepoResult = run.steps.find((s) => s.id === "repo_write")?.output as RepoWriteResult | undefined;
  const repoResult = codegenOutput?.repoWriteResult
    ?? (codegenOutput?.filesChanged || codegenOutput?.appliedChanges ? codegenOutput as unknown as RepoWriteResult : undefined)
    ?? legacyRepoResult;
  const storedReviewChanges = repoResult?.appliedChanges?.length
    ? repoResult.appliedChanges
    : repoResult?.filesChanged ?? [];
  const workspaceChangedFiles = workspace?.hasRepository
    ? await getWorkspaceChangedFiles(workspace.workspaceDir)
    : [];
  const reviewChanges = Array.from(new Map([
    ...storedReviewChanges.map((change) => [change.path, change] as const),
    ...workspaceChangedFiles.map((file) => [file, {
      path: file,
      changeType: "modified" as const,
      additions: 0,
      deletions: 0,
      contentPreview: "",
    }] as const),
  ]).values());

  // 收集变更文件的真实内容作为审查上下文
  const diffs: string[] = [];
  const changedFiles: Array<FileChange & { hasDiff: boolean; diffSource: "workspace" | "stored" | "missing" }> = [];
  if (reviewChanges.length) {
    for (const change of reviewChanges) {
      const workspaceDiff = workspace?.hasRepository
        ? await getWorkspaceReviewDiff(workspace.workspaceDir, change.path)
        : "";
      const effectiveDiff = workspaceDiff || change.contentPreview || "";
      diffs.push(`--- ${change.path} (${change.changeType}, +${change.additions}/-${change.deletions})`);
      if (effectiveDiff) diffs.push(effectiveDiff);
      changedFiles.push({
        ...change,
        hasDiff: Boolean(effectiveDiff.trim()),
        diffSource: workspaceDiff ? "workspace" : change.contentPreview ? "stored" : "missing",
      });
    }
  }

  const result = await runSimpleAgentRuntime("code_review", run, spec.schema, {
    instruction: [
      instruction,
      "审查时必须优先使用 stepContext.reviewDiffs 和 stepContext.changedFiles；reviewDiffs 来自当前工作区 git diff，只有 git diff 不可用时才回退到写入阶段缓存。",
      "如果 changedFiles 中某个文件 hasDiff=false，必须在 checklist 中标记 diff 缺失并避免给出虚构结论。",
      "如果某个 codeGenerationTask 的 testRequired=true，但 changedFiles/reviewDiffs 中没有对应测试文件或有效断言，必须给出 finding。",
      "如果 codeGenerationStrategy 声称完成了某些步骤，但 codeGenerationTasks 或 changedFiles/reviewDiffs 没有对应证据，必须 decision=request-changes。",
      "如果某个 codeGenerationTask 声称要完成的文件、组件接入或测试没有出现在 changedFiles/reviewDiffs，也没有当前文件证据支撑，必须 decision=request-changes。",
      "审查不允许只针对已经完成的部分给出通过结论；只要存在“无法确认”“未出现在本次 diff”“缺少证据”的验收项或任务，就必须要求修改。",
    ].join("\n"),
    outputContract,
    extraReadFiles: routeBindingReadFiles,
    extraContext: {
      changedFiles: changedFiles.map((change) => ({
        path: change.path,
        changeType: change.changeType,
        additions: change.additions,
        deletions: change.deletions,
        hasDiff: change.hasDiff,
        diffSource: change.diffSource,
      })),
      reviewDiffs: diffs,
      codeGenerationStrategy: codegenOutput?.strategy ?? "",
      codeGenerationTasks: codegenOutput?.tasks ?? [],
      acceptanceCriteria: (run.steps.find((s) => s.id === "solution_design")?.output as { acceptanceCriteria?: string[] } | undefined)?.acceptanceCriteria ?? [],
      confirmedDecisions: (run.steps.find((s) => s.id === "clarification")?.output as { decisions?: unknown[] } | undefined)?.decisions ?? [],
      diffSummary: repoResult?.diffSummary ?? "",
      routeBindings,
      routeBindingRule: "审查页面/路由类变更时，必须确认 changedFiles 中的页面文件是 routeBindings.boundFile 指向的真实渲染组件，或新增组件/helper 已被该真实组件调用。",
    },
  });

  const reviewMetric = buildMetricPayload(
    stepAgents.code_review,
    1,
    result.tokens.inputTokens,
    result.tokens.outputTokens,
    result.tokens.latencyMs,
  );
  recordMetric(reviewMetric);

  return {
    ...(result.output as Record<string, unknown>),
    __metrics: [reviewMetric],
    runtimeTrace: {
      ...result.trace,
      observations: [
        ...result.trace.observations,
        `审查了 ${reviewChanges.length} 个变更文件`,
      ],
      selectedSkillId: skillSpec.skillId,
      skillMatchReason: skillSpec.skillMatchReason,
      skillDiagnostics: skillSpec.skillDiagnostics,
    },
  };
}

async function runCodeWriterFromPlan(
  run: WorkflowRun,
  plan: CodeGenerationPlan,
): Promise<(RepoWriteResult & { runtimeTrace: unknown }) | null> {
  const workspace = getCurrentWorkspace();
  if (!workspace?.workspaceDir) {
    throw new Error("No workspace is available for code writer.");
  }

  // 补齐缺失的测试文件路径（testRequired=true 但无 testFiles）
  const tasksMissingTests = (plan.tasks ?? []).filter(
    (t) => t.testRequired && getTaskTestFiles(t).length === 0,
  );
  if (tasksMissingTests.length > 0) {
    const derived = await deriveMissingTestFiles(run, tasksMissingTests, workspace);
    for (const dt of derived) {
      const task = plan.tasks?.find((t) => t.id === dt.taskId);
      if (task) (task as Record<string, unknown>).testFiles = dt.testFiles;
    }
  }

  const targetFiles = Array.from(new Set(
    (plan.tasks ?? []).flatMap((task) => [...(task.files ?? []), ...getTaskTestFiles(task)]),
  )).filter(Boolean);
  if (targetFiles.length === 0) {
    throw new Error("生成代码没有提供目标文件，无法写入。");
  }

  const workspaceRoot = path.resolve(workspace.workspaceDir);
  const generatedPatches: GeneratedCodePatch[] = [];

  for (const relativePath of targetFiles) {
    assertSafeWorkspacePath(workspaceRoot, relativePath);
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const exists = existsSync(absolutePath);
    if (exists && (await stat(absolutePath)).isDirectory()) {
      throw new Error(`生成代码目标路径是目录,不是文件: ${relativePath}`);
    }
    const originalContent = exists ? await readFile(absolutePath, "utf-8") : "";
    if (originalContent.length > maxWriterInputChars) {
      throw new Error(`生成代码拒绝处理过大的文件: ${relativePath} (${originalContent.length} chars)`);
    }

    const relatedTasks = (plan.tasks ?? []).filter((task) =>
      task.files?.includes(relativePath) || getTaskTestFiles(task).includes(relativePath),
    );
    const isTestFile = relatedTasks.some((task) => getTaskTestFiles(task).includes(relativePath));
    const workflowContext = buildCodeWriterWorkflowContext(run, relatedTasks);
    const writerMessages = [
      {
        role: "system" as const,
        content: [
          "你是代码写入器。",
          "你会收到单个目标文件的当前完整内容和相关任务。",
          "你必须根据相关任务的 expectedChange、acceptanceCriteriaRefs、testIntent 真实修改当前文件。",
          "返回该文件修改后的完整内容，不要输出 Markdown，不要解释。",
          `输出必须以独立一行 ${codeWriterBeginMarker} 开始，以独立一行 ${codeWriterEndMarker} 结束。`,
          "边界标记之外不要输出任何字符。",
          "边界标记中间只能放最终文件内容本身。",
          "必须保留与任务无关的现有逻辑和样式。",
          "必须遵守 workflowContext.confirmedDecisions 和 workflowContext.dataContract 中的约束。",
          isTestFile
            ? "当前目标文件是测试文件。必须补齐与相关任务对应的单元测试或组件测试，覆盖 testIntent、相关验收标准和边界场景。不要写空 smoke test。"
            : "当前目标文件是实现文件。若相关任务需要测试，测试会在同一生成代码阶段由对应 testFiles 一并写入；实现必须让相关验收标准可被测试验证。",
          "如果目标是新增文件，originalContent 为空。",
          "如果你无法完成某个任务，也必须输出最接近正确的完整文件内容；不要只输出说明。",
          "不要修改 package lock、.env、node_modules 或 .git 内文件。",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          runTitle: run.title,
          workflowContext,
          strategy: plan.strategy,
          file: {
            path: relativePath,
            exists,
            role: isTestFile ? "test" : "implementation",
            originalContent,
          },
          tasks: relatedTasks,
        }),
      },
    ];

    const nextContent = preserveEofNewlineStyle(
      await callCodeWriterText(writerMessages, relativePath),
      originalContent,
      exists,
    );
    if (nextContent === originalContent) {
      // 单文件 no-op 不立即失败——跳过该文件，继续处理其他 target
      generatedPatches.push({
        path: relativePath,
        changeType: exists ? "modified" : "created",
        content: nextContent,
        skipped: true,
        skipReason: "writer 输出与原文件一致，已跳过",
      });
      continue;
    }

    generatedPatches.push({
      path: relativePath,
      changeType: exists ? "modified" : "created",
      content: nextContent,
    });
  }

    // 过滤掉 skipped patches，只 apply 真实变更
    const realPatches = generatedPatches.filter((p) => !(p as Record<string, unknown>).skipped);
    const skippedCount = generatedPatches.length - realPatches.length;

    if (realPatches.length === 0) {
      throw new Error(`生成代码未产生可审查 diff，已中止。所有 ${generatedPatches.length} 个目标文件均未改变。`);
    }

    validateCodeGenerationPlanApplied(plan, realPatches);

    const applied = await tryApplyCodegenPatches(run, {
      ...plan,
      patches: realPatches,
    }, {
      allowOverwrite: true,
      diffPreview: isCodeReviewRetryGeneration(run) ? "incremental" : "workspace",
    });

    if (applied && skippedCount > 0) {
      (applied.runtimeTrace as Record<string, unknown>).observations = [
        ...((applied.runtimeTrace as Record<string, unknown>).observations as string[] ?? []),
        `${skippedCount} 个文件 writer 输出与原文件一致，已跳过`,
      ];
    }

    return applied;
  }


const testFileDerivationSchema = zod.object({
  testTargets: zod.array(zod.object({
    taskId: zod.string().min(1),
    testFiles: zod.array(zod.string().min(1)).min(1),
    reason: zod.string().min(1),
  })).min(1),
});

async function deriveMissingTestFiles(
  run: WorkflowRun,
  tasks: CodeGenerationPlan["tasks"],
  workspace: NonNullable<ReturnType<typeof getCurrentWorkspace>>,
): Promise<Array<{ taskId: string; testFiles: string[]; reason: string }>> {
  const fileTree = workspace.repositoryScan?.fileTree ?? [];
  const testPatterns = fileTree.filter((f) => /test|spec|__tests__/.test(f)).slice(0, 10);
  try {
    const result = await callJsonLlmWithSchema([
      {
        role: "system",
        content: [
          "你是测试文件路径推导器。",
          "根据任务标题、实现文件路径、项目文件树、现有测试目录风格，推导最合理的测试文件路径。",
          "必须结合 expectedChange/testIntent 判断测试类型；不要把实现文件目录本身当成测试文件。",
          "如果已有相邻测试文件，优先复用或修改已有测试文件。",
          "如果没有测试文件，按项目约定新增，例如：",
          "  src/utils/foo.ts → src/utils/__tests__/foo.test.ts",
          "  backend/models/Comment.js → backend/models/__tests__/Comment.test.js",
          "禁止绝对路径和 ..。不要输出源码，只输出 JSON。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          tasks: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            files: t.files,
            testRequired: t.testRequired,
            expectedChange: (t as { expectedChange?: string }).expectedChange,
            testIntent: (t as { testIntent?: string }).testIntent,
          })),
          fileTree: fileTree.slice(0, 30),
          existingTestPatterns: testPatterns,
        }),
      },
    ], testFileDerivationSchema, { label: "Test File Deriver" });

    recordLlmUsage(stepAgents.code_generation, {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    });

    return result.content.testTargets.map((t) => ({
      taskId: t.taskId,
      testFiles: t.testFiles,
      reason: t.reason,
    }));
  } catch (error) {
    const usage = getLlmUsageFromError(error);
    if (usage) recordLlmUsage(stepAgents.code_generation, usage);
    // LLM 推导失败时返回空——最终还是会在 apply 阶段因缺 testFiles 而 failed
    return [];
  }
}

async function callCodeWriterText(
  messages: Parameters<typeof callTextLlm>[0],
  relativePath: string,
) {
  const maxAttempts = 2;
  let retryMessages = messages;
  let lastRawContent = "";
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const writer = await callTextLlm(retryMessages)
      .then((result) => {
        recordLlmUsage(stepAgents.code_generation, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
        });
        return result;
      })
      .catch((error) => {
        const usage = getLlmUsageFromError(error);
        if (usage) recordLlmUsage(stepAgents.code_generation, usage);
        throw error;
      });

    lastRawContent = writer.rawContent;

    try {
      return extractCodeWriterContent(writer.rawContent, relativePath);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "代码写入未按协议返回文件内容";
      retryMessages = [
        ...messages,
        { role: "assistant", content: writer.rawContent },
        {
          role: "user",
          content: [
            lastError,
            `请重新输出 ${relativePath} 的完整文件内容。`,
            `必须以独立一行 ${codeWriterBeginMarker} 开始，以独立一行 ${codeWriterEndMarker} 结束。`,
            "不要输出 unified diff、patch、Markdown 代码块、JSON、解释或边界标记之外的任何字符。",
            "边界标记中间只能是最终文件源码本身，不能包含 diff --git、@@、---、+++、行首 + / - 的补丁文本。",
          ].join("\n"),
        },
      ];
    }
  }

  throw new Error([
    `代码写入:${relativePath} returned invalid file content after ${maxAttempts} attempt(s).`,
    lastError,
    `Last raw response: ${lastRawContent}`,
  ].join("\n"));
}

function buildCodeWriterWorkflowContext(run: WorkflowRun, relatedTasks: CodeGenerationPlan["tasks"] = []) {
  const pickStep = (id: WorkflowStepId) => run.steps.find((step) => step.id === id)?.output;
  const workspace = getCurrentWorkspace();
  const solution = pickStep("solution_design") as { acceptanceCriteria?: string[]; dataContract?: unknown } | undefined;
  const criteria = solution?.acceptanceCriteria ?? [];
  const criterionRefs = new Set(relatedTasks.flatMap((task) =>
    (task as { acceptanceCriteriaRefs?: string[] }).acceptanceCriteriaRefs ?? [],
  ));
  const relatedAcceptanceCriteria = criteria
    .map((text, index) => ({ ref: String(index + 1), text }))
    .filter((item) => criterionRefs.size === 0 || criterionRefs.has(item.ref));
  const clarification = pickStep("clarification") as { decisions?: Array<{ title: string; finalAnswer: string }> } | undefined;

  return {
    requirement: pickStep("requirement_intake"),
    clarification,
    solution,
    confirmedDecisions: clarification?.decisions ?? [],
    dataContract: solution?.dataContract ?? {},
    relatedAcceptanceCriteria,
    routeBindings: workspace ? analyzeRouteBindings(workspace) : [],
  };
}

function getTaskTestFiles(task: CodeGenerationPlan["tasks"][number]) {
  return (task as { testFiles?: string[] }).testFiles ?? [];
}

function validateCodeGenerationPlanApplied(plan: CodeGenerationPlan, patches: GeneratedCodePatch[]) {
  const changedFiles = new Set(patches.map((patch) => patch.path));
  const uncoveredTasks = (plan.tasks ?? [])
    .filter((task) => {
      const declaredFiles = [...(task.files ?? []), ...getTaskTestFiles(task)];
      return declaredFiles.length === 0 || declaredFiles.every((file) => !changedFiles.has(file));
    })
    .map((task) => task.id);

  const missingTestFiles = (plan.tasks ?? [])
    .filter((task) => task.testRequired)
    .flatMap((task) => getTaskTestFiles(task).map((file) => ({ taskId: task.id, file })))
    .filter((item) => !changedFiles.has(item.file))
    .map((item) => `${item.taskId}:${item.file}`);

  if (uncoveredTasks.length > 0 || missingTestFiles.length > 0) {
    const reasons = [
      uncoveredTasks.length > 0
        ? `计划声明但没有真实写入的任务: ${uncoveredTasks.join(", ")}`
        : "",
      missingTestFiles.length > 0
        ? `声明需补测试但没有真实写入的测试文件: ${missingTestFiles.join(", ")}`
        : "",
    ].filter(Boolean);
    throw new Error(`生成代码计划与实际写入不一致，已中止进入代码审查。${reasons.join("；")}`);
  }
}

function preserveEofNewlineStyle(content: string, originalContent: string, exists: boolean) {
  if (!exists) return content;

  const originalNewline = originalContent.endsWith("\r\n")
    ? "\r\n"
    : originalContent.endsWith("\n")
      ? "\n"
      : "";

  if (originalNewline && !content.endsWith("\n")) {
    return `${content}${originalNewline}`;
  }

  if (!originalNewline && content.endsWith("\n")) {
    return content.replace(/\r?\n$/, "");
  }

  return content;
}

function extractCodeWriterContent(rawContent: string, relativePath: string) {
  const beginIndex = rawContent.indexOf(codeWriterBeginMarker);
  const endIndex = rawContent.lastIndexOf(codeWriterEndMarker);
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    throw new Error(`代码写入未按协议返回文件内容: ${relativePath}`);
  }

  const contentStart = beginIndex + codeWriterBeginMarker.length;
  let content = rawContent.slice(contentStart, endIndex);
  if (content.startsWith("\r\n")) content = content.slice(2);
  else if (content.startsWith("\n")) content = content.slice(1);
  if (content.endsWith("\r\n")) content = content.slice(0, -2);
  else if (content.endsWith("\n")) content = content.slice(0, -1);
  assertCodeWriterReturnedFileContent(content, relativePath);
  return content;
}

function assertCodeWriterReturnedFileContent(content: string, relativePath: string) {
  const lines = content.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const hasDiffHeader = nonEmpty.some((line) => /^diff --git\s+a\//.test(line));
  const hasFileHeaders = nonEmpty.some((line) => /^---\s+(?:a\/|\/dev\/null)/.test(line))
    && nonEmpty.some((line) => /^\+\+\+\s+(?:b\/|\/dev\/null)/.test(line));
  const hasHunk = nonEmpty.some((line) => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line));
  const patchPrefixedLines = nonEmpty.filter((line) => /^[+-](?![+-]{2}\s)/.test(line)).length;
  const mostlyPatchLines = nonEmpty.length >= 8 && patchPrefixedLines / nonEmpty.length > 0.45;

  if (hasDiffHeader || (hasFileHeaders && hasHunk) || (hasHunk && mostlyPatchLines)) {
    throw new Error(`代码写入返回的是 diff/patch,不是完整文件内容: ${relativePath}`);
  }
}

function assertSafeWorkspacePath(workspaceRoot: string, relativePath: string) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error(`Unsafe code writer path: ${relativePath}`);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((seg) => seg === ".git" || seg === "node_modules")) {
    throw new Error(`Refusing to write inside ${segments.join("/")}`);
  }
  const filename = segments[segments.length - 1];
  if (protectedWriterFilenames.has(filename)) {
    throw new Error(`Refusing to write protected file: ${filename}`);
  }
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Code writer escaped workspace: ${relativePath}`);
  }
}

/**
 * 落盘 codegen patches：只有确定性 golden path 或受控 writer 产出的完整文件内容
 * 才会以 allowOverwrite=true 调用。计划阶段 LLM 输出的短 patches 片段不能直接落盘。
 */
async function tryApplyCodegenPatches(
  run: WorkflowRun,
  codegenOutputOverride?: CodeGenerationPlan,
  opts?: { allowOverwrite?: boolean; diffPreview?: "workspace" | "incremental" },
): Promise<(RepoWriteResult & { runtimeTrace: unknown }) | null> {
  const codegenOutput = codegenOutputOverride;
  if (!codegenOutput || !codegenOutput.patches || codegenOutput.patches.length === 0) return null;
  if (!opts?.allowOverwrite) return null;

  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error("No workspace is available for code_generation step.");
  }

  // 分支命名约定：feat/<runId 短前缀>
  const branchName = `feat/${run.id.slice(0, 12).replace(/[^A-Za-z0-9._/-]/g, "-")}`;
  const toolTraces: Array<Awaited<ReturnType<typeof runRuntimeTool>>> = [];

  // 仅当工作区是 git 仓库时才切分支；否则直接落盘到当前目录。
  if (workspace.hasRepository) {
    const branchCall = await runRuntimeTool(workspace, "git_checkout_branch", { branch: branchName });
    toolTraces.push(branchCall);
    const branchResult = branchCall.output as { ok: boolean; reason?: string };
    if (!branchResult.ok) {
      throw new Error(`git_checkout_branch failed: ${branchResult.reason ?? "unknown"}`);
    }
  }

  const appliedChanges: FileChange[] = [];
  for (const patch of codegenOutput.patches) {
    const absolutePath = workspace.workspaceDir ? path.resolve(workspace.workspaceDir, patch.path) : "";
    const originalContent = absolutePath && existsSync(absolutePath) && !(await stat(absolutePath)).isDirectory()
      ? await readFile(absolutePath, "utf-8")
      : "";
    const writeCall = await runRuntimeTool(workspace, "write_file", {
      path: patch.path,
      content: patch.content,
      mode: "overwrite",
    });
    toolTraces.push(writeCall);
    const wResult = writeCall.output as { written: boolean; bytes?: number; reason?: string };
    if (!wResult.written) {
      throw new Error(`write_file failed for ${patch.path}: ${wResult.reason ?? "unknown"}`);
    }
    const diffPreview = opts?.diffPreview === "incremental"
      ? await getNoIndexDiffPreview(workspace.workspaceDir, patch.path, originalContent, patch.content)
      : workspace.hasRepository
        ? await getUnifiedDiffPreview(workspace.workspaceDir, patch.path, originalContent, patch.content, patch.changeType)
        : await getNoIndexDiffPreview(workspace.workspaceDir, patch.path, originalContent, patch.content);
    appliedChanges.push({
      path: patch.path,
      changeType: patch.changeType,
      additions: countDiffLines(diffPreview, "added"),
      deletions: countDiffLines(diffPreview, "deleted"),
      contentPreview: diffPreview,
    });
  }

  // 通过 git_status 收集 diffSummary（只在 git 仓库下）
  let diffSummary = "";
  if (workspace.hasRepository) {
    const statusCall = await runRuntimeTool(workspace, "git_status");
    toolTraces.push(statusCall);
    const status = statusCall.output as { dirty?: boolean; status?: string; branch?: string };
    diffSummary = status.status ?? "";
  }

  const result: RepoWriteResult = {
    branch: branchName,
    mode: "applied",
    pendingChanges: [],
    appliedChanges,
    diffSummary,
    filesChanged: appliedChanges, // 兼容字段
  };

  const parsed = repoWriteResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`repoWriteResult schema failed after apply: ${parsed.error.message}`);
  }

  const writerMetric = buildMetricPayload(
    stepAgents.code_generation,
    1,
    0,
    0,
    toolTraces.reduce((acc, c) => acc + c.durationMs, 0),
  );
  recordMetric(writerMetric);

  const skillSpecForWrite = getSkillStepSpec(run, "code_generation", getCurrentWorkspace() ?? undefined);

  return {
    ...parsed.data,
    __metrics: [writerMetric],
    runtimeTrace: {
      runtime: "simple-agent-runtime" as const,
      workspaceId: workspace.id,
      workspaceDir: workspace.workspaceDir,
      observations: [
        `生成代码阶段真实写入 ${appliedChanges.length} 个文件到分支 ${branchName}`,
      ],
      toolCalls: toolTraces,
      selectedSkillId: skillSpecForWrite.skillId,
      skillMatchReason: skillSpecForWrite.skillMatchReason,
      skillDiagnostics: skillSpecForWrite.skillDiagnostics,
    },
  };
}

async function getUnifiedDiffPreview(
  workspaceDir: string | undefined,
  relativePath: string,
  originalContent: string,
  content: string,
  changeType: "created" | "modified",
) {
  if (!workspaceDir || !relativePath || relativePath.includes("..") || relativePath.startsWith("/")) {
    return synthesizeFileDiff(relativePath, originalContent, content);
  }

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--unified=5", "--", relativePath], {
      cwd: workspaceDir,
      timeout: 10_000,
      maxBuffer: maxDiffBufferBytes,
    });
    if (stdout.trim()) return sanitizeUnifiedDiffPreview(stdout);
  } catch {
    // Fall through to a synthetic preview. The write result should remain reviewable.
  }

  const noIndexDiff = await getNoIndexDiffPreview(workspaceDir, relativePath, originalContent, content);
  if (noIndexDiff.trim()) return noIndexDiff;

  return changeType === "created"
    ? synthesizeFileDiff(relativePath, "", content)
    : synthesizeFileDiff(relativePath, originalContent, content);
}

async function getWorkspaceReviewDiff(workspaceDir: string | undefined, relativePath: string) {
  if (!workspaceDir || !relativePath || relativePath.includes("..") || relativePath.startsWith("/")) {
    return "";
  }

  const unstaged = await readGitDiff(workspaceDir, ["diff", "--no-ext-diff", "--unified=5", "--", relativePath]);
  if (unstaged.trim()) return unstaged;

  const staged = await readGitDiff(workspaceDir, ["diff", "--cached", "--no-ext-diff", "--unified=5", "--", relativePath]);
  if (staged.trim()) return staged;

  const untracked = await readGitRaw(workspaceDir, ["ls-files", "--others", "--exclude-standard", "--", relativePath]);
  if (untracked.split(/\r?\n/).some((line) => line.trim() === relativePath)) {
    const absolutePath = path.resolve(workspaceDir, relativePath);
    if (!absolutePath.startsWith(path.resolve(workspaceDir) + path.sep)) return "";
    const fileStat = existsSync(absolutePath) ? await stat(absolutePath) : null;
    if (!fileStat || fileStat.isDirectory()) return "";
    const content = await readFile(absolutePath, "utf-8");
    return synthesizeFileDiff(relativePath, "", content);
  }

  return "";
}

async function readGitDiff(workspaceDir: string, args: string[]) {
  const stdout = await readGitRaw(workspaceDir, args);
  return stdout.trim() ? sanitizeUnifiedDiffPreview(stdout) : "";
}

async function readGitRaw(workspaceDir: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workspaceDir,
      timeout: 10_000,
      maxBuffer: maxDiffBufferBytes,
    });
    return stdout;
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? "";
  }
}

async function getWorkspaceChangedFiles(workspaceDir: string | undefined) {
  if (!workspaceDir) return [];
  const tracked = await readGitRaw(workspaceDir, ["diff", "--name-only", "--no-ext-diff"]);
  const staged = await readGitRaw(workspaceDir, ["diff", "--cached", "--name-only", "--no-ext-diff"]);
  const untracked = await readGitRaw(workspaceDir, ["ls-files", "--others", "--exclude-standard"]);
  return Array.from(new Set(
    [tracked, staged, untracked]
      .flatMap((chunk) => chunk.split(/\r?\n/))
      .map((line) => line.trim())
      .filter((line) => line && !line.includes("..") && !path.isAbsolute(line)),
  ));
}

async function getNoIndexDiffPreview(
  workspaceDir: string | undefined,
  relativePath: string,
  originalContent: string,
  content: string,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-delivery-diff-"));
  try {
    const oldPath = path.join(tempDir, "old");
    const newPath = path.join(tempDir, "new");
    await writeFile(oldPath, originalContent, "utf-8");
    await writeFile(newPath, content, "utf-8");
    const args = [
      "diff",
      "--no-index",
      "--unified=5",
      "--label",
      `a/${relativePath}`,
      "--label",
      `b/${relativePath}`,
      oldPath,
      newPath,
    ];
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: workspaceDir ?? process.cwd(),
        timeout: 10_000,
        maxBuffer: maxDiffBufferBytes,
      });
      return sanitizeUnifiedDiffPreview(stdout);
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (stdout?.trim()) return sanitizeUnifiedDiffPreview(stdout);
      return synthesizeFileDiff(relativePath, originalContent, content);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function synthesizeFileDiff(relativePath: string, originalContent: string, content: string) {
  const oldLines = splitContentLines(originalContent);
  const newLines = splitContentLines(content);
  if (areLineArraysEqual(oldLines, newLines)) return "";

  const contextSize = 5;
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length
    && prefixLength < newLines.length
    && oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldLines.length - prefixLength
    && suffixLength < newLines.length - prefixLength
    && oldLines[oldLines.length - 1 - suffixLength] === newLines[newLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const oldChangeEnd = oldLines.length - suffixLength;
  const newChangeEnd = newLines.length - suffixLength;
  const oldHunkStart = Math.max(0, prefixLength - contextSize);
  const newHunkStart = Math.max(0, prefixLength - contextSize);
  const oldHunkEnd = Math.min(oldLines.length, oldChangeEnd + contextSize);
  const newHunkEnd = Math.min(newLines.length, newChangeEnd + contextSize);
  const beforeContextCount = prefixLength - oldHunkStart;
  const afterOldContextStart = oldChangeEnd;
  const afterNewContextStart = newChangeEnd;
  const afterContextCount = oldHunkEnd - afterOldContextStart;

  const hunkLines: string[] = [];
  for (let index = 0; index < beforeContextCount; index += 1) {
    hunkLines.push(` ${oldLines[oldHunkStart + index] ?? ""}`);
  }
  for (let index = prefixLength; index < oldChangeEnd; index += 1) {
    hunkLines.push(`-${oldLines[index] ?? ""}`);
  }
  for (let index = prefixLength; index < newChangeEnd; index += 1) {
    hunkLines.push(`+${newLines[index] ?? ""}`);
  }
  for (let index = 0; index < afterContextCount; index += 1) {
    hunkLines.push(` ${oldLines[afterOldContextStart + index] ?? newLines[afterNewContextStart + index] ?? ""}`);
  }

  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${formatDiffRange(oldHunkStart, oldHunkEnd - oldHunkStart)} +${formatDiffRange(newHunkStart, newHunkEnd - newHunkStart)} @@`,
    ...hunkLines,
  ].join("\n");
}

function splitContentLines(content: string) {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function areLineArraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function formatDiffRange(startZeroBased: number, length: number) {
  const start = length === 0 ? startZeroBased : startZeroBased + 1;
  return length === 1 ? `${start}` : `${start},${length}`;
}

function sanitizeUnifiedDiffPreview(diff: string) {
  return diff
    .split(/\r?\n/)
    .filter((line) => !isUnifiedDiffFileMetadata(line))
    .join("\n")
    .trimEnd();
}

function isUnifiedDiffFileMetadata(line: string) {
  return /^(diff --git|index |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |Binary files )/.test(line);
}

function countDiffLines(diff: string, type: "added" | "deleted") {
  const prefix = type === "added" ? "+" : "-";
  const header = type === "added" ? "+++" : "---";
  return diff.split(/\r?\n/).filter((line) => line.startsWith(prefix) && !line.startsWith(header)).length;
}

// ---- Pull Request Step: 真实 git 操作 + GitHub API ----

async function runPullRequestStep(
  run: WorkflowRun,
  options?: { branch?: string; commitMessage?: string },
): Promise<Record<string, unknown> & { runtimeTrace: unknown }> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error("No workspace is available for pull_request step.");
  }

  // Phase 1: generate AI draft → return waiting-human
  if (!options?.branch && !options?.commitMessage) {
    const title = buildPrTitle(run);
    const branch = deriveBranchName(run);
    return buildPrResult({
      run, title, url: "pending://pull-request", status: "draft",
      checklist: ["AI 已生成 PR draft，请确认分支名和 commit message 后点击继续"],
      branch, commitMessage: title, toolTraces: [],
    });
  }

  // Phase 2: user confirmed (options set) OR regenerate with prior draft values
  const draft = run.steps.find((s) => s.id === "pull_request")?.output as
    | { branch?: string; commitMessage?: string }
    | undefined;
  const branch = options?.branch ?? draft?.branch ?? deriveBranchName(run);
  const commitMessage = options?.commitMessage ?? draft?.commitMessage ?? buildPrTitle(run);

  // Phase 2: user confirmed → execute git operations
  const toolTraces: Array<Awaited<ReturnType<typeof runRuntimeTool>>> = [];
  const checklist: string[] = [];
  const title = buildPrTitle(run);
  let commitSha: string | undefined;

  // 1. 检查是否是 git 仓库
  if (!workspace.hasRepository) {
    return buildPrResult({
      run, title, url: "pending://pull-request", status: "draft",
      checklist: ["工作区不是 git 仓库，无法创建 PR"], toolTraces,
    });
  }

  // 2. 设置 git identity
  const identityResult = await runRuntimeTool(workspace, "git_config_identity");
  toolTraces.push(identityResult);
  if (!(identityResult.output as { ok?: boolean }).ok) {
    checklist.push("Git 身份未配置: GIT_USER_NAME / GIT_USER_EMAIL");
  } else {
    checklist.push("Git 身份已配置");
  }

  // 3. 创建/切换分支
  const requestedBranchName = branch;
  const branchResult = await runRuntimeTool(workspace, "git_create_branch", { branch: requestedBranchName });
  toolTraces.push(branchResult);
  const branchOut = branchResult.output as { ok?: boolean; branch?: string; reused?: boolean; reason?: string };
  if (!branchOut.ok) {
    return buildPrResult({
      run, title, url: "pending://pull-request", status: "draft",
      checklist: [...checklist, `创建分支失败: ${branchOut.reason}`], toolTraces,
    });
  }
  const branchName = branchOut.branch ?? requestedBranchName;
  checklist.push(`分支: ${branchOut.branch}`);

  // 4. 提交变更
  const commitResult = await runRuntimeTool(workspace, "git_commit_changes", { message: commitMessage });
  toolTraces.push(commitResult);
  const commitOut = commitResult.output as { ok?: boolean; committed?: boolean; reason?: string; filesChanged?: number };
  if (commitOut.committed) {
    checklist.push(`已提交 ${commitOut.filesChanged} 个文件`);
    checklist.push(`Commit: ${commitMessage}`);
    // 尝试获取 commit SHA
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.workspaceDir, timeout: 5_000 });
      commitSha = stdout.trim();
    } catch { /* sha 获取失败不阻断 */ }
  } else {
    checklist.push(commitOut.reason ?? "没有可提交的变更");
  }

  // 5. Push
  let pushOut: { ok?: boolean; reason?: string } = { ok: false, reason: "没有新提交，跳过 push" };
  const shouldPush = commitOut.committed || branchOut.reused;
  if (shouldPush) {
    const pushResult = await runRuntimeTool(workspace, "git_push_branch", { branch: branchName });
    toolTraces.push(pushResult);
    pushOut = pushResult.output as { ok?: boolean; reason?: string };
  }

  // 6. 创建 GitHub PR
  let prOut: Record<string, unknown> = {};
  if (shouldPush && pushOut.ok) {
    const prBody = buildPrBody(run);
    const prResult = await runRuntimeTool(workspace, "github_create_pr", {
      title, body: prBody, head: branchName,
    });
    toolTraces.push(prResult);
    prOut = prResult.output as Record<string, unknown>;
  }

  const prOk = prOut.ok === true;
  const prUrl = (prOut.url as string) || "pending://pull-request";
  const prNumber = prOut.number as number | undefined;

  if (prOk) {
    checklist.push(`PR 已创建: ${prUrl}`);
  } else if (prOut.reason) {
    checklist.push(`PR 创建失败: ${prOut.reason}`);
  } else if (pushOut.ok) {
    checklist.push("分支已推送，PR 创建失败或未配置 token");
  } else if (!pushOut.ok) {
    checklist.push(`Push 失败: ${pushOut.reason}`);
  }

  if (!pushOut.ok && !commitOut.committed) {
    checklist.push("无变更且 push 失败，请检查工作区");
  }

  return buildPrResult({
    run, title, url: prUrl,
    status: prOk ? "ready" : "draft",
    checklist, branch: branchName, commitMessage, commitSha, prNumber, pushed: pushOut.ok === true, toolTraces,
  });
}

function buildPrTitle(run: WorkflowRun): string {
  const title = run.title || "workflow auto PR";
  return title.slice(0, 80).replace(/["`$\\]/g, "");
}

function buildPrBody(run: WorkflowRun): string {
  const sections: string[] = [];
  const requirement = run.steps.find((s) => s.id === "requirement_intake")?.output as Record<string, unknown> | undefined;
  const clarification = run.steps.find((s) => s.id === "clarification")?.output as Record<string, unknown> | undefined;
  const solution = run.steps.find((s) => s.id === "solution_design")?.output as Record<string, unknown> | undefined;
  const verification = run.steps.find((s) => s.id === "verification")?.output as Record<string, unknown> | undefined;
  const codeGeneration = run.steps.find((s) => s.id === "code_generation")?.output as Record<string, unknown> | undefined;
  const repoWrite = (codeGeneration?.repoWriteResult as Record<string, unknown> | undefined)
    ?? (codeGeneration && "filesChanged" in codeGeneration ? codeGeneration : undefined)
    ?? (run.steps.find((s) => s.id === "repo_write")?.output as Record<string, unknown> | undefined);

  if (requirement?.rawText) sections.push(`## Requirement\n${requirement.rawText}`);
  if (clarification) {
    const decisions = clarification.decisions as Array<{ title: string; finalAnswer: string }> | undefined;
    if (decisions?.length) sections.push("## Clarification Decisions\n" + decisions.map((d) => `- **${d.title}**: ${d.finalAnswer}`).join("\n"));
    if (clarification.summary) sections.push(`## Clarification Summary\n${clarification.summary}`);
  }
  if (solution) {
    const ac = solution.acceptanceCriteria as string[] | undefined;
    if (ac?.length) sections.push("## Acceptance Criteria\n" + ac.map((a) => `- ${a}`).join("\n"));
  }
  const files = (repoWrite as { filesChanged?: Array<{ path: string }> })?.filesChanged;
  if (files?.length) sections.push("## Files Changed\n" + files.map((f) => `- ${f.path}`).join("\n"));
  if (verification) {
    const commands = verification.commands as Array<{ label: string; status: string }> | undefined;
    if (commands?.length) sections.push("## Verification\n" + commands.map((c) => `- ${c.label}: ${c.status}`).join("\n"));
  }
  sections.push("\n---\nGenerated with AI Delivery Workspace");
  return sections.join("\n\n").slice(0, 5_000);
}

function deriveBranchName(run: WorkflowRun): string {
  const slug = (run.title || "feature")
    .replace(/[^A-Za-z0-9\s_-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  return `feature/${slug}`;
}

function buildPrResult(opts: {
  run: WorkflowRun;
  title: string;
  url: string;
  status: "draft" | "ready";
  checklist: string[];
  branch?: string;
  commitMessage?: string;
  commitSha?: string;
  prNumber?: number;
  pushed?: boolean;
  toolTraces: Array<Awaited<ReturnType<typeof runRuntimeTool>>>;
}): Record<string, unknown> & { runtimeTrace: unknown } {
  const prMetric = buildMetricPayload(
    stepAgents.pull_request,
    1,
    0,
    0,
    opts.toolTraces.reduce((acc, c) => acc + c.durationMs, 0),
  );
  recordMetric(prMetric);

  return {
    title: opts.title,
    url: opts.url,
    status: opts.status,
    checklist: opts.checklist,
    branch: opts.branch,
    commitMessage: opts.commitMessage,
    commitSha: opts.commitSha,
    prNumber: opts.prNumber,
    pushed: opts.pushed,
    __metrics: [prMetric],
    runtimeTrace: {
      runtime: "simple-agent-runtime" as const,
      workspaceId: getCurrentWorkspace()?.id ?? "",
      workspaceDir: getCurrentWorkspace()?.workspaceDir,
      observations: opts.checklist,
      toolCalls: opts.toolTraces,
    },
    runId: opts.run.id,
  };
}
