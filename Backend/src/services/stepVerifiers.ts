/**
 * Step Verifiers
 *
 * 每个 Agent 输出后,在写入 StepRun 前调用对应 verifier:
 * - schema 校验由 zod 已经做了,这里只做"事实"层面校验;
 * - 输出统一的 StepCheck[] + QualityGateResult,供 workflowService 决定续跑/卡点/修复。
 *
 * 设计原则:
 *  1. 尽量 deterministic,不要再调 LLM。
 *  2. 失败时给出可以塞回 prompt 的具体证据(missingFiles / unsupportedClaims / failedCommands)。
 *  3. 决策只输出 auto-continue / need-human / repair / block 四态,具体动作由调用方决定。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ClarificationOutput,
  CodeGenerationPlan,
  CodeReviewResult,
  ModuleMapping,
  QualityGateResult,
  RepoWriteResult,
  SolutionDsl,
  StepCheck,
  VerificationResult,
  WorkflowStepId,
} from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import { runRegisteredStepVerifier } from "../workflowExecution/verifierRegistry.js";
import { analyzeRouteBindings, findShadowedRouteBinding } from "./routeBindingAnalysis.js";

export type VerifierResult = {
  checks: StepCheck[];
  qualityGate: QualityGateResult;
};

const CLARIFICATION_CONFIDENCE_FLOOR = 0.7;
const ACCEPTANCE_CRITERIA_MIN = 2;
const ENTRYPOINT_FILE_RE = /(^|\/)(main|index)\.(jsx?|tsx?)$/i;
const ENTRYPOINT_ALLOWED_TITLE_RE = /(入口|挂载|根节点|根组件|路由|Router|Provider|createRoot|hydrate|bootstrap|初始化\s*App|App\s*初始化)/i;
const MODULE_MAPPING_IMPLEMENTATION_RE = /(实现|补充测试|补测试|测试用例|单元测试|生成|写入|落盘|diff|patch|重构|调用\s*Agent|创建.*组件|新增.*(展示|逻辑|功能|测试|组件)|添加.*(展示|逻辑|功能|测试|组件)|修改.*(逻辑|实现|组件|样式|测试)|展示.*字段)/i;
const REVIEW_EVIDENCE_GAP_RE = /(无法确认|无法验证|未出现在(?:本次)?\s*diff|diff\s*缺失|证据不足|缺少证据|未提供.*diff|没有.*diff|无法从.*确认|无法审查|覆盖缺口|缺口风险|未覆盖|缺少.*测试|测试文件.*未出现)/i;

function summarizeReasons(checks: StepCheck[]): string[] {
  return checks
    .filter((check) => check.status === "failed" || check.status === "warning")
    .map((check) => `[${check.type}] ${check.message}`);
}

function decide(
  checks: StepCheck[],
  options?: { repairableOnFail?: boolean },
): QualityGateResult {
  const failed = checks.filter((c) => c.status === "failed");
  const warnings = checks.filter((c) => c.status === "warning");

  if (failed.length === 0 && warnings.length === 0) {
    return {
      decision: "auto-continue",
      reasons: ["all checks passed"],
      confidence: 1,
      repairAttempts: 0,
    };
  }

  if (failed.length === 0) {
    return {
      decision: "auto-continue",
      reasons: summarizeReasons(checks),
      confidence: 0.85,
      repairAttempts: 0,
    };
  }

  // 有 failed 项: 给一次 repair 机会,否则需要人工
  return {
    decision: options?.repairableOnFail ? "repair" : "need-human",
    reasons: summarizeReasons(checks),
    confidence: Math.max(0, 1 - failed.length * 0.25 - warnings.length * 0.1),
    repairAttempts: 0,
  };
}

function isFrontendEntrypointFile(file: string): boolean {
  return ENTRYPOINT_FILE_RE.test(file.replaceAll("\\", "/"));
}

function allowsEntrypointEdit(title: string): boolean {
  return ENTRYPOINT_ALLOWED_TITLE_RE.test(title);
}

function detectShadowedRouteComponent(
  file: string,
  fileSet: Set<string>,
  workspaceDir?: string,
): string | null {
  const normalized = file.replaceAll("\\", "/");
  const match = normalized.match(/^(.*\/routes\/)([^/]+)\.(jsx?|tsx?)$/i);
  if (!match) return null;

  const [, routeRoot, routeName, extension] = match;
  const canonical = `${routeRoot}${routeName}/${routeName}.${extension}`;
  if (fileSet.has(canonical)) return canonical;

  if (workspaceDir && existsSync(path.resolve(workspaceDir, canonical))) {
    return canonical;
  }

  return null;
}

function countClaimedStrategySteps(strategy: string) {
  const explicitChineseStepCount = strategy.match(/分\s*([一二三四五六七八九十\d]+)\s*步/);
  if (explicitChineseStepCount) {
    const value = explicitChineseStepCount[1];
    const chineseMap: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    if (chineseMap[value]) return chineseMap[value];
  }

  const numbered = strategy.match(/(?:^|[\s；;。])\d+[).)、]/g);
  return numbered?.length ?? 0;
}

/**
 * Clarification 校验:
 *  - confidence 必须 >= 阈值
 *  - 不能存在高风险且未回答的问题
 */
