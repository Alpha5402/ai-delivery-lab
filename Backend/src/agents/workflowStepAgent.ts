import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z as zod } from "zod";
import { z } from "zod";
import { runSimpleAgentRuntime } from "../agentRuntime/simpleAgentRuntime.js";
import { runRuntimeTool } from "../agentRuntime/toolRegistry.js";
import { tryGoldenPathCodegen } from "./goldenPathCodegen.js";
import {
  type CodeGenerationPlan,
  type CodeReviewResult,
  codeReviewResultSchema,
  type FileChange,
  llmCodeGenerationPlanSchema,
  moduleMappingSchema,
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
import { callJsonLlmWithSchema, callTextLlm } from "../services/llmClient.js";
import { recordMetric } from "../services/metricsService.js";
import { getCurrentWorkspace } from "../services/workspaceService.js";
import { getSkillStepSpec } from "../skills/skillRegistry.js";
import {
  deriveRouterContext,
  moduleMappingInstructionAddon,
  verificationCommandPolicy,
} from "../services/stepRouter.js";

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

const agentSpecs: Record<Exclude<WorkflowStepId, "requirement_intake" | "clarification" | "solution_design" | "verification">, {
  schema: z.ZodTypeAny;
  instruction: string;
  outputContract: string;
}> = {
  module_mapping: {
    schema: moduleMappingSchema,
    instruction: "定位需求会影响的真实模块。必须先依据 runtime 中的文件列表和 Agent Guide 判断模块边界，不要只凭技术栈猜测。所列文件路径必须能在 runtime.list_files 结果中找到，否则必须在 reason 中明确标注 “新增” / create / new。不要编造 Skill；只有当上游已经明确命中预配置 Skill 时，才可输出 reusableSkill。",
    outputContract: "输出 JSON：touchedModules 为模块数组，每项含 name, reason, files；reusableSkill 为可选字段，只能填写已命中的预配置 Skill 名称。",
  },
  code_generation: {
    schema: llmCodeGenerationPlanSchema,
    instruction: "先制定文件级代码交付计划。每个任务必须指向目标文件并说明是否需要测试。testRequired=true 时必须同时填写 testFiles，列出本次生成代码阶段要一并创建或修改的单元测试文件；不要把补测试留给后续阶段。绝对不要使用绝对路径或包含 .. 的路径。计划阶段不要声称已生成真实 diff、已修改文件、已落盘或已补测试；真实写入会由后续受控 writer 基于你的计划逐文件完成。禁止在 JSON 字段里输出大段源码；默认不要输出 patches。只有当片段能帮助审查且不超过 200 字符时，才可在 patches.content 中输出关键行/小片段；该片段仅用于展示，不代表实际文件变更。",
    outputContract: "输出 JSON：strategy 为代码交付计划摘要；tasks 为任务数组，每项含 id, title, files, testRequired, testFiles(当 testRequired=true 时必填), coverLayer(可选)。patches 可选且仅用于 <=200 字符的展示片段，不是可落盘补丁。",
  },
  repo_write: {
    schema: repoWriteResultSchema,
    instruction: "Legacy 兼容：生成可审计的仓库写入计划。新 workflow 已并入生成代码阶段。当前 runtime 默认不会自动写文件，所以必须把 mode 设为 \"planned\"，并把变更放进 pendingChanges；不要声称已经落盘。如果 runtime trace 中包含 write_file/git_checkout_branch 调用并且成功，可以把 mode 设为 \"applied\" 并把变更放进 appliedChanges。",
    outputContract: "输出 JSON：branch、mode (planned|applied)、pendingChanges、appliedChanges、diffSummary、filesChanged（向后兼容，可与 pendingChanges 等价）。不要生成 PR 链接。",
  },
  code_review: {
    schema: codeReviewResultSchema,
    instruction: "审查生成代码的变更。必须基于真实 diff 和 filesChanged 进行审查，不要凭空评价未变更文件。重点：功能正确性 > 安全/副作用 > 测试覆盖 > 可维护性 > 风格。blocker/major findings 必须输出 decision=request-changes。不要输出大段源码，只引用文件路径、行号、摘要和建议。字段名必须严格使用 outputContract，不要使用 path/lines/suggestion/message 等别名。",
    outputContract: "输出 JSON object：summary:string；decision:\"approve\"|\"request-changes\"；findings:Array<{id:string,severity:\"blocker\"|\"major\"|\"minor\"|\"nit\",title:string,detail:string,file?:string,line?:number,recommendation?:string}>；checklist:Array<{id:string,label:string,status:\"passed\"|\"warning\"|\"failed\"|\"not_applicable\",detail?:string}>；reviewedFiles:string[]；riskAreas:string[]。checklist 不能是字符串数组。",
  },
  pull_request: {
    schema: pullRequestResultSchema,
    instruction: "生成 PR 草稿信息和提交前 checklist。若 runtime 没有真实创建 PR，必须使用 pending://pull-request。",
    outputContract: "输出 JSON：title, url, status, checklist。若没有真实 PR URL，url 使用 pending://pull-request 并把 status 设为 draft。",
  },
};

export async function runWorkflowStepAgent(stepId: WorkflowStepId, run: WorkflowRun, options?: WorkflowStepRunOptions) {
  if (stepId === "requirement_intake" || stepId === "clarification" || stepId === "solution_design") {
    throw new Error(`Unsupported generic workflow step: ${stepId}`);
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

  // golden path: code_generation 对前端计算指标需求输出确定性 patches
  if (stepId === "code_generation") {
    const goldenPlan = tryGoldenPathCodegen(run, getCurrentWorkspace() ?? undefined);
    if (goldenPlan) {
      recordMetric({
        agent: stepAgents[stepId],
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        estimatedCost: 0,
      });
      const repoWriteResult = await tryApplyCodegenPatches(run, goldenPlan, { allowOverwrite: true });
      if (!hasReviewableDiff(repoWriteResult)) {
        throw new Error("生成代码未产生可审查 diff，已中止。请配置安全写入链路后重试。");
      }
      return {
        ...goldenPlan,
        ...(repoWriteResult ?? {}),
        ...(repoWriteResult ? { repoWriteResult } : {}),
        runtimeTrace: {
          runtime: "golden-path" as const,
          workspaceId: getCurrentWorkspace()?.id ?? "",
          workspaceDir: getCurrentWorkspace()?.workspaceDir,
          observations: [
            "Golden path: 前端计算指标 → 确定性 patches",
            repoWriteResult ? "生成代码阶段已完成真实文件写入" : "生成代码阶段未产生可落盘补丁",
          ],
          toolCalls: repoWriteResult?.runtimeTrace && typeof repoWriteResult.runtimeTrace === "object" && "toolCalls" in repoWriteResult.runtimeTrace
            ? (repoWriteResult.runtimeTrace as { toolCalls?: unknown[] }).toolCalls ?? []
            : [],
          selectedSkillId: getSkillStepSpec(run, stepId, getCurrentWorkspace() ?? undefined).skillId,
        },
      };
    }
  }

  const spec = agentSpecs[stepId];

  // 三层叠加 prompt:
  // layer 1: agentSpecs 的基础 instruction
  let instruction = spec.instruction;
  let outputContract = spec.outputContract;

  // layer 2: stepRouter 的 scope/pattern 动态 addon
  const ctx = deriveRouterContext(run);
  if (stepId === "module_mapping") {
    instruction = `${instruction}\n${moduleMappingInstructionAddon(ctx)}`;
  }

  // layer 3: Skill 注入 addon
  const skillSpec = getSkillStepSpec(run, stepId, getCurrentWorkspace() ?? undefined);
  if (skillSpec.instructionAddon) {
    instruction = `${instruction}\n${skillSpec.instructionAddon}`;
  }
  if (skillSpec.outputContractAddon) {
    outputContract = `${outputContract}\n${skillSpec.outputContractAddon}`;
  }

  const result = await runSimpleAgentRuntime(stepId, run, spec.schema, {
    instruction,
    outputContract,
  });

  recordMetric({
    agent: stepAgents[stepId],
    calls: 1,
    inputTokens: result.tokens.inputTokens,
    outputTokens: result.tokens.outputTokens,
    latencyMs: result.tokens.latencyMs,
    estimatedCost: 0,
  });

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
    runtimeTrace: {
      ...result.trace,
      ...(repoWriteResult?.runtimeTrace && typeof repoWriteResult.runtimeTrace === "object" && "toolCalls" in repoWriteResult.runtimeTrace
        ? { toolCalls: [...(result.trace.toolCalls ?? []), ...((repoWriteResult.runtimeTrace as { toolCalls?: unknown[] }).toolCalls ?? [])] }
        : {}),
      selectedSkillId: skillSpec.skillId,
      skillMatchReason: skillSpec.skillMatchReason,
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
  const detection = await runRuntimeTool(workspace, "detect_workflow_commands");
  const candidates = (detection.output as {
    candidates: Array<{ label: string; available: boolean; argv: string[]; description: string; reason: string }>;
  }).candidates ?? [];

  // 动态:基于 pattern/scope + Skill 的 addon 决定哪些命令必选/可选。
  const ctx = deriveRouterContext(run);
  const skillSpecForVerify = getSkillStepSpec(run, "verification", getCurrentWorkspace() ?? undefined);
  const policy = verificationCommandPolicy(ctx, skillSpecForVerify.verificationPolicyAddon);

  const commandResults: VerificationCommandResult[] = [];
  const toolTraces = [detection];

  // 顺序执行:typecheck → lint → test → build;如果 npm:typecheck 已可用则跳过 tsc:noemit。
  // required 命令即使 not_configured 也明确记录,optional 命令仅 available 时执行。
  const order = ["npm:typecheck", "npm:lint", "npm:test", "npm:build", "tsc:noemit"];
  let typecheckAlreadyDone = false;
  for (const label of order) {
    const candidate = candidates.find((c) => c.label === label);
    if (!candidate) continue;
    if (label === "tsc:noemit" && typecheckAlreadyDone) continue;

    const isRequired = policy.required.includes(label);
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

    const call = await runRuntimeTool(workspace, "run_command", { label });
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
    });
    if (label === "npm:typecheck" || label === "tsc:noemit") {
      typecheckAlreadyDone = true;
    }
  }

  function statusFor(label: VerificationCommandResult["label"]): VerificationStatus {
    const items = commandResults.filter((c) => c.label === label);
    if (items.length === 0) return "not_configured";
    if (items.some((c) => c.status === "failed")) return "failed";
    if (items.every((c) => c.status === "not_configured")) return "not_configured";
    if (items.some((c) => c.status === "passed")) return "passed";
    return items[0].status;
  }

  // 无 testFiles：质量门禁默认放行
  const noTestDeclared = testFiles.length === 0;
  const result: VerificationResult = {
    typecheck: statusFor("typecheck"),
    lint: statusFor("lint"),
    unitTests: noTestDeclared ? "skipped" : statusFor("unit_tests"),
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
        `检测到的脚本：${(detection.output as { detectedScripts: string[] }).detectedScripts.join(", ")}`,
      ],
      toolCalls: toolTraces,
      selectedSkillId: skillSpecForVerify.skillId,
      skillMatchReason: skillSpecForVerify.skillMatchReason,
    },
    runId: run.id,
  };
}

