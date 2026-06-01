import type { z } from "zod";
import { runSimpleAgentRuntime } from "../agentRuntime/simpleAgentRuntime.js";
import { runRuntimeTool } from "../agentRuntime/toolRegistry.js";
import { env } from "../config/env.js";
import {
  type CodeGenerationPlan,
  type FileChange,
  codeGenerationPlanSchema,
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
import { recordMetric } from "../services/metricsService.js";
import { getCurrentWorkspace } from "../services/workspaceService.js";
import { getSkillStepSpec } from "../skills/skillRegistry.js";
import {
  deriveRouterContext,
  moduleMappingInstructionAddon,
  verificationCommandPolicy,
} from "../services/stepRouter.js";

const agentSpecs: Record<Exclude<WorkflowStepId, "requirement_intake" | "clarification" | "solution_design" | "verification">, {
  schema: z.ZodTypeAny;
  instruction: string;
  outputContract: string;
}> = {
  module_mapping: {
    schema: moduleMappingSchema,
    instruction: "定位需求会影响的真实模块。必须先依据 runtime 中的文件列表和 Agent Guide 判断模块边界，不要只凭技术栈猜测。所列文件路径必须能在 runtime.list_files 结果中找到，否则必须在 reason 中明确标注 “新增” / create / new。",
    outputContract: "输出 JSON：touchedModules 为模块数组，每项含 name, reason, files；reusableSkill 为可复用 Skill 名称。",
  },
  code_generation: {
    schema: codeGenerationPlanSchema,
    instruction: "制定小步代码生成计划。每个任务都要指向真实或可合理新增的文件，并说明是否需要测试。绝对不要使用绝对路径或包含 .. 的路径。只输出计划，不声称已经写入仓库。",
    outputContract: "输出 JSON：strategy 为代码生成策略；tasks 为任务数组，每项含 id, title, files, testRequired。",
  },
  repo_write: {
    schema: repoWriteResultSchema,
    instruction: "生成可审计的仓库写入计划。当前 runtime 默认不会自动写文件，所以必须把 mode 设为 \"planned\"，并把变更放进 pendingChanges；不要声称已经落盘。如果 runtime trace 中包含 write_file/git_checkout_branch 调用并且成功，可以把 mode 设为 \"applied\" 并把变更放进 appliedChanges。",
    outputContract: "输出 JSON：branch、mode (planned|applied)、pendingChanges、appliedChanges、diffSummary、filesChanged（向后兼容，可与 pendingChanges 等价）。不要生成 PR 链接。",
  },
  pull_request: {
    schema: pullRequestResultSchema,
    instruction: "生成 PR 草稿信息和提交前 checklist。若 runtime 没有真实创建 PR，必须使用 pending://pull-request。",
    outputContract: "输出 JSON：title, url, status, checklist。若没有真实 PR URL，url 使用 pending://pull-request 并把 status 设为 draft。",
  },
};

export async function runWorkflowStepAgent(stepId: WorkflowStepId, run: WorkflowRun) {
  if (stepId === "requirement_intake" || stepId === "clarification" || stepId === "solution_design") {
    throw new Error(`Unsupported generic workflow step: ${stepId}`);
  }

  // verification 是特殊 step：不用 LLM 当事实来源，而是先真实执行命令再让 LLM 做 diagnosis。
  if (stepId === "verification") {
    return runVerificationStep(run);
  }

  // repo_write：如果上游 codegen 提供了 patches，真实落盘；否则降级为计划态由 LLM 生成。
  if (stepId === "repo_write") {
    const applied = await tryApplyCodegenPatches(run);
    if (applied) {
      return applied;
    }
  }

  // pull_request: 优先真实执行 git 操作 + GitHub API 创建 PR
  if (stepId === "pull_request") {
    return runPullRequestStep(run);
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

  return {
    ...(result.output as Record<string, unknown>),
    runtimeTrace: {
      ...result.trace,
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
async function runVerificationStep(run: WorkflowRun) {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error("No workspace is available for verification step.");
  }

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

  const result: VerificationResult = {
    typecheck: statusFor("typecheck"),
    lint: statusFor("lint"),
    unitTests: statusFor("unit_tests"),
    build: statusFor("build"),
    coverage: null,
    testSuites: [],
    commands: commandResults,
    diagnosis: buildHeuristicDiagnosis(commandResults),
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

/**
 * 真实落盘 codegen 输出的 patches:
 *  - 若 codegen 没有 patches,返回 null,让上层走 LLM 计划态;
 *  - 否则: git checkout -b → write_file 每个 patch → 收集 appliedChanges + diffSummary。
 *  - 任意 write_file 失败,直接抛错,让 step 标 failed,不留下"半应用"状态。
 */
async function tryApplyCodegenPatches(run: WorkflowRun): Promise<(RepoWriteResult & { runtimeTrace: unknown }) | null> {
  const codegenStep = run.steps.find((step) => step.id === "code_generation");
  const codegenOutput = codegenStep?.output as CodeGenerationPlan | undefined;
  if (!codegenOutput || !codegenOutput.patches || codegenOutput.patches.length === 0) {
    return null;
  }

  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error("No workspace is available for repo_write step.");
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
    appliedChanges.push({
      path: patch.path,
      changeType: patch.changeType,
      additions: patch.content.split(/\r?\n/).length,
      deletions: 0,
      contentPreview: patch.content.slice(0, 1_000),
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
    agent: stepAgents.repo_write,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: toolTraces.reduce((acc, c) => acc + c.durationMs, 0),
    estimatedCost: 0,
  });

  const skillSpecForWrite = getSkillStepSpec(run, "repo_write", getCurrentWorkspace() ?? undefined);

  return {
    ...parsed.data,
    runtimeTrace: {
      runtime: "simple-agent-runtime" as const,
      workspaceId: workspace.id,
      workspaceDir: workspace.workspaceDir,
      observations: [
        `repo_write 真实写入 ${appliedChanges.length} 个文件到分支 ${branchName}`,
      ],
      toolCalls: toolTraces,
      selectedSkillId: skillSpecForWrite.skillId,
      skillMatchReason: skillSpecForWrite.skillMatchReason,
    },
  };
}

// ---- Pull Request Step: 真实 git 操作 + GitHub API ----

async function runPullRequestStep(run: WorkflowRun): Promise<Record<string, unknown> & { runtimeTrace: unknown }> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error("No workspace is available for pull_request step.");
  }

  const toolTraces: Array<Awaited<ReturnType<typeof runRuntimeTool>>> = [];
  const checklist: string[] = [];
  const title = buildPrTitle(run);

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
  const branchName = deriveBranchName(run);
  const branchResult = await runRuntimeTool(workspace, "git_create_branch", { branch: branchName });
  toolTraces.push(branchResult);
  const branchOut = branchResult.output as { ok?: boolean; branch?: string; reason?: string };
  if (!branchOut.ok) {
    return buildPrResult({
      run, title, url: "pending://pull-request", status: "draft",
      checklist: [...checklist, `创建分支失败: ${branchOut.reason}`], toolTraces,
    });
  }
  checklist.push(`分支: ${branchOut.branch}`);

  // 4. 提交变更
  const commitResult = await runRuntimeTool(workspace, "git_commit_changes", { message: title });
  toolTraces.push(commitResult);
  const commitOut = commitResult.output as { ok?: boolean; committed?: boolean; reason?: string; filesChanged?: number };
  if (commitOut.committed) {
    checklist.push(`已提交 ${commitOut.filesChanged} 个文件`);
  } else {
    checklist.push(commitOut.reason ?? "没有可提交的变更");
  }

  // 5. Push
  const pushResult = await runRuntimeTool(workspace, "git_push_branch", { branch: branchName });
  toolTraces.push(pushResult);
  const pushOut = pushResult.output as { ok?: boolean; reason?: string };

  // 6. 创建 GitHub PR
  let prOut: Record<string, unknown> = {};
  if (commitOut.committed) {
    const prBody = buildPrBody(run);
    const prResult = await runRuntimeTool(workspace, "github_create_pr", {
      title, body: prBody, head: branchName, base: env.GITHUB_BASE_BRANCH,
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
    checklist, branch: branchName, prNumber, pushed: pushOut.ok === true, toolTraces,
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
  const repoWrite = run.steps.find((s) => s.id === "repo_write")?.output as Record<string, unknown> | undefined;

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
  sections.push("\n---\n🤖 Generated with [Conduit Delivery Lab](https://github.com/Alpha5402/conduit-realworld-example-app)");
  return sections.join("\n\n").slice(0, 5_000);
}

function deriveBranchName(run: WorkflowRun): string {
  const slug = (run.title || "workflow")
    .replace(/[^A-Za-z0-9一-鿿\s_-]/g, "")
    .replace(/\s+/g, "-").toLowerCase().slice(0, 30);
  const shortId = run.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `feature/${shortId}-${slug}`;
}

function buildPrResult(opts: {
  run: WorkflowRun;
  title: string;
  url: string;
  status: "draft" | "ready";
  checklist: string[];
  branch?: string;
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