export function verifyClarification(output: ClarificationOutput): VerifierResult {
  const checks: StepCheck[] = [];
  const openQuestions = output.questions.filter((q) => q.status !== "resolved");

  // 1. clarificationComplete 信号检查
  if (output.clarificationComplete) {
    checks.push({
      id: "clarification.complete",
      type: "factual",
      status: "passed",
      message: "Agent 判定澄清已完成",
    });
  }

  // 2. confidence 检查
  if (output.confidence < CLARIFICATION_CONFIDENCE_FLOOR) {
    checks.push({
      id: "clarification.confidence",
      type: "factual",
      status: "failed",
      message: `confidence (${output.confidence.toFixed(2)}) 低于阈值 ${CLARIFICATION_CONFIDENCE_FLOOR}`,
      evidence: { confidence: output.confidence },
    });
  } else {
    checks.push({
      id: "clarification.confidence",
      type: "factual",
      status: "passed",
      message: `confidence ${output.confidence.toFixed(2)} 满足阈值`,
    });
  }

  // 3. 开放问题检查
  const unanswered = openQuestions.filter(
    (q) => !q.answer || q.answer.trim().length === 0,
  );
  const highRiskUnanswered = unanswered.filter((q) => q.riskIfUnanswered.trim().length > 0);

  if (highRiskUnanswered.length > 0) {
    checks.push({
      id: "clarification.unanswered_high_risk",
      type: "factual",
      status: "failed",
      message: `存在 ${highRiskUnanswered.length} 个高风险未回答问题`,
      evidence: { ids: highRiskUnanswered.map((q) => q.id) },
    });
  }

  // 4. decisions 的存在表示有实质性产出
  if (output.decisions.length > 0) {
    checks.push({
      id: "clarification.decisions",
      type: "factual",
      status: "passed",
      message: `已产出 ${output.decisions.length} 个确认决策`,
    });
  }

  if (openQuestions.length === 0 && output.questions.length === 0) {
    checks.push({
      id: "clarification.no_questions",
      type: "factual",
      status: output.clarificationComplete ? "passed" : "warning",
      message: output.clarificationComplete
        ? "澄清已完成, 所有问题已解决"
        : "Clarifier 没有产生开放问题",
    });
  }

  // 5. Gate 决策: complete + confidence OK + 无高风险 → auto-continue
  const hasFailed = checks.some((c) => c.status === "failed");
  const isCompleteAndClean =
    output.clarificationComplete &&
    openQuestions.length === 0 &&
    output.confidence >= CLARIFICATION_CONFIDENCE_FLOOR &&
    !hasFailed;

  if (isCompleteAndClean) {
    return {
      checks,
      qualityGate: {
        decision: "auto-continue",
        reasons: ["澄清已完成, 所有问题已解决, 可进入方案设计"],
        confidence: output.confidence,
        repairAttempts: 0,
      },
    };
  }

  // 有真正未回答的开放问题 → need-human
  if (unanswered.length > 0 && highRiskUnanswered.length > 0) {
    checks.push({
      id: "clarification.open_questions",
      type: "factual",
      status: "warning",
      message: `仍有 ${highRiskUnanswered.length} 个高风险未回答问题需用户审核`,
    });
    return {
      checks,
      qualityGate: {
        decision: "need-human",
        reasons: [`${highRiskUnanswered.length} 个高风险问题待审核`],
        confidence: output.confidence,
        repairAttempts: 0,
      },
    };
  }

  // 其他情况: 沿用通用 decide 逻辑
  return { checks, qualityGate: decide(checks, { repairableOnFail: true }) };
}