function labelToVerificationLabel(label: string): VerificationCommandResult["label"] {
  if (label === "npm:typecheck" || label === "tsc:noemit") return "typecheck";
  if (label === "npm:lint") return "lint";
  if (label === "npm:test") return "unit_tests";
  if (label === "npm:build") return "build";
  return "custom";
}

function buildHeuristicDiagnosis(results: VerificationCommandResult[]): string {
  const failed = results.filter((c) => c.status === "failed");
  if (failed.length === 0) return "";
  const lines = failed.map((c) => {
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

async function runCodeReviewStep(run: WorkflowRun) {
  const spec = agentSpecs.code_review;
  const workspace = getCurrentWorkspace();
  const repoResult = run.steps.find((s) => s.id === "repo_write")?.output as RepoWriteResult | undefined;
  const codegenPlan = run.steps.find((s) => s.id === "code_generation")?.output as CodeGenerationPlan | undefined;

  // 收集变更文件的真实内容作为审查上下文
  const diffs: string[] = [];
  if (repoResult?.appliedChanges?.length) {
    for (const change of repoResult.appliedChanges) {
      diffs.push(`--- ${change.path} (${change.changeType}, +${change.additions}/-${change.deletions})`);
      if (change.contentPreview) diffs.push(change.contentPreview);
    }
  }

  const result = await runSimpleAgentRuntime("code_review", run, spec.schema, {
    instruction: spec.instruction,
    outputContract: spec.outputContract,
  });

  recordMetric({
    agent: stepAgents.code_review,
    calls: 1,
    inputTokens: result.tokens.inputTokens,
    outputTokens: result.tokens.outputTokens,
    latencyMs: result.tokens.latencyMs,
    estimatedCost: 0,
  });

  return {
    ...(result.output as Record<string, unknown>),
    runtimeTrace: {
      ...result.trace,
      observations: [
        ...result.trace.observations,
        `审查了 ${repoResult?.appliedChanges?.length ?? 0} 个变更文件`,
      ],
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
  const generatedPatches: NonNullable<CodeGenerationPlan["patches"]> = [];

  for (const relativePath of targetFiles) {
    assertSafeWorkspacePath(workspaceRoot, relativePath);
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const exists = existsSync(absolutePath);
    const originalContent = exists ? await readFile(absolutePath, "utf-8") : "";
    if (originalContent.length > maxWriterInputChars) {
      throw new Error(`生成代码拒绝处理过大的文件: ${relativePath} (${originalContent.length} chars)`);
    }

    const relatedTasks = (plan.tasks ?? []).filter((task) =>
      task.files?.includes(relativePath) || getTaskTestFiles(task).includes(relativePath),
    );
    const isTestFile = relatedTasks.some((task) => getTaskTestFiles(task).includes(relativePath));
    const writerMessages = [
      {
        role: "system" as const,
        content: [
          "你是代码写入器。",
          "你会收到单个目标文件的当前完整内容和相关任务。",
          "返回该文件修改后的完整内容，不要输出 Markdown，不要解释。",
          `输出必须以独立一行 ${codeWriterBeginMarker} 开始，以独立一行 ${codeWriterEndMarker} 结束。`,
          "边界标记之外不要输出任何字符。",
          "边界标记中间只能放最终文件内容本身。",
          "必须保留与任务无关的现有逻辑和样式。",
          isTestFile
            ? "当前目标文件是测试文件。必须补齐与相关任务对应的单元测试或组件测试，覆盖关键验收路径和边界场景。"
            : "当前目标文件是实现文件。若相关任务需要测试，测试会在同一生成代码阶段由对应 testFiles 一并写入。",
          "如果目标是新增文件，originalContent 为空。",
          "不要修改 package lock、.env、node_modules 或 .git 内文件。",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          runTitle: run.title,
          workflowContext: buildCodeWriterWorkflowContext(run),
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

    const nextContent = await callCodeWriterText(writerMessages, relativePath);
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

    const applied = await tryApplyCodegenPatches(run, {
      ...plan,
      patches: realPatches,
    }, { allowOverwrite: true });

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
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, files: t.files, testRequired: t.testRequired })),
          fileTree: fileTree.slice(0, 30),
          existingTestPatterns: testPatterns,
        }),
      },
    ], testFileDerivationSchema, { label: "Test File Deriver" });

    return result.content.testTargets.map((t) => ({
      taskId: t.taskId,
      testFiles: t.testFiles,
      reason: t.reason,
    }));
  } catch {
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
    const writer = await callTextLlm(retryMessages);
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
            "不要输出 Markdown 代码块、JSON、解释或边界标记之外的任何字符。",
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

function buildCodeWriterWorkflowContext(run: WorkflowRun) {
  const pickStep = (id: WorkflowStepId) => run.steps.find((step) => step.id === id)?.output;
  return {
    requirement: pickStep("requirement_intake"),
    clarification: pickStep("clarification"),
    solution: pickStep("solution_design"),
    moduleMapping: pickStep("module_mapping"),
  };
}

function getTaskTestFiles(task: CodeGenerationPlan["tasks"][number]) {
  return (task as { testFiles?: string[] }).testFiles ?? [];
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
  return content;
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
  opts?: { allowOverwrite?: boolean },
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
    const diffPreview = workspace.hasRepository
      ? await getUnifiedDiffPreview(workspace.workspaceDir, patch.path, patch.content, patch.changeType)
      : synthesizeCreatedFileDiff(patch.path, patch.content);
    appliedChanges.push({
      path: patch.path,
      changeType: patch.changeType,
      additions: countDiffLines(diffPreview, "added") || patch.content.split(/\r?\n/).length,
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

  recordMetric({
    agent: stepAgents.code_generation,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: toolTraces.reduce((acc, c) => acc + c.durationMs, 0),
    estimatedCost: 0,
  });

  const skillSpecForWrite = getSkillStepSpec(run, "code_generation", getCurrentWorkspace() ?? undefined);

  return {
    ...parsed.data,
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
    },
  };
}

async function getUnifiedDiffPreview(
  workspaceDir: string | undefined,
  relativePath: string,
  content: string,
  changeType: "created" | "modified",
) {
  if (!workspaceDir || !relativePath || relativePath.includes("..") || relativePath.startsWith("/")) {
    return synthesizeCreatedFileDiff(relativePath, content);
  }

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--unified=5", "--", relativePath], {
      cwd: workspaceDir,
      timeout: 10_000,
      maxBuffer: maxDiffBufferBytes,
    });
    if (stdout.trim()) return stdout;
  } catch {
    // Fall through to a synthetic preview. The write result should remain reviewable.
  }

  if (changeType === "created") {
    return synthesizeCreatedFileDiff(relativePath, content);
  }

  return synthesizeModifiedFilePreview(relativePath, content);
}

function synthesizeCreatedFileDiff(relativePath: string, content: string) {
  const lines = content.split(/\r?\n/);
  const hunkSize = lines.length;
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${hunkSize} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function synthesizeModifiedFilePreview(relativePath: string, content: string) {
  const lines = content.split(/\r?\n/);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -1,${lines.length} +1,${lines.length} @@`,
    ...lines.map((line) => ` ${line}`),
  ].join("\n");
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
  recordMetric({
    agent: stepAgents.pull_request,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: opts.toolTraces.reduce((acc, c) => acc + c.durationMs, 0),
    estimatedCost: 0,
  });

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
