import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runClarifierAgent } from "../agents/clarifierAgent.js";
import { runPlannerAgent } from "../agents/plannerAgent.js";
import { generateRequirementTitle } from "../agents/requirementIntakeAgent.js";
import { runWorkflowStepAgent } from "../agents/workflowStepAgent.js";
import {
  type CodeGenerationPlan,
  type ClarificationOutput,
  type InterventionMessage,
  type AgentMetric,
  type QualityGateResult,
  type RepoWriteResult,
  type RequirementDraft,
  type SolutionDsl,
  type StepCheck,
  type StepRun,
  type WorkflowExecutionNode,
  type WorkflowExecutionTree,
  type WorkflowRun,
  type WorkflowStepId,
  stepAgents,
  stepLabels,
  stepOrder,
} from "../domain/workflow.js";
import { getLlmUsageFromError, withLlmProjectContext } from "./llmClient.js";
import { getCurrentWorkspace } from "./workspaceService.js";
import { deleteWorkflowRunFromStore, getRequirementCaseByRunFromStore, getSavedWorkspace, getStoredWorkflowRun, saveWorkflowRunToStore } from "./workspaceStore.js";
import { workflowEventBus } from "./workflowEvents.js";
import { getWorkflowSettings } from "./workflowSettingsService.js";
import { getProjectStepExecutionMode } from "./projectSettingsService.js";
import { buildRuntimeMemoryContext } from "./workflowMemory.js";
import { runStepVerifier, type VerifierResult } from "./stepVerifiers.js";
import { resolveConfirmationDecision } from "../workflowExecution/confirmationPolicy.js";
import { resolveRegisteredStepOutput, type WorkflowStepRunOptions } from "../workflowExecution/stepResolverRegistry.js";
import { getSkillStepSpec } from "../skills/skillRegistry.js";
import { saveRequirementCaseFromRun, searchRequirementCases } from "./requirementCaseService.js";

const runs = new Map<string, WorkflowRun>();
const execFileAsync = promisify(execFile);

type CreateWorkflowRunInput = Omit<RequirementDraft, "title"> & {
  title?: string;
  projectId?: string;
};

/**
 * 标记某个 run 是否正在被后台 promise 推进，避免并发 autoContinue 重入。
 */
const advancing = new Set<string>();
const advanceVersions = new Map<string, number>();

/** 读缓存 TTL：5 分钟未访问则从内存淘汰 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cacheTimestamps = new Map<string, number>();

function touchCache(runId: string) {
  cacheTimestamps.set(runId, Date.now());
}

/** 定期淘汰过期缓存条目（每分钟执行一次） */
setInterval(() => {
  const threshold = Date.now() - CACHE_TTL_MS;
  for (const [runId, ts] of cacheTimestamps.entries()) {
    if (ts < threshold && !advancing.has(runId)) {
      runs.delete(runId);
      cacheTimestamps.delete(runId);
    }
  }
}, 60_000).unref();

function now() {
  return new Date().toISOString();
}

function isAgentMetric(value: unknown): value is AgentMetric {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as AgentMetric).agent === "string" &&
    typeof (value as AgentMetric).calls === "number" &&
    typeof (value as AgentMetric).inputTokens === "number" &&
    typeof (value as AgentMetric).outputTokens === "number" &&
    typeof (value as AgentMetric).latencyMs === "number" &&
    typeof (value as AgentMetric).estimatedCost === "number";
}

function extractOutputMetrics(output: unknown): AgentMetric[] {
  if (!output || typeof output !== "object" || !("__metrics" in output)) return [];
  const metrics = (output as { __metrics?: unknown }).__metrics;
  return Array.isArray(metrics) ? metrics.filter(isAgentMetric) : [];
}

function buildFailureMetric(stepId: WorkflowStepId, error: unknown): AgentMetric[] {
  const usage = getLlmUsageFromError(error);
  if (!usage) return [];
  return [{
    agent: stepAgents[stepId],
    calls: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: usage.latencyMs,
    estimatedCost: 0,
  }];
}

/** 使用 run.steps 的当前顺序（而非全局 stepOrder），兼容 7/8 步和历史 run */
function getStepIndex(run: WorkflowRun, stepId: WorkflowStepId): number {
  return run.steps.map((s) => s.id).indexOf(stepId as typeof stepOrder[number]);
}

/** 根据 settings 获取新 run 的 step 顺序（过滤可选步骤） */
function getStepOrderForNewRun(): WorkflowStepId[] {
  const settings = getWorkflowSettings();
  let order = [...stepOrder];
  if (!settings.enabledOptionalSteps.code_review) {
    order = order.filter((id) => id !== "code_review");
  }
  return order as WorkflowStepId[];
}

function createSteps(requirement: RequirementDraft): StepRun[] {
  const order = getStepOrderForNewRun();
  return order.map((stepId, index) => ({
    id: stepId,
    label: stepLabels[stepId],
    agent: stepAgents[stepId],
    status: index === 0 ? "success" : "idle",
    input: index === 0 ? { source: "pm" } : undefined,
    output: index === 0 ? requirement : undefined,
    startedAt: index === 0 ? now() : undefined,
    finishedAt: index === 0 ? now() : undefined,
    logs: index === 0 ? ["需求已接收", "AI Delivery Workspace 已创建任务，自动进入确认需求"] : [],
    interventions: index === 0 ? [{
      id: `${stepId}-agent-${Date.now()}`,
      stepId,
      role: "agent",
      content: "已接收需求，AI 将自动进入下一个阶段。",
      createdAt: now(),
    }] : [],
    replayCount: 0,
    history: [],
  }));
}

/**
 * 对一个有 output 的 step 进行快照（记录当前状态到 history）。
 * 如果 step 没有 output（idle 状态），返回 null 不做快照。
 */
function snapshotStep(step: StepRun, reason: "replay" | "regenerate") {
  if (!step.output) return null;
  return {
    id: `snapshot-${randomUUID()}`,
    output: step.output,
    logs: [...step.logs],
    interventions: step.interventions ? [...step.interventions] : undefined,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    createdAt: now(),
    reason,
  };
}

function createExecutionNode(
  step: StepRun,
  reason: WorkflowExecutionNode["reason"],
  parentNodeId?: string,
): WorkflowExecutionNode {
  return {
    id: `node-${randomUUID()}`,
    stepId: step.id,
    status: step.status,
    input: step.input,
    output: step.output,
    logs: [...step.logs],
    interventions: step.interventions ? [...step.interventions] : undefined,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    createdAt: now(),
    reason,
    parentNodeId,
    childNodeIds: [],
  };
}

function findNearestUpstreamActiveNodeId(run: WorkflowRun, stepIndex: number) {
  const tree = ensureExecutionTree(run);
  for (let index = stepIndex - 1; index >= 0; index -= 1) {
    const upstreamId = run.steps[index]?.id;
    if (!upstreamId) continue;
    const nodeId = tree.stepActiveNodeIds[upstreamId];
    if (nodeId) return nodeId;
  }
  return undefined;
}