/**
 * SolutionDsl 校验:
 *  - acceptanceCriteria 必须可测试(数量、长度)
 *  - dataContract 至少有实际内容
 *  - userStory 不能为空 placeholder
 */
export function verifySolutionDsl(output: SolutionDsl): VerifierResult {
  const checks: StepCheck[] = [];

  if (output.acceptanceCriteria.length < ACCEPTANCE_CRITERIA_MIN) {
    checks.push({
      id: "solution.acceptance_criteria_count",
      type: "factual",
      status: "failed",
      message: `acceptanceCriteria 仅 ${output.acceptanceCriteria.length} 条,至少需要 ${ACCEPTANCE_CRITERIA_MIN} 条可验证项`,
    });
  } else {
    checks.push({
      id: "solution.acceptance_criteria_count",
      type: "factual",
      status: "passed",
      message: `acceptanceCriteria ${output.acceptanceCriteria.length} 条`,
    });
  }

  const tooShort = output.acceptanceCriteria.filter((c) => c.length < 8);
  if (tooShort.length > 0) {
    checks.push({
      id: "solution.acceptance_criteria_length",
      type: "factual",
      status: "warning",
      message: `${tooShort.length} 条 acceptanceCriteria 文本过短,可能不足以验证`,
      evidence: { items: tooShort },
    });
  }

  const dataContractValues = Object.values(output.dataContract ?? {});
  const hasDataContractContent = dataContractValues.some((value) => (
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value).trim().length > 0
  ));
  if (!hasDataContractContent) {
    checks.push({
      id: "solution.data_contract_empty",
      type: "factual",
      status: "warning",
      message: "dataContract 没有实际内容,需要至少描述输入/输出/约束/验证提示之一",
    });
  }

  return { checks, qualityGate: decide(checks, { repairableOnFail: false }) };
}

/**
 * Module Mapping 校验:
 *  - 每个 file 路径要么在 repositoryScan.fileTree 中,要么显式被认为是新文件;
 *
 * 这里允许"新文件"出现,但需要 module reason 中提到 "新增"/"create"/"new" 等关键词,
 * 或者文件路径不存在于现有 fileTree(由调用方上层用人工 gate 把关)。
 */
export function verifyModuleMapping(
  output: ModuleMapping,
  workspace: WorkspaceContext,
): VerifierResult {
  const checks: StepCheck[] = [];
  const fileSet = new Set(workspace.repositoryScan.fileTree);
  const workspaceDir = workspace.workspaceDir;
  const missingFiles: string[] = [];
  const newFileClaims: string[] = [];
  const boundaryOverreach: Array<{ module: string; reason: string }> = [];

  for (const mod of output.touchedModules) {
    if (MODULE_MAPPING_IMPLEMENTATION_RE.test(mod.reason)) {
      boundaryOverreach.push({ module: mod.name, reason: mod.reason });
    }

    for (const file of mod.files) {
      const knownInScan = fileSet.has(file);
      const onDisk = workspaceDir
        ? existsSync(path.resolve(workspaceDir, file))
        : false;
      const claimsNew = /(新增|新建|create|new)/i.test(`${mod.reason} ${file}`);

      if (!knownInScan && !onDisk) {
        if (claimsNew) {
          newFileClaims.push(file);
        } else {
          missingFiles.push(`${mod.name} → ${file}`);
        }
      }
    }
  }

  if (missingFiles.length > 0) {
    checks.push({
      id: "module_mapping.missing_files",
      type: "factual",
      status: "failed",
      message: `定位的 ${missingFiles.length} 个文件路径在仓库中不存在且未声明为新文件`,
      evidence: { missingFiles },
    });
  } else {
    checks.push({
      id: "module_mapping.files_exist",
      type: "factual",
      status: "passed",
      message: `${output.touchedModules.length} 个模块的文件路径校验通过`,
    });
  }

  if (newFileClaims.length > 0) {
    checks.push({
      id: "module_mapping.new_files_declared",
      type: "factual",
      status: "warning",
      message: `${newFileClaims.length} 个文件声明为新增,需人工确认是否合理`,
      evidence: { newFileClaims },
    });
  }

  if (boundaryOverreach.length > 0) {
    checks.push({
      id: "module_mapping.boundary_overreach",
      type: "consistency",
      status: "warning",
      message: `定位代码阶段包含 ${boundaryOverreach.length} 条疑似实现/测试计划表述,应只保留定位依据`,
      evidence: { boundaryOverreach },
    });
  }

  return { checks, qualityGate: decide(checks, { repairableOnFail: true }) };
}

