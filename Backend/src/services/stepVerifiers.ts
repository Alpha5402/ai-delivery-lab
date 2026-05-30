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
  ModuleMapping,
  QualityGateResult,
  RepoWriteResult,
  SolutionDsl,
  StepCheck,
  VerificationResult,
  WorkflowStepId,
} from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";

export type VerifierResult = {
  checks: StepCheck[];
  qualityGate: QualityGateResult;
};

const CLARIFICATION_CONFIDENCE_FLOOR = 0.7;
const ACCEPTANCE_CRITERIA_MIN = 2;

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
 *  - dataContract 至少有一项
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

  if (Object.keys(output.dataContract ?? {}).length === 0) {
    checks.push({
      id: "solution.data_contract_empty",
      type: "factual",
      status: "warning",
      message: "dataContract 为空,跨栈需求需要至少描述输入/输出结构",
    });
  }

  return { checks, qualityGate: decide(checks, { repairableOnFail: false }) };
}

/**
 * Module Mapping 校验:
 *  - 每个 file 路径要么在 repositoryScan.fileTree 中,要么显式被认为是新文件;
 *  - reusableSkill 不能为空。
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

  for (const mod of output.touchedModules) {
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

  if (!output.reusableSkill || output.reusableSkill.trim().length === 0) {
    checks.push({
      id: "module_mapping.reusable_skill",
      type: "factual",
      status: "warning",
      message: "未指定 reusableSkill,后续 codegen 无法复用既有 Skill",
    });
  }

  return { checks, qualityGate: decide(checks, { repairableOnFail: true }) };
}

/**
 * Code Generation Plan 校验:
 *  - 每个 task 必须至少包含 1 个文件路径;
 *  - testRequired 至少在 tasks 中出现一次 true(否则警告)。
 */
export function verifyCodeGenerationPlan(
  output: CodeGenerationPlan,
  workspace: WorkspaceContext,
): VerifierResult {
  const checks: StepCheck[] = [];
  const fileSet = new Set(workspace.repositoryScan.fileTree);
  const workspaceDir = workspace.workspaceDir;
  const tasksWithoutFiles: string[] = [];
  const tasksWithSuspiciousPaths: string[] = [];

  for (const task of output.tasks) {
    if (task.files.length === 0) {
      tasksWithoutFiles.push(task.id);
      continue;
    }

    for (const file of task.files) {
      const known = fileSet.has(file);
      const onDisk = workspaceDir
        ? existsSync(path.resolve(workspaceDir, file))
        : false;
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

  if (output.commands.length === 0) {
    checks.push({
      id: "verification.no_real_commands",
      type: "command",
      status: "failed",
      message: "runtime 没有真实执行任何验证命令,结果不可信",
    });
    return {
      checks,
      qualityGate: {
        decision: "need-human",
        reasons: ["verification 缺少真实命令执行 trace"],
        confidence: 0.2,
        repairAttempts: 0,
      },
    };
  }

  const failedCommands = output.commands.filter((c) => c.status === "failed");
  const notExecuted = output.commands.filter((c) => c.status === "not_executed");
  const passed = output.commands.filter((c) => c.status === "passed");

  for (const cmd of failedCommands) {
    checks.push({
      id: `verification.cmd_failed.${cmd.label}`,
      type: "command",
      status: "failed",
      message: `${cmd.label} 命令失败 (exit=${cmd.exitCode}): ${cmd.command}`,
      evidence: { stderrPreview: cmd.stderrPreview, durationMs: cmd.durationMs },
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
function verifyTrivialOutput(label: string, output: unknown): VerifierResult {
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