function ensureExecutionTree(run: WorkflowRun): WorkflowExecutionTree {
  if (run.executionTree) return run.executionTree;

  const nodes: Record<string, WorkflowExecutionNode> = {};
  const stepActiveNodeIds: WorkflowExecutionTree["stepActiveNodeIds"] = {};
  let parentNodeId: string | undefined;
  let rootNodeId = "";
  let activeNodeId = "";

  for (const step of run.steps) {
    if (step.output === undefined) continue;
    const node = createExecutionNode(step, "initial", parentNodeId);
    nodes[node.id] = node;
    if (parentNodeId && nodes[parentNodeId]) {
      nodes[parentNodeId].childNodeIds.push(node.id);
    }
    if (!rootNodeId) rootNodeId = node.id;
    activeNodeId = node.id;
    stepActiveNodeIds[step.id] = node.id;
    parentNodeId = node.id;
  }

  if (!rootNodeId) {
    const firstStep = run.steps[0];
    if (!firstStep) {
      throw new Error("Workflow run has no steps");
    }
    const node = createExecutionNode(firstStep, "initial");
    nodes[node.id] = node;
    rootNodeId = node.id;
    activeNodeId = node.id;
    stepActiveNodeIds[firstStep.id] = node.id;
  }

  run.executionTree = {
    rootNodeId,
    activeNodeId,
    nodes,
    stepActiveNodeIds,
  };
  return run.executionTree;
}

function appendExecutionNode(
  run: WorkflowRun,
  step: StepRun,
  reason: WorkflowExecutionNode["reason"],
) {
  if (step.output === undefined) return null;
  const stepIndex = getStepIndex(run, step.id);
  const tree = ensureExecutionTree(run);
  const placeholderRoot = tree.nodes[tree.rootNodeId];
  const parentNodeId = findNearestUpstreamActiveNodeId(run, stepIndex)
    ?? (stepIndex === 0 && placeholderRoot?.output === undefined ? tree.rootNodeId : undefined);
  const node = createExecutionNode(step, reason, parentNodeId);
  tree.nodes[node.id] = node;
  if (parentNodeId && tree.nodes[parentNodeId]) {
    tree.nodes[parentNodeId].childNodeIds = Array.from(new Set([
      ...tree.nodes[parentNodeId].childNodeIds,
      node.id,
    ]));
  }
  tree.activeNodeId = node.id;
  tree.stepActiveNodeIds[step.id] = node.id;

  for (let index = stepIndex + 1; index < run.steps.length; index += 1) {
    delete tree.stepActiveNodeIds[run.steps[index].id];
  }

  return node;
}

function getExecutionNode(run: WorkflowRun, nodeId: string) {
  const tree = ensureExecutionTree(run);
  const node = tree.nodes[nodeId];
  if (!node) throw new Error(`Execution node not found: ${nodeId}`);
  return node;
}

function getActivePathNodeIds(run: WorkflowRun) {
  const tree = ensureExecutionTree(run);
  const path: string[] = [];
  let current = tree.nodes[tree.activeNodeId];
  while (current) {
    path.unshift(current.id);
    current = current.parentNodeId ? tree.nodes[current.parentNodeId] : undefined;
  }
  return path;
}

function restoreExecutionNodeInMemory(run: WorkflowRun, nodeId: string) {
  const tree = ensureExecutionTree(run);
  const node = getExecutionNode(run, nodeId);
  const stepIndex = getStepIndex(run, node.stepId);
  if (stepIndex < 0) throw new Error(`Step not found: ${node.stepId}`);

  tree.activeNodeId = node.id;
  const activePath = getActivePathNodeIds(run);
  tree.stepActiveNodeIds = {};
  for (const pathNodeId of activePath) {
    const pathNode = tree.nodes[pathNodeId];
    if (pathNode) tree.stepActiveNodeIds[pathNode.stepId] = pathNodeId;
  }

  run.steps = run.steps.map((current, index) => {
    const activeNodeId = tree.stepActiveNodeIds[current.id];
    const activeNode = activeNodeId ? tree.nodes[activeNodeId] : undefined;
    if (index <= stepIndex && activeNode) {
      return {
        ...current,
        status: current.id === node.stepId ? "waiting-human" as const : activeNode.status,
        input: activeNode.input,
        output: activeNode.output,
        logs: [...activeNode.logs, `已切换到执行树节点 (${activeNode.reason}, ${activeNode.createdAt})`],
        interventions: activeNode.interventions,
        startedAt: activeNode.startedAt,
        finishedAt: activeNode.finishedAt,
      };
    }

    if (index > stepIndex) {
      return {
        ...current,
        status: "idle" as const,
        input: undefined,
        output: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        logs: current.logs.length ? [...current.logs, "因执行路径切换，此步骤结果已失效，需重新生成"] : [],
      };
    }

    return current;
  });

  run.activeStepId = node.stepId;
  run.steps = propagateInputDownstream(run.steps, stepIndex, node.output);
  return node;
}

function collectExecutionSubtreeNodeIds(tree: WorkflowExecutionTree, nodeId: string) {
  const ids = new Set<string>();
  const visit = (currentId: string) => {
    if (ids.has(currentId)) return;
    ids.add(currentId);
    const current = tree.nodes[currentId];
    for (const childId of current?.childNodeIds ?? []) {
      visit(childId);
    }
  };
  visit(nodeId);
  return ids;
}

function deleteExecutionNodeInMemory(run: WorkflowRun, nodeId: string) {
  const tree = ensureExecutionTree(run);
  const node = getExecutionNode(run, nodeId);
  if (node.id === tree.rootNodeId) {
    throw new Error("Cannot delete execution tree root node");
  }

  const activePath = getActivePathNodeIds(run);
  if (activePath.includes(node.id)) {
    throw new Error("Cannot delete a node on the current active execution path");
  }

  const deleteIds = collectExecutionSubtreeNodeIds(tree, node.id);
  if (node.parentNodeId && tree.nodes[node.parentNodeId]) {
    tree.nodes[node.parentNodeId].childNodeIds = tree.nodes[node.parentNodeId].childNodeIds.filter(
      (childId) => childId !== node.id,
    );
  }

  for (const id of deleteIds) {
    delete tree.nodes[id];
  }
  for (const [stepId, activeNodeId] of Object.entries(tree.stepActiveNodeIds)) {
    if (activeNodeId && deleteIds.has(activeNodeId)) {
      delete tree.stepActiveNodeIds[stepId as WorkflowStepId];
    }
  }
  return deleteIds;
}

function getCodeGenerationChanges(output: unknown) {
  const codegen = output as (CodeGenerationPlan & {
    repoWriteResult?: RepoWriteResult;
    filesChanged?: RepoWriteResult["filesChanged"];
    appliedChanges?: RepoWriteResult["appliedChanges"];
  }) | undefined;
  const repoResult = codegen?.repoWriteResult
    ?? (codegen?.filesChanged || codegen?.appliedChanges ? codegen as unknown as RepoWriteResult : undefined);
  const changes = repoResult?.appliedChanges?.length
    ? repoResult.appliedChanges
    : repoResult?.filesChanged ?? [];

  return Array.from(new Map(changes.map((change) => [change.path, change])).values());
}

async function isGitTracked(workspaceDir: string, relativePath: string) {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: workspaceDir,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function revertPreviousCodeGenerationChanges(step: StepRun) {
  const changes = getCodeGenerationChanges(step.output);
  if (changes.length === 0) return;

  const workspace = getCurrentWorkspace();
  if (!workspace?.workspaceDir) {
    throw new Error("无法重跑生成代码：当前 workspace 不可用，无法撤销上一次生成结果。");
  }

  const workspaceRoot = path.resolve(workspace.workspaceDir);
  const restored: string[] = [];
  const removed: string[] = [];

  for (const change of changes) {
    const normalizedPath = change.path.replaceAll("\\", "/");
    if (!normalizedPath || normalizedPath.includes("..") || path.isAbsolute(normalizedPath)) {
      throw new Error(`无法撤销生成代码变更：非法路径 ${change.path}`);
    }

    const absolutePath = path.resolve(workspaceRoot, normalizedPath);
    if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error(`无法撤销生成代码变更：路径越界 ${change.path}`);
    }

    const tracked = workspace.hasRepository
      ? await isGitTracked(workspaceRoot, normalizedPath)
      : false;

    if (tracked) {
      await execFileAsync("git", ["restore", "--staged", "--worktree", "--", normalizedPath], {
        cwd: workspaceRoot,
        timeout: 10_000,
      });
      restored.push(normalizedPath);
      continue;
    }

    if (existsSync(absolutePath)) {
      await rm(absolutePath, { recursive: true, force: true });
      removed.push(normalizedPath);
    }
  }

  step.logs = [
    ...step.logs,
    `重跑生成代码前已撤销上一次生成结果：恢复 ${restored.length} 个 tracked 文件，移除 ${removed.length} 个新增文件。旧 diff 已保存在历史版本中，可随时还原。`,
  ];
}