/** Code Review 校验：审查结果不做自动修复，所有未通过项都交由用户选择 Retry 或 Continue。 */
export function verifyCodeReviewResult(output: CodeReviewResult): VerifierResult {
  const checks: StepCheck[] = [];

  if (!output.reviewedFiles || output.reviewedFiles.length === 0) {
    checks.push({ id: "code_review.no_files", type: "factual", status: "failed", message: "未审查任何文件" });
  } else {
    checks.push({ id: "code_review.files", type: "factual", status: "passed", message: `已审查 ${output.reviewedFiles.length} 个文件` });
  }

  if (output.decision === "request-changes" && (!output.findings || output.findings.length === 0)) {
    checks.push({ id: "code_review.no_findings", type: "factual", status: "failed", message: "decision=request-changes 但 findings 为空" });
  }

  const blockers = (output.findings ?? []).filter((f) => f.severity === "blocker");
  const majors = (output.findings ?? []).filter((f) => f.severity === "major");
  const failedChecklist = (output.checklist ?? []).filter((item) => item.status === "failed");
  const evidenceGapText = [
    output.summary,
    ...(output.findings ?? []).flatMap((finding) => [finding.title, finding.detail, finding.recommendation ?? ""]),
    ...(output.checklist ?? []).flatMap((item) => [item.label, item.detail ?? ""]),
    ...(output.riskAreas ?? []),
  ].join("\n");

  if (output.decision === "approve" && failedChecklist.length > 0) {
    checks.push({
      id: "code_review.approve_with_failed_checklist",
      type: "consistency",
      status: "failed",
      message: `decision=approve 但 checklist 中仍有 ${failedChecklist.length} 个 failed 项`,
      evidence: { failedChecklist: failedChecklist.map((item) => item.id) },
    });
  }

  if (output.decision === "approve" && REVIEW_EVIDENCE_GAP_RE.test(evidenceGapText)) {
    checks.push({
      id: "code_review.approve_with_evidence_gap",
      type: "consistency",
      status: "failed",
      message: "审查结果承认存在无法确认/证据不足/diff 缺失,不能判定通过",
    });
  }

  if (blockers.length > 0) {
    checks.push({ id: "code_review.blockers", type: "factual", status: "failed", message: `${blockers.length} 个 blocker 级别问题` });
  }
  if (majors.length > 0) {
    checks.push({ id: "code_review.majors", type: "factual", status: "warning", message: `${majors.length} 个 major 级别问题` });
  }

  const hasBlocking = blockers.length > 0 || majors.length > 0;
  if (hasBlocking) {
    return { checks, qualityGate: { decision: "need-human", reasons: [`存在 ${blockers.length + majors.length} 个 blocker/major 问题`], confidence: 0.5, repairAttempts: 0 } };
  }

  return { checks, qualityGate: decide(checks, { repairableOnFail: false }) };
}

export function verifyCodeGenerationPlan(
  output: CodeGenerationPlan,
  workspace: WorkspaceContext,
): VerifierResult {
  const checks: StepCheck[] = [];
  const fileSet = new Set(workspace.repositoryScan.fileTree);
  const workspaceDir = workspace.workspaceDir;
  const routeBindings = analyzeRouteBindings(workspace);
  const tasksWithoutFiles: string[] = [];
  const tasksWithSuspiciousPaths: string[] = [];
  const tasksWithoutTestFiles: string[] = [];
  const tasksWithUnjustifiedEntrypoints: string[] = [];
  const tasksWithoutCriteriaRefs: string[] = [];
  const tasksWithoutExpectedChange: string[] = [];
  const tasksWithoutTestIntent: string[] = [];
  const directoryLikePaths: string[] = [];
  const shadowRouteFiles: string[] = [];
  const claimedStrategySteps = countClaimedStrategySteps(output.strategy);

  if (claimedStrategySteps > output.tasks.length) {
    checks.push({
      id: "code_generation.strategy_overclaims_tasks",
      type: "consistency",
      status: "failed",
      message: `strategy 声称约 ${claimedStrategySteps} 个步骤,但 tasks 只有 ${output.tasks.length} 个；禁止声明未拆成任务的工作`,
      evidence: { strategy: output.strategy, taskCount: output.tasks.length },
    });
  }

  for (const task of output.tasks) {
    if (task.files.length === 0) {
      tasksWithoutFiles.push(task.id);
      continue;
    }

    const testFiles = (task as { testFiles?: string[] }).testFiles ?? [];
    const acceptanceCriteriaRefs = (task as { acceptanceCriteriaRefs?: string[] }).acceptanceCriteriaRefs ?? [];
    const expectedChange = (task as { expectedChange?: string }).expectedChange?.trim() ?? "";
    const testIntent = (task as { testIntent?: string }).testIntent?.trim() ?? "";
    if (acceptanceCriteriaRefs.length === 0) tasksWithoutCriteriaRefs.push(task.id);
    if (!expectedChange) tasksWithoutExpectedChange.push(task.id);
    if (!testIntent) tasksWithoutTestIntent.push(task.id);
    if (task.testRequired && testFiles.length === 0) {
      tasksWithoutTestFiles.push(task.id);
    }

    const entrypointFiles = task.files.filter(isFrontendEntrypointFile);
    if (entrypointFiles.length > 0 && !allowsEntrypointEdit(task.title)) {
      tasksWithUnjustifiedEntrypoints.push(`${task.id}:${entrypointFiles.join(",")}`);
    }

    for (const file of [...task.files, ...testFiles]) {
      if (file.endsWith("/") || file.endsWith("\\") || !path.basename(file).includes(".")) {
        directoryLikePaths.push(`${task.id}:${file}`);
      }
      const known = fileSet.has(file);
      const onDisk = workspaceDir
        ? existsSync(path.resolve(workspaceDir, file))
        : false;
      const shadowedByExistingRoute = detectShadowedRouteComponent(file, fileSet, workspaceDir)
        ?? findShadowedRouteBinding(file, routeBindings)?.boundFile;
      if (shadowedByExistingRoute && file.replaceAll("\\", "/") !== shadowedByExistingRoute) {
        shadowRouteFiles.push(`${task.id}:${file} -> ${shadowedByExistingRoute}`);
      }
      // 允许新文件,但路径必须像项目内文件
      if (!known && !onDisk && (file.includes("..") || path.isAbsolute(file))) {
        tasksWithSuspiciousPaths.push(`${task.id}:${file}`);
      }
    }
  }

  if (tasksWithoutFiles.length > 0) {
    checks.push({
      id: "code_generation.empty_files",
      type: "factual",
      status: "failed",
      message: `${tasksWithoutFiles.length} 个任务没有指定文件`,
      evidence: { tasks: tasksWithoutFiles },
    });
  }

  if (tasksWithSuspiciousPaths.length > 0) {
    checks.push({
      id: "code_generation.suspicious_paths",
      type: "security",
      status: "failed",
      message: `${tasksWithSuspiciousPaths.length} 个任务包含可疑路径(绝对路径或路径穿越)`,
      evidence: { tasks: tasksWithSuspiciousPaths },
    });
  }

  if (directoryLikePaths.length > 0) {
    checks.push({
      id: "code_generation.directory_like_paths",
      type: "factual",
      status: "failed",
      message: `${directoryLikePaths.length} 个路径看起来像目录而不是具体文件`,
      evidence: { tasks: directoryLikePaths },
    });
  }

  if (shadowRouteFiles.length > 0) {
    checks.push({
      id: "code_generation.shadow_route_component",
      type: "factual",
      status: "failed",
      message: `${shadowRouteFiles.length} 个任务试图新增平行页面文件,但项目已存在同名路由目录组件;应修改真实路由绑定组件`,
      evidence: { tasks: shadowRouteFiles },
    });
  }

  if (tasksWithUnjustifiedEntrypoints.length > 0) {
    checks.push({
      id: "code_generation.unjustified_entrypoint_files",
      type: "factual",
      status: "failed",
      message: `${tasksWithUnjustifiedEntrypoints.length} 个任务包含入口文件,但标题未说明需要修改入口挂载/Provider/Router`,
      evidence: { tasks: tasksWithUnjustifiedEntrypoints },
    });
  }

  if (tasksWithoutTestFiles.length > 0) {
    checks.push({
      id: "code_generation.missing_test_files",
      type: "factual",
      status: "warning",
      message: `${tasksWithoutTestFiles.length} 个任务声明需补测试,但没有指定测试文件（code writer 会自动推导）`,
      evidence: { tasks: tasksWithoutTestFiles },
    });
  }

  if (tasksWithoutCriteriaRefs.length > 0) {
    checks.push({
      id: "code_generation.missing_acceptance_refs",
      type: "factual",
      status: "warning",
      message: `${tasksWithoutCriteriaRefs.length} 个任务没有映射验收标准`,
      evidence: { tasks: tasksWithoutCriteriaRefs },
    });
  }

  if (tasksWithoutExpectedChange.length > 0) {
    checks.push({
      id: "code_generation.missing_expected_change",
      type: "factual",
      status: "warning",
      message: `${tasksWithoutExpectedChange.length} 个任务缺少 expectedChange`,
      evidence: { tasks: tasksWithoutExpectedChange },
    });
  }

  if (tasksWithoutTestIntent.length > 0) {
    checks.push({
      id: "code_generation.missing_test_intent",
      type: "factual",
      status: "warning",
      message: `${tasksWithoutTestIntent.length} 个任务缺少 testIntent`,
      evidence: { tasks: tasksWithoutTestIntent },
    });
  }

  if (output.tasks.length > 0 && !output.tasks.some((t) => t.testRequired)) {
    checks.push({
      id: "code_generation.no_tests",
      type: "factual",
      status: "warning",
      message: "所有任务都标 testRequired=false,可能跳过了测试",
    });
  }

  if (checks.length === 0) {
    checks.push({
      id: "code_generation.plan_ok",
      type: "factual",
      status: "passed",
      message: `${output.tasks.length} 个任务的文件路径校验通过`,
    });
  }

  return { checks, qualityGate: decide(checks, { repairableOnFail: true }) };
}