async function applyCodeGenerationSnapshotChanges(output: unknown) {
  const changes = getCodeGenerationChanges(output);
  const patch = changes
    .map((change) => change.contentPreview?.trim())
    .filter((content): content is string => Boolean(content))
    .join("\n\n");
  if (!patch.trim()) return;

  const workspace = getCurrentWorkspace();
  if (!workspace?.workspaceDir || !workspace.hasRepository) {
    throw new Error("无法还原代码生成历史版本：当前 workspace 不是可用 git 仓库。");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-delivery-restore-"));
  const patchPath = path.join(tempDir, "snapshot.patch");
  try {
    await writeFile(patchPath, `${patch}\n`, "utf-8");
    await execFileAsync("git", ["apply", "--whitespace=nowarn", patchPath], {
      cwd: workspace.workspaceDir,
      timeout: 15_000,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function persistRun(run: WorkflowRun) {
  ensureExecutionTree(run);
  const projectId = run.projectId ?? getCurrentWorkspace()?.id;
  if (projectId) {
    saveWorkflowRunToStore(projectId, { ...run, projectId });
  }
}

function isRunSuccessful(run: WorkflowRun) {
  return run.steps.length > 0 && run.steps.every((step) => step.status === "success");
}

function withCurrentCaseState(run: WorkflowRun): WorkflowRun {
  ensureExecutionTree(run);
  const item = getRequirementCaseByRunFromStore(run.id);
  return {
    ...run,
    caseId: item?.id,
    caseFavorited: Boolean(item),
  };
}

async function recallRequirementCasesForCodeGeneration(run: WorkflowRun, solution: SolutionDsl) {
  const projectId = run.projectId;
  if (!projectId) return [];

  const requirement = run.steps.find((step) => step.id === "requirement_intake")?.output as RequirementDraft | undefined;
  const clarification = run.steps.find((step) => step.id === "clarification")?.output as ClarificationOutput | undefined;
  if (!requirement) return [];

  const workspace = getSavedWorkspace(projectId) ?? getCurrentWorkspace() ?? undefined;
  const confirmedDecisions = (clarification?.decisions ?? [])
    .map((decision) => `${decision.title}: ${decision.finalAnswer}`);
  const searchableRequirement: RequirementDraft = {
    ...requirement,
    rawText: [
      requirement.rawText,
      `技术范围：${solution.scope}`,
      clarification?.summary,
      solution.userStory,
      ...(solution.acceptanceCriteria ?? []),
      ...(solution.dataContract?.affectedSurfaces ?? []),
      ...(solution.dataContract?.constraints ?? []),
      ...confirmedDecisions,
    ].filter(Boolean).join("\n"),
  };

  return searchRequirementCases(projectId, searchableRequirement, workspace);
}

function buildDefaultSelectedCaseIds(run: WorkflowRun) {
  return (run.recalledCases ?? [])
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 1)
    .map((item) => item.id);
}

/**
 * 统一的"持久化 → 缓存写回 → SSE 广播"出口。
 * SQLite 是 source-of-truth，内存 Map 仅为读缓存。
 * 任何 mutate 完成后必须调用一次。
 */
function commitRun(run: WorkflowRun) {
  run.updatedAt = now();
  // 1. 尝试写 SQLite（source-of-truth），失败记录日志但不阻断内存状态机。
  //    内存缓存 + SSE 广播仍正常进行，避免持久化瞬时故障导致整个 workflow 卡死。
  try {
    persistRun(run);
  } catch (err) {
    console.error(
      JSON.stringify({
        scope: "workflow",
        event: "persist.degraded",
        runId: run.id,
        message: err instanceof Error ? err.message : "unknown SQLite write error",
        timestamp: new Date().toISOString(),
      }),
    );
    // 标记本次 commit 持久化降级，方便调试和运维排查
    (run as Record<string, unknown>)._persistDegraded = true;
  }
  // 2. 再更新内存缓存
  runs.set(run.id, run);
  touchCache(run.id);
  // 3. 广播 SSE
  workflowEventBus.emitUpdate(run);
  return run;
}

export function getWorkflowRun(runId: string) {
  // 1. 读缓存
  const cached = runs.get(runId);
  if (cached) {
    touchCache(runId);
    return withCurrentCaseState(cached);
  }

  // 2. Cache miss → 从 SQLite 加载
  const stored = getStoredWorkflowRun(runId) ?? undefined;
  if (stored) {
    runs.set(stored.id, stored);
    touchCache(stored.id);
  }

  return stored ? withCurrentCaseState(stored) : stored;
}

export async function createWorkflowRun(input: CreateWorkflowRunInput) {
  const timestamp = now();
  const title = input.title?.trim() || await generateRequirementTitle(input.rawText);
  const requirement: RequirementDraft = {
    title,
    rawText: input.rawText,
    pattern: input.pattern,
    targetRepo: input.targetRepo,
  };
  const run: WorkflowRun = {
    id: `run-${randomUUID()}`,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    projectId: input.projectId ?? getCurrentWorkspace()?.id,
    activeStepId: "clarification",
    steps: createSteps(requirement),
  };
  ensureExecutionTree(run);

  commitRun(run);

  // 立即返回快照，autoContinue 在后台推进；前端通过 SSE 拿到增量。
  void scheduleAutoContinue(run.id);

  return run;
}

export function updateStepOutput(runId: string, stepId: WorkflowStepId, output: unknown) {
  const run = getExistingRun(runId);
  const stepIndex = getStepIndex(run, stepId as typeof stepOrder[number]);

  run.steps = run.steps.map((step) => {
    if (step.id === stepId) {
      return { ...step, output, logs: [...step.logs, "人工修订了 Step JSON 输出"] };
    }
    return step;
  });

  // 向下传播：刷新下一步的 input 保持前端展示与后端 resolveStepOutput 一致。
  run.steps = propagateInputDownstream(run.steps, stepIndex, output);

  return commitRun(run);
}

export async function replayFromStep(
  runId: string,
  stepId: WorkflowStepId,
  options?: {
    interventions?: InterventionMessage[];
    codeReviewContext?: "default" | "from-code-review" | "omit";
    revertCodeGenerationChanges?: boolean;
  },
) {
  if (stepId === "requirement_intake") {
    throw new Error("接收需求是初始输入阶段，不能重放");
  }

  const run = getExistingRun(runId);
  const replayIndex = getStepIndex(run, stepId as typeof stepOrder[number]);
  if (replayIndex < 0) {
    throw new Error(`Step not found: ${stepId}`);
  }
  const replayStep = run.steps[replayIndex];

  const hasExplicitInterventions = options ? Object.prototype.hasOwnProperty.call(options, "interventions") : false;
  let injectedInterventions = hasExplicitInterventions ? options?.interventions : undefined;
  if (!hasExplicitInterventions && stepId === "code_generation" && options?.codeReviewContext === "from-code-review") {
    injectedInterventions = buildCodeReviewInterventionsForCodeGeneration(run);
  } else if (!hasExplicitInterventions && stepId === "code_generation" && options?.codeReviewContext === "omit") {
    injectedInterventions = [];
  } else if (!hasExplicitInterventions && stepId === "code_generation") {
    injectedInterventions = [];
  }

  const shouldRevertCodeGeneration = stepId === "code_generation" && options?.revertCodeGenerationChanges !== false;

  console.log("[workflow-replay][service]", JSON.stringify({
    runId,
    stepId,
    replayIndex,
    previousStatus: replayStep.status,
    codeReviewContext: options?.codeReviewContext ?? null,
    revertCodeGenerationChanges: shouldRevertCodeGeneration,
    hasExplicitInterventions,
    injectedInterventions: injectedInterventions?.length ?? null,
  }));

  if (shouldRevertCodeGeneration) {
    await revertPreviousCodeGenerationChanges(replayStep);
  }

  run.activeStepId = stepId;
  advanceVersions.set(run.id, (advanceVersions.get(run.id) ?? 0) + 1);
  const version = advanceVersions.get(run.id) ?? 0;
  advancing.delete(run.id);
  run.steps = run.steps.map((step, index) => {
    if (index < replayIndex) {
      return step;
    }

    // 快照当前状态（仅有 output 时才快照，避免记录空 step）
    const snapshot = snapshotStep(step, "replay");
    const updatedHistory = snapshot ? [...(step.history ?? []), snapshot] : (step.history ?? []);
    const updatedCount = snapshot ? (step.replayCount ?? 0) + 1 : (step.replayCount ?? 0);

    if (index === replayIndex) {
      return {
        ...step,
        status: "idle",
        input: undefined,
        output: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        interventions: injectedInterventions ?? [],
        logs: [
          ...step.logs,
          "从这里开始重放下游流程",
          stepId === "code_generation" && options?.codeReviewContext === "from-code-review"
            ? "生成代码将注入上一次代码审查意见"
            : stepId === "code_generation"
              ? shouldRevertCodeGeneration
                ? "生成代码将按当前需求和方案重新生成，不注入代码审查意见"
                : "生成代码将按代码审查意见做增量修复，保留已有变更"
              : "Runtime 将根据 Step 模式自动继续，直到需要人工介入",
        ],
        replayCount: updatedCount,
        history: updatedHistory,
      };
    }

    return {
      ...step,
      status: "idle",
      input: undefined,
      output: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      interventions: [],
      logs: [],
      replayCount: updatedCount,
      history: updatedHistory,
    };
  });
  commitRun(run);

  // replay 必须立即进入 running，避免前端只看到 idle 闪烁但后台未真正重跑。
  const runStepOptions = stepId === "code_generation"
    ? {
      interventions: injectedInterventions ?? [],
      executionReason: options?.codeReviewContext === "from-code-review" || options?.revertCodeGenerationChanges === false
        ? "review-retry" as const
        : "replay" as const,
    }
    : injectedInterventions !== undefined
      ? { interventions: injectedInterventions, executionReason: "replay" as const }
      : { executionReason: "replay" as const };
  console.log("[workflow-replay][service-runStep]", JSON.stringify({
    runId: run.id,
    stepId,
    version,
    runStepInterventions: runStepOptions?.interventions?.length ?? null,
    activeStepId: run.activeStepId,
  }));
  return runStep(run.id, stepId, undefined, version, runStepOptions);
}

/**
 * 显式确认某个处于 waiting-human 的步骤，并触发后续 autoContinue。
 * 与 runStep（"重新生成"）严格区分，避免之前两种语义共用一个入口的歧义。
 */
export async function confirmStep(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const stepIndex = getStepIndex(run, stepId as typeof stepOrder[number]);
  const step = run.steps[stepIndex];
  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  if (step.status !== "waiting-human") {
    throw new Error(`Step ${stepId} is not waiting for confirmation (status=${step.status})`);
  }

  if (stepId === "solution_design" && run.recalledCaseSelection?.status === "pending") {
    throw new Error("请先确认是否使用召回的历史案例");
  }

  if (step.output === undefined) {
    throw new Error(`Step ${stepId} has no output to confirm`);
  }

  const nextStepId = run.steps[stepIndex + 1]?.id ?? stepId;
  run.activeStepId = nextStepId;
  advanceVersions.set(run.id, (advanceVersions.get(run.id) ?? 0) + 1);
  const version = advanceVersions.get(run.id) ?? 0;
  advancing.delete(run.id);
  run.steps = run.steps.map((current) => {
    if (current.id === stepId) {
      return {
        ...current,
        status: "success",
        finishedAt: current.finishedAt ?? now(),
        logs: [...current.logs, "User confirmed; Runtime auto-continue resumed"],
      };
    }
    return current;
  });
  const tree = ensureExecutionTree(run);
  const activeNodeId = tree.stepActiveNodeIds[stepId];
  const activeNode = activeNodeId ? tree.nodes[activeNodeId] : undefined;
  if (activeNode) {
    activeNode.status = "success";
    activeNode.finishedAt = activeNode.finishedAt ?? now();
    activeNode.logs = [...activeNode.logs, "User confirmed; Runtime auto-continue resumed"];
  }
  run.steps = propagateInputDownstream(run.steps, stepIndex, step.output);
  commitRun(run);

  workflowEventBus.emitStepEvent({
    type: "step",
    runId: run.id,
    stepId,
    phase: "completed",
    message: "user-confirmed",
  });

  const nextStep = run.steps.find((current) => current.id === nextStepId);
  if (nextStep && nextStep.id !== stepId && nextStep.output === undefined) {
    return runStep(run.id, nextStep.id, undefined, version);
  }

  void scheduleAutoContinue(run.id);
  return run;
}

export async function confirmRecalledCases(runId: string, selectedCaseIds: string[]) {
  const run = getExistingRun(runId);
  const solutionStep = run.steps.find((step) => step.id === "solution_design");
  if (!solutionStep || solutionStep.status !== "waiting-human") {
    throw new Error("当前流程不在历史案例确认阶段");
  }
  if (!run.recalledCases?.length || run.recalledCaseSelection?.status !== "pending") {
    throw new Error("当前流程没有待确认的历史案例召回");
  }

  const candidateIds = new Set(run.recalledCases.map((item) => item.id));
  const uniqueSelectedIds = Array.from(new Set(selectedCaseIds));
  const invalidIds = uniqueSelectedIds.filter((id) => !candidateIds.has(id));
  if (invalidIds.length > 0) {
    throw new Error(`历史案例选择无效: ${invalidIds.join(", ")}`);
  }

  run.recalledCaseSelection = {
    ...run.recalledCaseSelection,
    status: uniqueSelectedIds.length > 0 ? "confirmed" : "skipped",
    selectedCaseIds: uniqueSelectedIds,
    confirmedAt: now(),
  };
  commitRun(run);

  return confirmStep(runId, "solution_design");
}

/**
 * 总是"重新生成当前 step 的 output"。
 *
 * 进入此函数时无论 step 当前是什么状态，都会：
 * - 立即写入 running 快照并广播；
 * - 在后台 promise 中调用对应 Agent；
 * - 完成后根据执行模式（automatic vs manual-confirmation）决定是否继续推进；
 * - 失败则把 step 标 failed 并广播。
 */
export async function runStep(
  runId: string,
  stepId: WorkflowStepId,
  options?: WorkflowStepRunOptions,
  version = advanceVersions.get(runId) ?? 0,
  runStepOptions?: { interventions?: InterventionMessage[]; executionReason?: WorkflowExecutionNode["reason"] },
) {
  const run = getExistingRun(runId);
  const stepIndex = getStepIndex(run, stepId as typeof stepOrder[number]);
  const step = run.steps[stepIndex];

  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  // 显式 reset：消除旧的 waiting-human / failed 等状态，确保语义清晰。
  // 在 reset 前快照当前 step（仅有 output 时）以保留重跑历史。
  run.activeStepId = stepId;
  run.steps = run.steps.map((current) => {
    if (current.id !== stepId) return current;
    const snapshot = snapshotStep(current, "regenerate");
    const nextInterventions = runStepOptions && Object.prototype.hasOwnProperty.call(runStepOptions, "interventions")
      ? runStepOptions.interventions
      : current.interventions;
    return {
      ...current,
      status: "running",
      output: undefined,
      startedAt: now(),
      finishedAt: undefined,
      metrics: undefined,
      interventions: nextInterventions,
      logs: [...current.logs, `${current.agent} started`],
      replayCount: snapshot ? (current.replayCount ?? 0) + 1 : (current.replayCount ?? 0),
      history: snapshot ? [...(current.history ?? []), snapshot] : (current.history ?? []),
    };
  });
  commitRun(run);

  console.log("[workflow-replay][runStep-started]", JSON.stringify({
    runId: run.id,
    stepId,
    version,
    status: runs.get(run.id)?.steps.find((current) => current.id === stepId)?.status,
    interventions: runs.get(run.id)?.steps.find((current) => current.id === stepId)?.interventions?.length ?? 0,
  }));

  workflowEventBus.emitStepEvent({
    type: "step",
    runId: run.id,
    stepId,
    phase: "started",
  });

  // 后台异步推进；调用方拿到的是"刚切到 running"的快照。
  void executeStepAndAdvance(run.id, stepId, options, version, runStepOptions?.executionReason);

  return runs.get(run.id) ?? run;
}

async function executeStepAndAdvance(
  runId: string,
  stepId: WorkflowStepId,
  options?: WorkflowStepRunOptions,
  version = advanceVersions.get(runId) ?? 0,
  executionReason: WorkflowExecutionNode["reason"] = "continue",
) {
  const MAX_REPAIR_ATTEMPTS = 1;

  try {
    console.log("[workflow-replay][execute-start]", JSON.stringify({
      runId,
      stepId,
      version,
      currentVersion: advanceVersions.get(runId) ?? 0,
    }));
    if ((advanceVersions.get(runId) ?? 0) !== version) return;
    const run = getExistingRun(runId);
    const stepIndex = getStepIndex(run, stepId as typeof stepOrder[number]);
    console.log("[workflow-replay][execute-resolved-run]", JSON.stringify({
      runId,
      stepId,
      stepIndex,
      activeStepId: run.activeStepId,
      status: run.steps[stepIndex]?.status,
    }));

    // ---- 先切换到 running，让 SSE 前端立刻看到进度 ----
    run.steps = run.steps.map((current) =>
      current.id === stepId
        ? { ...current, status: "running" as const, startedAt: current.startedAt ?? now() }
        : current,
    );
    if ((advanceVersions.get(runId) ?? 0) !== version) return;
    commitRun(run);
    workflowEventBus.emitStepEvent({
      type: "step",
      runId,
      stepId,
      phase: "started",
    });

    // ---- 生成 → 校验 → (可选)修复一次 ----
    let output = await withLlmProjectContext(run.projectId, () => resolveStepOutput(run, stepId, { runOptions: options }));
    const stepMetrics = extractOutputMetrics(output);
    if ((advanceVersions.get(runId) ?? 0) !== version) return;
    const workspace = getCurrentWorkspace() ?? undefined;
    let verifier: VerifierResult = runStepVerifier(stepId, output, workspace);
    let repairAttempts = 0;
    const repairLogs: string[] = [];

    while (
      verifier.qualityGate.decision === "repair" &&
      repairAttempts < MAX_REPAIR_ATTEMPTS
    ) {
      repairAttempts += 1;
      repairLogs.push(`触发自动修复 (attempt ${repairAttempts}/${MAX_REPAIR_ATTEMPTS})`);
      for (const reason of verifier.qualityGate.reasons) {
        repairLogs.push(`  · 待修复: ${reason}`);
      }
      // 简化版 repair 策略:把上一轮 output + reasons 作为 followUp 上下文塞回 agent。
      // clarification 走 ClarifierAgent 的 follow-up 分支;其他 step 暂时直接重跑(由 LLM 自身在新 prompt 中重试)。
      try {
        const followUp = stepId === "clarification"
          ? { previousOutput: output, reasons: verifier.qualityGate.reasons }
          : undefined;
        output = await withLlmProjectContext(run.projectId, () => resolveStepOutput(run, stepId, followUp ? { followUp, runOptions: options } : { runOptions: options }));
        stepMetrics.push(...extractOutputMetrics(output));
        if ((advanceVersions.get(runId) ?? 0) !== version) return;
        verifier = runStepVerifier(stepId, output, workspace);
        verifier.qualityGate.repairAttempts = repairAttempts;
      } catch (error) {
        repairLogs.push(`修复执行失败: ${error instanceof Error ? error.message : "unknown"}`);
        break;
      }
    }

    if ((advanceVersions.get(runId) ?? 0) !== version) return;
    const latest = getExistingRun(runId);
    if (stepId === "solution_design") {
      latest.recalledCases = await recallRequirementCasesForCodeGeneration(latest, output as SolutionDsl);
      latest.recalledCaseSelection = latest.recalledCases.length > 0
        ? {
          status: "pending",
          defaultSelectedCaseIds: buildDefaultSelectedCaseIds(latest),
          selectedCaseIds: [],
        }
        : undefined;
    }
    const mode = getProjectStepExecutionMode(latest.projectId, stepId);
    const gateDecision = verifier.qualityGate.decision;

    // PR3: 通过 confirmation policy 统一计算是否自动推进
    const skillSpec = getSkillStepSpec(latest, stepId, getCurrentWorkspace() ?? undefined);
    const confirmation = resolveConfirmationDecision({
      run: latest,
      stepId,
      output,
      qualityGate: verifier.qualityGate,
      executionMode: mode,
      skillConfirmationPolicyAddon: skillSpec.confirmationPolicyAddon,
    });

    const shouldWaitForRecalledCaseSelection = stepId === "solution_design" && (latest.recalledCases?.length ?? 0) > 0;
    const shouldAutoContinue = shouldWaitForRecalledCaseSelection ? false : confirmation.shouldAutoContinue;
    const nextStatus = shouldWaitForRecalledCaseSelection ? "waiting-human" as const : confirmation.nextStatus;

    const nextStepId = run.steps[stepIndex + 1]?.id ?? stepId;
    latest.activeStepId = shouldAutoContinue ? nextStepId : stepId;

    const gateLogs = buildGateLogs(verifier.qualityGate, mode, confirmation);
    const skillDiagnosticLogs = buildSkillDiagnosticLogs(skillSpec);
    logSkillDiagnostics(runId, stepId, skillSpec);

    latest.steps = latest.steps.map((current, index) => {
      if (current.id === stepId) {
        const repairPhases = repairAttempts > 0 ? [{
          id: `${stepId}-repair-${Date.now()}`,
          kind: "repair" as const,
          name: `自动修复 ${repairAttempts} 次`,
          status: gateDecision === "auto-continue" ? "success" as const : "failed" as const,
          finishedAt: now(),
          message: repairLogs.join("; "),
        }] : [];
        return {
          ...current,
          status: nextStatus,
          output,
          metrics: stepMetrics,
          finishedAt: now(),
          checks: verifier.checks,
          qualityGate: verifier.qualityGate,
          repairAttempts: (current.repairAttempts ?? 0) + repairAttempts,
          phases: [
            ...(current.phases ?? []),
            {
              id: `${stepId}-generate-${Date.now()}`,
              kind: "generate",
              name: `${stepAgents[stepId]} 生成产物`,
              status: "success",
              finishedAt: now(),
            },
            ...repairPhases,
            {
              id: `${stepId}-gate-${Date.now()}`,
              kind: "gate",
              name: "Quality Gate 决策",
              status: gateDecision === "auto-continue" ? "success" : "failed",
              finishedAt: now(),
              message: verifier.qualityGate.reasons.join("; "),
            },
          ],
          logs: [
            ...current.logs,
            `${current.agent} finished`,
            ...skillDiagnosticLogs,
            ...repairLogs,
            ...(shouldWaitForRecalledCaseSelection ? ["已召回历史案例，等待用户选择是否用于代码生成"] : []),
            ...gateLogs,
          ],
          interventions: nextStatus === "waiting-human"
            ? [...(current.interventions ?? []), {
              id: `${stepId}-agent-${Date.now()}`,
              stepId,
              role: "agent",
              content: buildGateInterventionMessage(verifier.qualityGate),
              createdAt: now(),
            }]
            : current.interventions,
        };
      }

      if (shouldAutoContinue && index === stepIndex + 1) {
        return { ...current, input: output };
      }

      return current;
    });
    const completedStep = latest.steps.find((current) => current.id === stepId);
    if (completedStep) {
      appendExecutionNode(latest, completedStep, executionReason);
    }
    commitRun(latest);

    workflowEventBus.emitStepEvent({
      type: "step",
      runId,
      stepId,
      phase: nextStatus === "success"
        ? "completed"
        : nextStatus === "failed"
          ? "failed"
          : "waiting-human",
      message: verifier.qualityGate.reasons[0],
    });

    if (shouldAutoContinue) {
      await advanceWorkflow(runId, version);
    }
  } catch (error) {
    if ((advanceVersions.get(runId) ?? 0) !== version) return;
    const latest = getWorkflowRun(runId);
    if (!latest) {
      return;
    }

    const failureMetrics = buildFailureMetric(stepId, error);
    latest.steps = latest.steps.map((current) => current.id === stepId ? {
      ...current,
      status: "failed",
      metrics: failureMetrics.length ? [...(current.metrics ?? []), ...failureMetrics] : current.metrics,
      finishedAt: now(),
      logs: [...current.logs, error instanceof Error ? error.message : "Agent 执行失败"],
    } : current);
    commitRun(latest);

    workflowEventBus.emitStepEvent({
      type: "step",
      runId,
      stepId,
      phase: "failed",
      message: error instanceof Error ? error.message : undefined,
    });
  }
}

function buildGateLogs(
  gate: QualityGateResult,
  mode: "automatic" | "manual-confirmation",
  confirmation?: { reasons: string[]; appliedPolicy?: { source: string; mode?: string } },
): string[] {
  const decisionLabel: Record<QualityGateResult["decision"], string> = {
    "auto-continue": "Quality Gate: auto-continue ✓",
    "need-human": "Quality Gate: 需要人工确认 ⚠",
    "repair": "Quality Gate: 触发自动修复 ↻",
    "block": "Quality Gate: 阻断 ✗",
  };
  const out = [decisionLabel[gate.decision]];
  for (const reason of gate.reasons) {
    out.push(`  · ${reason}`);
  }
  // PR3: 记录 confirmation policy 决策原因
  if (confirmation) {
    for (const reason of confirmation.reasons) {
      out.push(`  · [policy] ${reason}`);
    }
    if (confirmation.appliedPolicy) {
      out.push(`  · [policy source] ${confirmation.appliedPolicy.source}${confirmation.appliedPolicy.mode ? ` (${confirmation.appliedPolicy.mode})` : ""}`);
    }
  }
  if (mode === "automatic" && gate.decision !== "auto-continue") {
    out.push("配置为 automatic,但 Quality Gate 未通过,改为等待人工确认");
  }
  return out;
}

function buildSkillDiagnosticLogs(skillSpec: ReturnType<typeof getSkillStepSpec>) {
  const diagnostics = skillSpec.skillDiagnostics;
  if (!diagnostics) return [];
  const topCandidates = diagnostics.candidates.slice(0, 3).map((candidate) => {
    const reasons = candidate.rejectionReasons.length ? `; reasons=${candidate.rejectionReasons.join("|")}` : "";
    const hits = [
      candidate.hitKeywords.length ? `keywords=${candidate.hitKeywords.join(",")}` : "",
      candidate.hitRouteHints.length ? `routeHints=${candidate.hitRouteHints.join(",")}` : "",
      candidate.hitFileGlobs.length ? `fileGlobs=${candidate.hitFileGlobs.join(",")}` : "",
    ].filter(Boolean).join("; ");
    return `${candidate.id}[${candidate.source ?? "unknown"}] score=${candidate.score} eligible=${candidate.eligible} hasStep=${candidate.hasStep}${hits ? `; ${hits}` : ""}${reasons}`;
  });
  return [
    `Skill diagnostics: step=${diagnostics.stepId ?? "unknown"} projectSkills=${diagnostics.projectSkillCount} publicSkills=${diagnostics.publicSkillCount} pattern=${diagnostics.requirementPattern ?? "unknown"} scope=${diagnostics.inferredScope ?? "unknown"} selected=${diagnostics.selectedSkillId ?? "none"} selectedHasStep=${diagnostics.selectedSkillHasStep ?? false}`,
    ...topCandidates.map((candidate) => `Skill candidate: ${candidate}`),
  ];
}

function logSkillDiagnostics(
  runId: string,
  stepId: WorkflowStepId,
  skillSpec: ReturnType<typeof getSkillStepSpec>,
) {
  const diagnostics = skillSpec.skillDiagnostics;
  if (!diagnostics) return;
  console.log("[skill-diagnostics]", JSON.stringify({
    runId,
    stepId,
    projectSkillCount: diagnostics.projectSkillCount,
    publicSkillCount: diagnostics.publicSkillCount,
    excludedPublicSkillIds: diagnostics.excludedPublicSkillIds,
    requirementPattern: diagnostics.requirementPattern,
    inferredScope: diagnostics.inferredScope,
    selectedSkillId: diagnostics.selectedSkillId,
    selectedSkillSource: diagnostics.selectedSkillSource,
    selectedSkillHasStep: diagnostics.selectedSkillHasStep,
    candidates: diagnostics.candidates.slice(0, 5).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      source: candidate.source,
      score: candidate.score,
      eligible: candidate.eligible,
      hasStep: candidate.hasStep,
      hitKeywords: candidate.hitKeywords,
      hitRouteHints: candidate.hitRouteHints,
      hitFileGlobs: candidate.hitFileGlobs,
      rejectionReasons: candidate.rejectionReasons,
    })),
  }));
}

function buildGateInterventionMessage(gate: QualityGateResult): string {
  if (gate.decision === "auto-continue") {
    return "我已生成当前 Step 的结构化结果,Quality Gate 通过,等待人工确认或自动续跑。";
  }
  if (gate.decision === "block") {
    return `当前 Step 被阻断: ${gate.reasons.join("; ")}`;
  }
  if (gate.decision === "repair") {
    return `当前 Step 校验未通过,准备触发一次自动修复: ${gate.reasons.join("; ")}`;
  }
  return `当前 Step 校验需要人工确认: ${gate.reasons.join("; ")}`;
}

export async function addInterventionAndRegenerate(runId: string, stepId: WorkflowStepId, message: string) {
  const run = getExistingRun(runId);
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  const userMessage: InterventionMessage = {
    id: `${stepId}-user-${Date.now()}`,
    stepId,
    role: "user",
    content: message,
    createdAt: now(),
  };
  const agentMessage: InterventionMessage = {
    id: `${stepId}-agent-intervention-${Date.now()}`,
    stepId,
    role: "agent",
    content: "已记录你的修正，将基于这段 Runtime Memory 重新生成当前 Step。",
    createdAt: now(),
  };

  // Legacy repo_write 反馈需要回退到 code_generation 重跑（新 run 已没有独立 repo_write stage）。
  if (stepId === "repo_write") {
    // 将用户反馈注入 code_generation 的 interventions，确保重跑时模型能看到
    const codegenFeedback: InterventionMessage = {
      id: `code_generation-user-${Date.now()}`,
      stepId: "code_generation",
      role: "user",
      content: `来自生成代码反馈：${message}`,
      createdAt: now(),
    };
    const codegenAgentMsg: InterventionMessage = {
      id: `code_generation-agent-${Date.now()}`,
      stepId: "code_generation",
      role: "agent",
      content: "已记录生成代码阶段的用户反馈，将重新生成代码。",
      createdAt: now(),
    };

    run.steps = run.steps.map((current) => {
      if (current.id === "code_generation") {
        return {
          ...current,
          status: "idle" as const,
          output: undefined,
          finishedAt: undefined,
          interventions: [...(current.interventions ?? []), codegenFeedback, codegenAgentMsg],
          logs: [...current.logs, "下游 repo_write 用户反馈要求重新生成代码"],
        };
      }
      if (current.id === "repo_write") {
        return {
          ...current,
          status: "idle" as const,
          output: undefined,
          finishedAt: undefined,
          interventions: [...(current.interventions ?? []), userMessage, agentMessage],
          logs: [...current.logs, "用户提交反馈，回退到代码生成阶段"],
        };
      }
      return current;
    });

    run.activeStepId = "code_generation";
    commitRun(run);

    void scheduleAutoContinue(run.id, "code_generation");
    return runs.get(run.id) ?? run;
  }

  // TODO 3：显式 reset，避免 runStep 误进 confirm 分支（旧逻辑会把"提了介入"解释成"确认通过"）。
  run.steps = run.steps.map((current) => current.id === stepId
    ? {
      ...current,
      status: "idle",
      output: undefined,
      finishedAt: undefined,
      interventions: [...(current.interventions ?? []), userMessage, agentMessage],
      logs: [...current.logs, "User intervention submitted", "Regenerating current step"],
    }
    : current);
  commitRun(run);

  return runStep(runId, stepId);
}

export function getStepHistory(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const step = run.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Step not found: ${stepId}`);
  return step.history ?? [];
}

export function getWorkflowExecutionTree(runId: string) {
  const run = getExistingRun(runId);
  const shouldPersist = !run.executionTree;
  const tree = ensureExecutionTree(run);
  if (shouldPersist) {
    commitRun(run);
  }
  return tree;
}

function buildCodeReviewFeedbackForCodeGeneration(review: Record<string, unknown>) {
  const lines = [
    "来自代码审查的重试要求：请基于以下审查意见对当前工作区做增量修复，真实编辑/新建必要文件，并确保下一轮代码审查可以从 diff 中验证修复。不要重新生成已经完成且无需修改的任务。",
  ];

  if (typeof review.summary === "string" && review.summary.trim()) {
    lines.push(`审查摘要：${review.summary.trim()}`);
  }

  const findings = Array.isArray(review.findings) ? review.findings : [];
  if (findings.length > 0) {
    lines.push("审查问题：");
    for (const item of findings) {
      if (!item || typeof item !== "object") continue;
      const finding = item as Record<string, unknown>;
      const severity = typeof finding.severity === "string" ? finding.severity : "issue";
      const title = typeof finding.title === "string" ? finding.title : "未命名问题";
      const file = typeof finding.file === "string" ? ` (${finding.file})` : "";
      const detail = typeof finding.detail === "string" ? `：${finding.detail}` : "";
      const recommendation = typeof finding.recommendation === "string" ? ` 建议：${finding.recommendation}` : "";
      lines.push(`- [${severity}] ${title}${file}${detail}${recommendation}`);
    }
  }

  const failedChecklist = Array.isArray(review.checklist)
    ? review.checklist.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).status === "failed")
    : [];
  if (failedChecklist.length > 0) {
    lines.push("未通过检查：");
    for (const item of failedChecklist) {
      const check = item as Record<string, unknown>;
      const label = typeof check.label === "string" ? check.label : "未命名检查";
      const detail = typeof check.detail === "string" ? `：${check.detail}` : "";
      lines.push(`- ${label}${detail}`);
    }
  }

  lines.push("不要只输出“已修复”。必须让生成代码阶段的受控 writer 真实写入文件，且不要新增未接入真实入口的平行文件。");
  return lines.join("\n");
}

function buildCodeReviewInterventionsForCodeGeneration(run: WorkflowRun): InterventionMessage[] {
  const reviewStep = run.steps.find((s) => s.id === "code_review");
  if (!reviewStep?.output) {
    return [];
  }

  const feedback = buildCodeReviewFeedbackForCodeGeneration(reviewStep.output as Record<string, unknown>);
  const timestamp = Date.now();
  const createdAt = now();
  return [
    {
      id: `code_generation-cr-user-${timestamp}`,
      stepId: "code_generation",
      role: "user",
      content: feedback,
      createdAt,
    },
    {
      id: `code_generation-cr-system-${timestamp}`,
      stepId: "code_generation",
      role: "system",
      content: "entry=code_review_retry; code_generation_should_use_code_review_context=true",
      createdAt,
    },
    {
      id: `code_generation-cr-agent-${timestamp}`,
      stepId: "code_generation",
      role: "agent",
      content: "已接收代码审查意见，将回到生成代码阶段做增量修复并写入文件。",
      createdAt,
    },
  ];
}

export async function retryCodeGenerationFromCodeReview(runId: string): Promise<WorkflowRun> {
  const run = getExistingRun(runId);
  const reviewStep = run.steps.find((s) => s.id === "code_review");
  if (!reviewStep || !reviewStep.output) throw new Error("code_review has no output");
  const codegenStep = run.steps.find((s) => s.id === "code_generation");
  if (!codegenStep) throw new Error("code_generation step not found");

  return replayFromStep(runId, "code_generation", {
    interventions: buildCodeReviewInterventionsForCodeGeneration(run),
    revertCodeGenerationChanges: false,
  });
}

export async function restoreStepSnapshot(runId: string, stepId: WorkflowStepId, snapshotId: string, _replayDownstream?: boolean) {
  const run = getExistingRun(runId);
  const stepIndex = getStepIndex(run, stepId as typeof stepOrder[number]);
  const step = run.steps[stepIndex];
  if (!step) throw new Error(`Step not found: ${stepId}`);

  const snapshot = (step.history ?? []).find((s) => s.id === snapshotId);
  if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

  if (stepId === "code_generation") {
    await revertPreviousCodeGenerationChanges(step);
    await applyCodeGenerationSnapshotChanges(snapshot.output);
  }

  run.steps = run.steps.map((current, index) => {
    if (current.id === stepId) {
      return {
        ...current,
        output: snapshot.output,
        status: "waiting-human" as const,
        logs: [...current.logs, `已还原历史版本 (${snapshot.reason}, ${snapshot.createdAt})`],
      };
    }

    // 下游步骤无条件重置为 idle，但只有曾经执行过的步骤才追加失效日志
    if (index > stepIndex) {
      const hadExecution =
        current.output !== undefined ||
        current.status !== "idle" ||
        current.startedAt !== undefined ||
        current.finishedAt !== undefined ||
        current.logs.length > 0;

      return {
        ...current,
        status: "idle" as const,
        output: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        // 还原不增加 replayCount，不新增 history snapshot
        logs: hadExecution
          ? [...current.logs, "因上游步骤还原，此步骤结果已失效，需重新生成"]
          : current.logs,
      };
    }

    return current;
  });

  run.activeStepId = stepId;
  run.steps = propagateInputDownstream(run.steps, stepIndex, snapshot.output);
  return commitRun(run);
}

export async function restoreExecutionTreeNode(runId: string, nodeId: string) {
  const run = getExistingRun(runId);
  const node = getExecutionNode(run, nodeId);
  if (node.stepId === "code_generation") {
    const currentCodegenStep = run.steps.find((step) => step.id === "code_generation");
    if (currentCodegenStep) {
      await revertPreviousCodeGenerationChanges(currentCodegenStep);
    }
    await applyCodeGenerationSnapshotChanges(node.output);
  }

  restoreExecutionNodeInMemory(run, nodeId);
  return commitRun(run);
}

export function deleteExecutionTreeNode(runId: string, nodeId: string) {
  const run = getExistingRun(runId);
  deleteExecutionNodeInMemory(run, nodeId);
  return commitRun(run);
}

export function deleteWorkflowRun(runId: string) {
  runs.delete(runId);
  cacheTimestamps.delete(runId);
  deleteWorkflowRunFromStore(runId);
}

export async function favoriteWorkflowRunCase(runId: string) {
  const run = getExistingRun(runId);
  if (!isRunSuccessful(run)) {
    throw new Error("只有已完成的交付任务可以收藏为历史案例");
  }
  const projectId = run.projectId ?? getCurrentWorkspace()?.id;
  if (!projectId) {
    throw new Error("Workflow run is not attached to a project");
  }
  const workspace = getSavedWorkspace(projectId) ?? getCurrentWorkspace();
  if (!workspace) {
    throw new Error(`Workspace not found: ${projectId}`);
  }
  const item = await saveRequirementCaseFromRun({ ...run, projectId }, workspace);
  run.caseId = item.id;
  run.caseFavorited = true;
  return { run: commitRun(run), case: item };
}

export function evictWorkflowRunsForProject(projectId: string) {
  for (const [runId, run] of runs.entries()) {
    if (run.projectId === projectId) {
      runs.delete(runId);
      cacheTimestamps.delete(runId);
    }
  }
}

/**
 * 后台调度 autoContinue：保证同一 run 同时只有一个推进 promise 在跑。
 * 入参 `from`：可选地把 activeStep 临时跳到某个 step（用于 replay 后立即从该 step 重跑）。
 */
function scheduleAutoContinue(runId: string, from?: WorkflowStepId) {
  if (advancing.has(runId)) {
    return;
  }
  const version = advanceVersions.get(runId) ?? 0;
  advancing.add(runId);

  void (async () => {
    try {
      if (from) {
        // 从 replay 起点重新跑当前 step（runStep 内部会广播 running）。
        await runStep(runId, from, undefined, version);
      } else {
        await advanceWorkflow(runId, version);
      }
    } finally {
      if ((advanceVersions.get(runId) ?? 0) === version) {
        advancing.delete(runId);
      }
    }
  })();
}

/**
 * 顺序推进当前 activeStep，直到遇到 manual-confirmation 卡点 / waiting-human / failed。
 * 注意：因为 runStep 是异步触发后台 promise，所以这里也只在 automatic 续跑路径上调用。
 */
async function advanceWorkflow(runId: string, version = advanceVersions.get(runId) ?? 0) {
  let guard = 0;

  while (guard < ((getWorkflowRun(runId)?.steps.length ?? stepOrder.length) + 1)) {
    if ((advanceVersions.get(runId) ?? 0) !== version) return;
    guard += 1;
    const run = getWorkflowRun(runId);
    if (!run) return;

    const step = run.steps.find((item) => item.id === run.activeStepId);
    if (!step) return;

    if (step.status === "waiting-human" || step.status === "failed") {
      return;
    }

    if (step.status === "running") {
      // 已有 in-flight，等下一次 commitRun 触发再决定。
      return;
    }

    // 进入此 step 的执行（同步等待，确保串行推进）。
    if (getProjectStepExecutionMode(run.projectId, step.id) === "automatic" || !step.output) {
      await executeStepAndAdvance(runId, step.id, undefined, version);
      // executeStepAndAdvance 内部已经处理了 activeStepId / status，进入下一轮。
      continue;
    }

    return;
  }
}

async function resolveStepOutput(
  run: WorkflowRun,
  stepId: WorkflowStepId,
  options?: { followUp?: { previousOutput: unknown; reasons: string[] }; runOptions?: WorkflowStepRunOptions },
) {
  // PR3: 优先走注册表，未注册时 fallback 到旧硬编码
  const registryOutput = await resolveRegisteredStepOutput({ run, stepId, followUp: options?.followUp, runOptions: options?.runOptions });
  if (registryOutput !== null) return registryOutput;

  // ---- 旧路径 (fallback，保留至所有测试/环境迁移完成) ----
  if (stepId === "requirement_intake") {
    return getStepOutput<RequirementDraft>(run, "requirement_intake");
  }

  if (stepId === "clarification") {
    const requirement = getStepOutput<RequirementDraft>(run, "requirement_intake");
    const clarificationStep = run.steps.find((s) => s.id === "clarification");
    const runtimeMemory = buildRuntimeMemoryContext(run, "clarification");

    const userInterventions = (clarificationStep?.interventions ?? [])
      .filter((m) => m.role === "user")
      .map((m) => m.content);

    const previousOutput = (clarificationStep?.output ?? options?.followUp?.previousOutput) as
      | ClarificationOutput
      | undefined;

    if (options?.followUp || userInterventions.length > 0 || previousOutput) {
      return runClarifierAgent(requirement, {
        previousOutput: (options?.followUp?.previousOutput as ClarificationOutput) ?? previousOutput,
        reasons: options?.followUp?.reasons,
        userInterventions: userInterventions.length > 0 ? userInterventions : undefined,
        runtimeMemory,
      });
    }
    return runClarifierAgent(requirement, { runtimeMemory });
  }

  if (stepId === "solution_design") {
    const requirement = getStepOutput<RequirementDraft>(run, "requirement_intake");
    const clarification = getStepOutput<ClarificationOutput>(run, "clarification");
    const runtimeMemory = buildRuntimeMemoryContext(run, "solution_design");
    const skillSpec = getSkillStepSpec(run, "solution_design", getCurrentWorkspace() ?? undefined);
    return runPlannerAgent(requirement, clarification, { runtimeMemory, skillSpec });
  }

  return runWorkflowStepAgent(stepId, run, options?.runOptions);
}

function getStepOutput<T>(run: WorkflowRun, stepId: WorkflowStepId) {
  const output = run.steps.find((step) => step.id === stepId)?.output;

  if (!output) {
    throw new Error(`Step output not found: ${stepId}`);
  }

  return output as T;
}

function getExistingRun(runId: string) {
  const run = getWorkflowRun(runId);

  if (!run) {
    throw new Error(`Workflow run not found: ${runId}`);
  }

  return run;
}

/**
 * 将 step 的 output 向下传播到下一步的 input。
 * 仅在下一步处于 idle/failed 时覆盖，避免干扰正在执行的步骤。
 */
function propagateInputDownstream(steps: StepRun[], stepIndex: number, output: unknown): StepRun[] {
  const nextIndex = stepIndex + 1;
  if (nextIndex >= steps.length) return steps;

  const nextStep = steps[nextIndex];
  if (nextStep.status === "idle" || nextStep.status === "failed") {
    return steps.map((step, index) =>
      index === nextIndex ? { ...step, input: output } : step,
    );
  }

  return steps;
}