/**
 * Repo Write 校验:
 *  - mode=planned 时:不允许自动进入 verification(避免拿假 diff 跑测试),需要 human gate;
 *  - mode=applied 时:appliedChanges 必须非空,且每个 path 真实存在于 workspace。
 */
export function verifyRepoWrite(
  output: RepoWriteResult,
  workspace: WorkspaceContext,
): VerifierResult {
  const checks: StepCheck[] = [];
  const workspaceDir = workspace.workspaceDir;

  if (output.mode === "planned") {
    checks.push({
      id: "repo_write.planned_only",
      type: "factual",
      status: "warning",
      message: "当前仅生成计划,未真实落盘;后续 verification 不会反映本计划",
    });
    // planned 模式直接 need-human,等待人工确认是否手动落地
    return {
      checks,
      qualityGate: {
        decision: "need-human",
        reasons: ["repo_write 处于 planned 模式,需要人工确认是否手动落盘后续跑"],
        confidence: 0.6,
        repairAttempts: 0,
      },
    };
  }

  // applied 模式
  if (output.appliedChanges.length === 0) {
    checks.push({
      id: "repo_write.applied_empty",
      type: "factual",
      status: "failed",
      message: "声称 mode=applied 但 appliedChanges 为空",
    });
  }

  if (workspaceDir) {
    const missing: string[] = [];
    for (const change of output.appliedChanges) {
      const expectExists = change.changeType !== "deleted";
      const actualExists = existsSync(path.resolve(workspaceDir, change.path));
      if (expectExists && !actualExists) {
        missing.push(change.path);
      }
    }
    if (missing.length > 0) {
      checks.push({
        id: "repo_write.applied_files_missing",
        type: "factual",
        status: "failed",
        message: `${missing.length} 个声称已写入的文件在 workspace 不存在`,
        evidence: { missing },
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      id: "repo_write.applied_ok",
      type: "factual",
      status: "passed",
      message: `applied ${output.appliedChanges.length} 个变更,workspace 已落盘`,
    });
  }

  return { checks, qualityGate: decide(checks, { repairableOnFail: false }) };
}

/**
 * Verification 校验:
 *  - 必须有真实的 commands[](即 runtime 真实执行了至少一个命令);
 *  - 任意命令 status=failed 则 need-human;
 *  - 全 not_executed → need-human(LLM 自我声明不可信);
 *  - 全 not_configured → warning(项目本身没配置)。
 */
export function verifyVerification(output: VerificationResult): VerifierResult {
  const checks: StepCheck[] = [];

  const realCommands = output.commands.filter((c) => c.status !== "not_configured" && c.status !== "skipped");

  // 没有真实执行的命令 → 默认放行
  if (realCommands.length === 0) {
    checks.push({
      id: "verification.no_real_commands",
      type: "factual",
      status: "passed",
      message: "未检测到可执行质量门禁,默认放行",
    });
    return {
      checks,
      qualityGate: { decision: "auto-continue", reasons: ["质量门禁默认放行"], confidence: 1, repairAttempts: 0 },
    };
  }

  // 有真实命令 → 检查是否有失败

  const failedCommands = output.commands.filter((c) => c.status === "failed");
  const notExecuted = output.commands.filter((c) => c.status === "not_executed");
  const passed = output.commands.filter((c) => c.status === "passed");

  for (const cmd of failedCommands) {
    checks.push({
      id: `verification.cmd_failed.${cmd.label}`,
      type: "command",
      status: "failed",
      message: cmd.failureSummary ?? `${cmd.label} 命令失败 (exit=${cmd.exitCode}): ${cmd.command}`,
      evidence: {
        stderrPreview: cmd.stderrPreview,
        durationMs: cmd.durationMs,
        failureKind: cmd.failureKind,
        suggestedAction: cmd.suggestedAction,
      },
    });
  }

  for (const cmd of notExecuted) {
    checks.push({
      id: `verification.cmd_not_executed.${cmd.label}`,
      type: "command",
      status: "warning",
      message: `${cmd.label} 命令未执行(${cmd.command})`,
    });
  }

  if (passed.length > 0 && failedCommands.length === 0) {
    checks.push({
      id: "verification.passed",
      type: "command",
      status: "passed",
      message: `${passed.length} 个验证命令真实通过`,
    });
  }

  return {
    checks,
    qualityGate: decide(checks, { repairableOnFail: true }),
  };
}

/**
 * 简单 step 的兜底 verifier:仅做"输出非空"判断,默认 auto-continue。
 * 用于 requirement_intake / pull_request 等不需要事实校验的 step。
 */
export function verifyTrivialOutput(label: string, output: unknown): VerifierResult {
  const checks: StepCheck[] = [];
  if (output === null || output === undefined) {
    checks.push({
      id: `${label}.empty_output`,
      type: "schema",
      status: "failed",
      message: `${label} 输出为空`,
    });
  } else {
    checks.push({
      id: `${label}.has_output`,
      type: "schema",
      status: "passed",
      message: `${label} 输出非空`,
    });
  }
  return { checks, qualityGate: decide(checks, { repairableOnFail: false }) };
}

/**
 * 统一调度入口:根据 stepId 选择对应 verifier,
 * 把 schema 后的事实校验集中到一处。
 *
 * workspace 在某些环境下(测试)可能不可用,此时退化为 trivial 校验。
 */
export function runStepVerifier(
  stepId: WorkflowStepId,
  output: unknown,
  workspace?: WorkspaceContext,
): VerifierResult {
  if (output === undefined || output === null) {
    return verifyTrivialOutput(stepId, output);
  }

  // PR3: 优先走注册表，未注册时 fallback 到硬编码 switch
  const registryResult = runRegisteredStepVerifier(stepId, output, workspace);
  if (!registryResult.checks.some((c) => c.id === "registry.missing_verifier")) {
    return registryResult;
  }

  switch (stepId) {
    case "requirement_intake":
      return verifyTrivialOutput(stepId, output);
    case "clarification":
      return verifyClarification(output as ClarificationOutput);
    case "solution_design":
      return verifySolutionDsl(output as SolutionDsl);
    case "module_mapping":
      if (!workspace) return verifyTrivialOutput(stepId, output);
      return verifyModuleMapping(output as ModuleMapping, workspace);
    case "code_generation":
      if (!workspace) return verifyTrivialOutput(stepId, output);
      return verifyCodeGenerationPlan(output as CodeGenerationPlan, workspace);
    case "code_review":
      return verifyCodeReviewResult(output as CodeReviewResult);
    case "repo_write":
      if (!workspace) return verifyTrivialOutput(stepId, output);
      return verifyRepoWrite(output as RepoWriteResult, workspace);
    case "verification":
      return verifyVerification(output as VerificationResult);
    case "pull_request":
      return verifyTrivialOutput(stepId, output);
    default:
      return verifyTrivialOutput(stepId, output);
  }
}
