import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Alert, Button, Card, Collapse, Input, Modal, Progress, Space, Statistic, Tabs, Tag, Timeline, Tooltip, Typography, message } from "antd";
const { Text } = Typography;
import {
  confirmWorkflowStep,
  createStepIntervention,
  getAgentMetrics,
  getProjectWorkspace,
  getRepositorySnapshot,
  getWorkflowRun,
  openWorkspace,
  replayWorkflowFrom,
  restoreStepSnapshot,
  runWorkflowStep,
  subscribeWorkflowRun,
} from "../../api/client";
import type { WorkflowStepRunOptions } from "../../api/client";
import { AppBreadcrumb } from "../../components/AppBreadcrumb/AppBreadcrumb";
import { PageSkeleton } from "../../components/PageSkeleton/PageSkeleton";
import { SurfaceCard } from "../../components/SurfaceCard/SurfaceCard";
import { RepositoryChanges } from "../../components/RepositoryChanges/RepositoryChanges";
import { TestResultPanel } from "../../components/TestResultPanel/TestResultPanel";
import stageContinueIcon from "../../assets/icons/stage-continue.svg";
import stageReplayIcon from "../../assets/icons/stage-replay.svg";
import { summarizeMetrics } from "../../features/observability/metricsSummary";
import type { AgentMetric } from "../../features/observability/types";
import type { RepositorySnapshot } from "../../features/repository/types";
import type {
  ClarificationOutput,
  CodeGenerationPlan,
  InterventionMessage,
  ModuleMapping,
  PullRequestResult,
  RepoWriteResult,
  RequirementDraft,
  SolutionDsl,
  StepRun,
  VerificationResult,
  WorkflowRun,
  WorkflowStepId,
} from "../../features/workflow/types";
import { getActiveStep } from "../../features/workflow/workflowSelectors";
import { saveWorkspace } from "../../features/workspace/workspaceStorage";
import { formatCurrency, formatDuration, formatTokenCount } from "../../lib/formatters";
import { parseDecisionMemoryItems, type DecisionMemoryItem } from "../../lib/decisionMemory";
import "./WorkbenchPage.css";

type WorkspaceView = "summary" | "history";

function getStepOutput<T>(steps: Array<{ id: WorkflowStepId; output?: unknown }>, stepId: WorkflowStepId) {
  return steps.find((step) => step.id === stepId)?.output as T | undefined;
}

function SummaryCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="step-summary__card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function EmptyStepSummary({ step }: { step: StepRun }) {
  if (step.status === "running") {
    return (
      <div className="step-summary step-summary--empty step-summary--running">
        <p>结果生成后会显示在这里。</p>
      </div>
    );
  }

  const statusMessage = (() => {
    switch (step.status) {
      case "failed":
        return `${formatStepLabel(step.label)} 执行失败，查看日志后可从阶段条重试。`;
      case "waiting-human":
        return `${formatStepLabel(step.label)} 正在等待确认，请审阅 AI 输出。`;
      default:
        return `${formatStepLabel(step.label)} 还没有产出结构化结果。确认并继续后，AI 会把结构化结果传递给下游阶段。`;
    }
  })();

  return (
    <div className="step-summary step-summary--empty">
      <SummaryCard title={step.status === "failed" ? "执行失败" : "等待执行"}>
        <p>{statusMessage}</p>
      </SummaryCard>
      <SummaryCard title="当前状态">
        <div className="workbench__meta">
          <span>{formatRuntimeStatusValue(step.status)}</span>
          <span>{formatAgentName(step.agent)}</span>
        </div>
      </SummaryCard>
    </div>
  );
}

type PullRequestDraft = {
  branch: string;
  commitMessage: string;
};

function deriveDefaultPullRequestBranch(run: WorkflowRun) {
  const slug = (run.title || "feature")
    .replace(/[^A-Za-z0-9\s_-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  return `feature/${slug}`;
}

function deriveDefaultCommitMessage(run: WorkflowRun) {
  return (run.title || "workflow auto PR").replace(/["`$\\]/g, "").slice(0, 80);
}

function getPullRequestDraftFromRun(run: WorkflowRun): PullRequestDraft {
  const output = getStepOutput<PullRequestResult>(run.steps, "pull_request");
  return {
    branch: output?.branch ?? deriveDefaultPullRequestBranch(run),
    commitMessage: output?.commitMessage ?? deriveDefaultCommitMessage(run),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getCodeGenerationTaskTestFiles(task: CodeGenerationPlan["tasks"][number]) {
  return (task as { testFiles?: string[] }).testFiles ?? [];
}

function renderStepSummary(step: StepRun) {
  const value = step.output ?? step.input;

  if (!isRecord(value)) {
    return <EmptyStepSummary step={step} />;
  }

  switch (step.id) {
    case "requirement_intake": {
      const requirement = value as RequirementDraft;
      if (!requirement.rawText) {
        return <EmptyStepSummary step={step} />;
      }
      return (
        <div className="step-summary">
          <SummaryCard title="需求原文">
            <p>{requirement.rawText}</p>
          </SummaryCard>
          <SummaryCard title="交付范围">
            <div className="workbench__meta">
              <span>{requirement.pattern}</span>
              <span>{formatAgentName(step.agent)}</span>
            </div>
          </SummaryCard>
        </div>
      );
    }
    case "clarification": {
      const clarification = value as ClarificationOutput;
      if (!clarification.summary || !Array.isArray(clarification.questions)) {
        return <EmptyStepSummary step={step} />;
      }
      const openQs = (clarification as { questions?: Array<{ status?: string }> }).questions?.filter(
        (q) => q.status !== "resolved",
      ) ?? [];
      const decisions = (clarification as { decisions?: Array<{ id: string; title: string; finalAnswer: string }> }).decisions;
      return (
        <div className="step-summary">
          <SummaryCard title="澄清摘要">
            <p>{clarification.summary}</p>
          </SummaryCard>
          {decisions && decisions.length > 0 && (
            <SummaryCard title="已确认决策">
              <ul className="step-summary__list">
                {decisions.map((d) => (
                  <li key={d.id}>
                    <strong>{d.title}</strong>
                    <small>{d.finalAnswer}</small>
                  </li>
                ))}
              </ul>
            </SummaryCard>
          )}
          {openQs.length > 0 && (
          <SummaryCard title="关键问题">
            <ul className="step-summary__list">
              {clarification.questions.map((item) => (
                <li key={item.id}>
                  <strong>{item.question}</strong>
                  <small>{item.answer}</small>
                  <small>风险：{item.riskIfUnanswered}</small>
                </li>
              ))}
            </ul>
          </SummaryCard>
          )}
        </div>
      );
    }
    case "solution_design": {
      const solution = value as SolutionDsl;
      if (!solution.userStory || !Array.isArray(solution.acceptanceCriteria)) {
        return <EmptyStepSummary step={step} />;
      }
      return (
        <div className="step-summary">
          <SummaryCard title="用户故事">
            <p>{solution.userStory}</p>
          </SummaryCard>
          <SummaryCard title="验收标准">
            <ul className="step-summary__list">
              {solution.acceptanceCriteria.map((criteria) => <li key={criteria}>{criteria}</li>)}
            </ul>
          </SummaryCard>
        </div>
      );
    }
    case "module_mapping": {
      const mapping = value as ModuleMapping;
      if (!Array.isArray(mapping.touchedModules)) {
        return <EmptyStepSummary step={step} />;
      }
      return (
        <div className="step-summary">
          <SummaryCard title="命中模块">
            <ul className="step-summary__list">
              {mapping.touchedModules.map((module) => (
                <li key={module.name}>
                  <strong>{module.name}</strong>
                  <small>{module.reason}</small>
                  <small>{module.files.join(" · ")}</small>
                </li>
              ))}
            </ul>
          </SummaryCard>
        </div>
      );
    }
    case "code_generation": {
      const plan = value as CodeGenerationPlan;
      if (!plan.strategy || !Array.isArray(plan.tasks)) {
        return <EmptyStepSummary step={step} />;
      }
      const isVerificationTask = (task: CodeGenerationPlan["tasks"][number]) => {
        const haystack = [task.title, ...task.files].join(" ").toLowerCase();
        return /(^|[\\/_.-])(__tests__|tests?|spec|test)([\\/_.-]|$)/.test(haystack)
          || /测试|验证|单测|用例|覆盖率|test|spec/.test(haystack);
      };
      const implementationTasks = plan.tasks.filter((task) => !isVerificationTask(task));
      const explicitVerificationTasks = plan.tasks.filter(isVerificationTask);
      const derivedVerificationTasks = implementationTasks.filter((task) => task.testRequired);
      const verificationItems = [
        ...explicitVerificationTasks.map((task) => ({
          id: task.id,
          title: task.title,
          files: getCodeGenerationTaskTestFiles(task).length ? getCodeGenerationTaskTestFiles(task) : task.files,
        })),
        ...derivedVerificationTasks
          .filter((task) => !explicitVerificationTasks.some((verificationTask) => verificationTask.id === task.id))
          .map((task) => ({
            id: `${task.id}-verification`,
            title: `覆盖「${task.title}」的关键验收场景`,
            files: getCodeGenerationTaskTestFiles(task),
          })),
      ];
      return (
        <div className="step-summary">
          <SummaryCard title="生成策略">
            <p>{plan.strategy}</p>
          </SummaryCard>
          <SummaryCard title="实现改动">
            <ul className="step-summary__list">
              {(implementationTasks.length ? implementationTasks : plan.tasks).map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <small>{task.files.join(" · ")}</small>
                  {getCodeGenerationTaskTestFiles(task).length ? <small>测试：{getCodeGenerationTaskTestFiles(task).join(" · ")}</small> : null}
                  {task.coverLayer ? <small>{task.coverLayer.toUpperCase()} 层</small> : null}
                </li>
              ))}
            </ul>
          </SummaryCard>
          {verificationItems.length ? (
            <SummaryCard title="验证计划">
              <ul className="step-summary__list">
                {verificationItems.map((task) => (
                  <li key={task.id}>
                    <strong>{task.title}</strong>
                    {task.files.length ? <small>{task.files.join(" · ")}</small> : null}
                  </li>
                ))}
              </ul>
            </SummaryCard>
          ) : null}
        </div>
      );
    }
    case "repo_write": {
      const result = value as RepoWriteResult;
      if (!result.branch || !Array.isArray(result.filesChanged)) {
        return <EmptyStepSummary step={step} />;
      }
      return (
        <div className="step-summary">
          <SummaryCard title="写入分支">
            <p>{result.branch}</p>
          </SummaryCard>
          <SummaryCard title="文件变更">
            <ul className="step-summary__list">
              {result.filesChanged.map((file) => (
                <li key={file.path}>
                  <strong>{file.path}</strong>
                  <small>{formatChangeType(file.changeType)} · +{file.additions} / -{file.deletions}</small>
                </li>
              ))}
            </ul>
          </SummaryCard>
        </div>
      );
    }
    case "verification": {
      const result = value as VerificationResult;
      if (!result.lint || !Array.isArray(result.testSuites)) {
        return <EmptyStepSummary step={step} />;
      }
      return (
        <div className="step-summary">
          <SummaryCard title="质量门">
            <div className="workbench__meta">
              <span>Lint {formatRuntimeStatusValue(result.lint)}</span>
              <span>单测 {formatRuntimeStatusValue(result.unitTests)}</span>
              <span>覆盖率 {result.coverage}%</span>
            </div>
          </SummaryCard>
          <SummaryCard title="测试套件">
            <ul className="step-summary__list">
              {result.testSuites.map((suite) => (
                <li key={suite.name}>
                  <strong>{suite.name}</strong>
                  <small>{formatRuntimeStatusValue(suite.status)} · {suite.durationMs}ms</small>
                </li>
              ))}
            </ul>
          </SummaryCard>
        </div>
      );
    }
    case "code_review": {
      const result = value as {
        summary: string; decision: "approve" | "request-changes";
        findings: Array<{ id: string; severity: string; title: string; detail: string; file?: string; line?: number; recommendation?: string }>;
        checklist: Array<{ id: string; label: string; status: string; detail?: string }>;
        reviewedFiles: string[]; riskAreas: string[];
      };
      if (!result.summary) return <EmptyStepSummary step={step} />;
      const findings = Array.isArray(result.findings) ? result.findings : [];
      const checklist = Array.isArray(result.checklist) ? result.checklist : [];
      const reviewedFiles = Array.isArray(result.reviewedFiles) ? result.reviewedFiles : [];
      return (
        <div className="step-summary">
          <SummaryCard title="审查摘要">
            <p>{result.summary}</p>
          </SummaryCard>
          <SummaryCard title="审查结论">
            <Tag color={result.decision === "approve" ? "success" : "error"}>{result.decision === "approve" ? "通过" : "需要修改"}</Tag>
          </SummaryCard>
          {findings.length > 0 && (
            <SummaryCard title={`审查发现 (${findings.length})`}>
              <ul className="step-summary__list">
                {findings.map((f) => (
                  <li key={f.id}>
                    <Tag color={f.severity === "blocker" ? "red" : f.severity === "major" ? "orange" : f.severity === "minor" ? "blue" : "default"}>{f.severity}</Tag>
                    <strong>{f.title}</strong>
                    <small>{f.detail}{f.file ? ` · ${f.file}${f.line ? `:${f.line}` : ""}` : ""}</small>
                  </li>
                ))}
              </ul>
            </SummaryCard>
          )}
          {checklist.length > 0 && (
            <SummaryCard title="检查清单">
              <ul className="step-summary__list">
                {checklist.map((c) => (
                  <li key={c.id}><Tag color={c.status === "passed" ? "green" : c.status === "failed" ? "red" : "orange"}>{c.status}</Tag> {c.label}{c.detail ? ` — ${c.detail}` : ""}</li>
                ))}
              </ul>
            </SummaryCard>
          )}
          <SummaryCard title="审查文件">
            <ul className="step-summary__list">{reviewedFiles.map((f) => <li key={f}>{f}</li>)}</ul>
          </SummaryCard>
        </div>
      );
    }
  }
}


type RuntimeStatus = "waiting" | "running" | "blocked" | "success" | "failed" | "paused";
type RuntimeEvent = { id: string; time: string; title: string; detail: string; live?: boolean };
type ChatDensity = "primary" | "secondary" | "minimized";

function mapRuntimeStatus(step: { status: string }): RuntimeStatus {
  if (step.status === "idle") return "waiting";
  if (step.status === "running") return "running";
  if (step.status === "waiting-human") return "blocked";
  if (step.status === "success") return "success";
  if (step.status === "failed") return "failed";
  return "paused";
}

const runtimeStatusLabels: Record<RuntimeStatus, string> = {
  waiting: "等待执行",
  running: "正在执行",
  blocked: "待审核",
  success: "已完成",
  failed: "执行失败",
  paused: "已暂停",
};

const runtimeStatusColors: Record<RuntimeStatus, string> = {
  waiting: "default",
  running: "processing",
  blocked: "warning",
  success: "success",
  failed: "error",
  paused: "default",
};

const runtimeStateCopy: Record<RuntimeStatus, { eyebrow: string; title: string; description: string; cta: string }> = {
  waiting: {
    eyebrow: "待开始",
    title: "当前阶段等待处理",
    description: "AI 会生成结构化产出，并把结果传递给后续阶段。",
    cta: "运行当前阶段",
  },
  running: {
    eyebrow: "处理中",
    title: "AI 正在处理",
    description: "当前阶段正在生成结果。完成后会自动更新到当前工作区。",
    cta: "AI 正在处理",
  },
  blocked: {
    eyebrow: "需要确认",
    title: "需要你确认决策",
    description: "请确认 AI 当前理解，或补充反馈后交给 AI 继续处理。",
    cta: "确认并继续",
  },
  success: {
    eyebrow: "已完成",
    title: "当前阶段已完成",
    description: "产出已保存，可继续查看下一阶段或从此处回放。",
    cta: "查看下一步",
  },
  failed: {
    eyebrow: "失败",
    title: "当前阶段失败",
    description: "先查看失败原因，再选择重试或补充约束。",
    cta: "重试当前阶段",
  },
  paused: {
    eyebrow: "运行已暂停",
    title: "当前交付已暂停",
    description: "选择阶段继续运行、重放或查看历史输出。",
    cta: "恢复运行",
  },
};

function formatRuntimeStatusValue(value?: string) {
  if (!value) return "等待中";
  const statusMap: Record<string, string> = {
    failed: "失败",
    passed: "通过",
    pending: "等待中",
    ready: "就绪",
    success: "成功",
    running: "运行中",
    "waiting-human": "待审核",
    idle: "等待执行",
  };
  return statusMap[value] ?? value;
}

function formatAgentName(value: string) {
  const agentMap: Record<string, string> = {
    "Requirement Composer": "接收需求",
    "Clarifier Agent": "确认需求",
    "Planner Agent": "生成方案",
    "Context Locator": "定位代码",
    "Codegen Skill": "生成代码",
    "Code Review Agent": "代码审查",
    Verifier: "验证结果",
    "PR Assistant": "提交 PR",
  };
  if (/Writer$/i.test(value)) return "生成代码";
  return agentMap[value] ?? value;
}

function formatStepLabel(value: string) {
  const labelMap: Record<string, string> = {
    "PM 输入": "接收需求",
    "澄清 Agent": "确认需求",
    "方案 DSL": "生成方案",
    "模块定位": "定位代码",
    "代码计划": "生成代码",
    "代码审查": "代码审查",
    "写入仓库": "生成代码",
    "Lint / 单测": "质量门禁",
    "提交 PR": "提交 PR",
  };
  return labelMap[value] ?? value;
}

function formatRuntimeEventTitle(title: string) {
  const titleMap: Record<string, string> = {
    "User intervention submitted": "用户已提交反馈",
    "Regenerating current step": "AI 正在处理反馈",
    "Structured output updated": "结构化输出已更新",
    "Waiting for user confirmation": "待审核",
    "Waiting for intervention": "待审核",
    "Runtime auto-continue enabled": "已启用自动继续",
    "User confirmed; Runtime auto-continue resumed": "用户已确认，AI 继续执行",
  };
  if (titleMap[title]) return titleMap[title];
  return Object.entries({
    "Requirement Composer": "接收需求",
    "Clarifier Agent": "确认需求",
    "Planner Agent": "生成方案",
    "Context Locator": "定位代码",
    "Codegen Skill": "生成代码",
    "Code Review Agent": "代码审查",
    Verifier: "验证结果",
    "PR Assistant": "提交 PR",
    Runtime: "AI",
    Trigger: "触发器",
    Step: "阶段",
  }).reduce((nextTitle, [source, target]) => nextTitle.replaceAll(source, target), title)
    .replace(/\b[A-Za-z]+\s+Writer\b/g, "生成代码")
    .replace(/ started$/, " 开始执行")
    .replace(/ finished$/, " 执行完成")
    .replace(/ waiting for user$/i, " 待审核")
    .replace(/ running$/i, " 正在执行");
}

function formatChangeType(value: string) {
  const typeMap: Record<string, string> = {
    added: "新增",
    created: "新增",
    deleted: "删除",
    modified: "修改",
    renamed: "重命名",
    updated: "更新",
  };
  return typeMap[value] ?? value;
}

function getQuestionTopic(question: ClarificationOutput["questions"][number], index: number) {
  const raw = question.question?.trim();
  if (!raw) return `待确认项 ${index + 1}`;

  // 去掉空泛开头和标点，提取关键词汇
  const cleaned = raw
    .replace(/^[是否请问如何能否可以需要]*[？?？，,。.\s]*/g, "")
    .replace(/[？?？。.]/g, "");

  // 优先取 clean 后文本的前 8-16 个中文字符作为短标题
  const short = cleaned.slice(0, 16).trim();
  if (short.length >= 4) return short;

  // 太短时回退到原文本截断
  const fallback = raw.replace(/[？?？。.]/g, "").slice(0, 16).trim();
  return fallback || `待确认项 ${index + 1}`;
}

function getTimelineColor(status: RuntimeStatus) {
  if (status === "success") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "blue";
  if (status === "blocked") return "orange";
  return "gray";
}

function buildExecutionEvents(steps: StepRun[], activeStep: StepRun | null, activeStatus: RuntimeStatus): RuntimeEvent[] {
  return steps.flatMap((step) => {
    const lifecycle = [
      step.startedAt ? { id: `${step.id}-started`, time: step.startedAt, title: `${step.agent} started`, detail: formatStepLabel(step.label), live: false } : null,
      ...step.logs.map((log, index) => ({
        id: `${step.id}-log-${index}`,
        time: step.finishedAt ?? step.startedAt ?? "",
        title: log,
        detail: `${formatStepLabel(step.label)} · 事件 ${index + 1}`,
        live: false,
      })),
      step.finishedAt ? { id: `${step.id}-finished`, time: step.finishedAt, title: `${step.agent} finished`, detail: formatRuntimeStatusValue(step.status), live: false } : null,
    ].filter(Boolean) as RuntimeEvent[];
    return lifecycle;
  }).concat(activeStep && ["running", "blocked"].includes(activeStatus) ? [{
    id: `${activeStep.id}-live-${activeStatus}`,
    time: new Date().toISOString(),
    title: activeStatus === "blocked" ? "待审核" : `${formatAgentName(activeStep.agent)} ${runtimeStatusLabels[activeStatus]}`,
    detail: formatStepLabel(activeStep.label),
    live: true,
  }] : []).slice(-16);
}

function canReplayStep(stepId: WorkflowStepId) {
  return stepId !== "requirement_intake";
}

function RuntimeTimeline({
  steps,
  activeStepId,
  activeStatus,
  onSelect,
  onReplay,
}: {
  steps: StepRun[];
  activeStepId: WorkflowStepId;
  activeStatus: RuntimeStatus;
  onSelect: (stepId: WorkflowStepId) => void;
  onReplay: (stepId: WorkflowStepId) => void;
}) {
  return (
    <Card className="runtime-panel runtime-timeline" title="交付阶段" bordered={false}>
      <Timeline
        items={steps.map((step) => {
          const active = step.id === activeStepId;
          const status = active ? activeStatus : mapRuntimeStatus(step);
          const replayable = canReplayStep(step.id);
          return {
            color: getTimelineColor(status),
            dot: active ? <span className={`runtime-timeline-dot runtime-timeline-dot--${status}`} /> : undefined,
            children: (
              <article
                className={`runtime-step runtime-state--${status} ${active ? "runtime-step--active" : ""}`}
                onClick={() => onSelect(step.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(step.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <span className="runtime-step__title-row">
                  <span className="runtime-step__title">{formatStepLabel(step.label)}</span>
                  {replayable ? (
                    <Button
                      aria-label={`从 ${formatStepLabel(step.label)} 重放`}
                      className="runtime-step__replay"
                      size="small"
                      title={`从 ${formatStepLabel(step.label)} 重放`}
                      type="text"
                      onClick={(event) => { event.stopPropagation(); onReplay(step.id); }}
                    >
                      ↺
                    </Button>
                  ) : null}
                </span>
                <span className="runtime-step__agent">{formatAgentName(step.agent)}</span>
                <span className="runtime-step__footer">
                  <Tag color={runtimeStatusColors[status]} variant="outlined">{runtimeStatusLabels[status]}</Tag>
                  {(step.replayCount ?? 0) > 0 ? <Tag color="purple" variant="outlined">重跑 {step.replayCount} 次</Tag> : null}
                </span>
              </article>
            ),
          };
        })}
      />
    </Card>
  );
}

type ProgressStep = { id: WorkflowStepId; label: string; status: string; agent?: string; sourceStepIds?: WorkflowStepId[] };

function StepProgress({
  steps,
  activeStepId,
  activeStatus,
  continueCueStepId,
  onSelect,
  onReplay,
  onContinue,
}: {
  steps: ProgressStep[];
  activeStepId: WorkflowStepId;
  activeStatus: RuntimeStatus;
  continueCueStepId?: WorkflowStepId | null;
  onSelect: (stepId: WorkflowStepId) => void;
  onReplay: (stepId: WorkflowStepId) => void;
  onContinue: (stepId: WorkflowStepId) => void;
}) {
  const currentProgressIndex = (() => {
    const firstOpen = steps.findIndex((step) => step.status !== "success");
    return firstOpen === -1 ? steps.length - 1 : firstOpen;
  })();
  const percent = steps.length > 1 ? Math.round((currentProgressIndex / (steps.length - 1)) * 100) : 0;

  return (
    <section className="task-stepper" aria-label="交付阶段">
      <div className="task-stepper__bar">
        <span>交付阶段</span>
        <Progress percent={percent} showInfo={false} size="small" />
      </div>
      <div className="task-stepper__items">
        {steps.map((step, index) => {
          const active = step.id === activeStepId;
          const status = active ? activeStatus : mapRuntimeStatus(step);
          const disabled = index > currentProgressIndex;
          const current = index === currentProgressIndex;
          const canShowActions = active;
          const canContinue = !disabled && ["waiting", "blocked", "failed", "paused"].includes(status);
          const replayable = canReplayStep(step.id);
          const shouldCueContinue = canContinue && continueCueStepId === step.id;
          return (
            <div
              aria-disabled={disabled || undefined}
              aria-label={`${formatStepLabel(step.label)}，${runtimeStatusLabels[status]}`}
              className={`task-stepper__item task-stepper__item--${status} ${active ? "task-stepper__item--active" : ""} ${current ? "task-stepper__item--current" : ""} ${disabled ? "task-stepper__item--disabled" : ""}`}
              key={step.id}
              onKeyDown={(event) => {
                if (disabled) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(step.id);
                }
              }}
              onClick={() => {
                if (!disabled) onSelect(step.id);
              }}
              role="button"
              tabIndex={disabled ? -1 : 0}
            >
              <span className="task-stepper__content">
                <strong>{formatStepLabel(step.label)}</strong>
              </span>
              <span className="task-stepper__actions">
                {replayable ? (
                  <Button
                    aria-label={`从 ${formatStepLabel(step.label)} 重放`}
                    className={`task-stepper__action task-stepper__replay ${canShowActions ? "task-stepper__action--available" : ""}`}
                    size="small"
                    title={`从 ${formatStepLabel(step.label)} 重放`}
                    type="text"
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!disabled) onReplay(step.id);
                    }}
                  >
                    <img className="task-stepper__action-icon" src={stageReplayIcon} alt="" aria-hidden="true" />
                  </Button>
                ) : null}
                {canContinue ? (
                  <Button
                    aria-label={`继续 ${formatStepLabel(step.label)}`}
                    className={`task-stepper__action task-stepper__continue task-stepper__action--available ${shouldCueContinue ? "task-stepper__continue--cue" : ""}`}
                    size="small"
                    title={`继续 ${formatStepLabel(step.label)}`}
                    type="text"
                    onClick={(event) => {
                      event.stopPropagation();
                      onContinue(step.id);
                    }}
                  >
                    <img className="task-stepper__action-icon" src={stageContinueIcon} alt="" aria-hidden="true" />
                  </Button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StepChatThread({
  step,
  messages,
  draft,
  running,
  density = "secondary",
  composerEnabled = true,
  onDraftChange,
  onSubmit,
}: {
  step: StepRun;
  messages: InterventionMessage[];
  draft: string;
  running: boolean;
  density?: ChatDensity;
  composerEnabled?: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const visibleMessages = messages.filter((message) => message.stepId === step.id);
  const threadMessages = density === "minimized" ? visibleMessages.slice(-2) : visibleMessages;
  const waitingForUser = step.status === "waiting-human";

  function submitFromComposer() {
    const syntheticEvent = { preventDefault: () => undefined } as FormEvent;
    onSubmit(syntheticEvent);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey || !event.shiftKey) {
      event.preventDefault();
      submitFromComposer();
    }
  }

  return (
    <section className={`runtime-chat runtime-chat--${density}`}>
      <header className="runtime-chat__header">
        <div>
          <span>反馈</span>
          <h3>当前阶段反馈</h3>
        </div>
        {waitingForUser ? <Tag color="warning" variant="outlined">待审核</Tag> : <Tag variant="outlined">反馈历史</Tag>}
      </header>
      {waitingForUser ? (
        <div className="runtime-chat__waiting">
          <strong>等待确认</strong>
          <span>当前阶段已暂停。你可以补充约束或直接从阶段条继续。</span>
        </div>
      ) : null}
      <div className="runtime-chat__thread">
        {visibleMessages.length === 0 ? (
          <p className="runtime-muted">当前阶段还没有反馈历史。补充约束后，它会作为运行记忆影响当前阶段的重新生成。</p>
        ) : threadMessages.map((message) => (
          <article className={`runtime-chat__message runtime-chat__message--${message.role}`} key={message.id}>
            <strong>{message.role === "user" ? "用户" : message.role === "system" ? "系统" : formatAgentName(step.agent)}</strong>
            <p>{message.content}</p>
            <small>{new Date(message.createdAt).toLocaleTimeString()}</small>
          </article>
        ))}
      </div>
      {composerEnabled ? (
        <form className="runtime-chat__input" onSubmit={onSubmit}>
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 4 }}
            disabled={running}
            onKeyDown={handleKeyDown}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="继续补充当前阶段的约束，例如：不统计 Markdown 标记，只统计纯文本。"
            value={draft}
          />
        </form>
      ) : (
        <p className="runtime-chat__minimized-note">当前阶段已完成。反馈历史会作为运行记忆保留；需要继续修正时可从阶段条重放。</p>
      )}
    </section>
  );
}

function StepInterventionWorkspace({
  step,
  messages,
  running,
  showReview = true,
  onSubmitMessage,
  onFeedbackChange,
  onContinueCueChange,
  submitRef,
}: {
  step: StepRun;
  messages: InterventionMessage[];
  running: boolean;
  showReview?: boolean;
  onSubmitMessage: (message: string) => void;
  onFeedbackChange?: (hasPending: boolean) => void;
  onContinueCueChange?: (ready: boolean) => void;
  submitRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [questionFeedback, setQuestionFeedback] = useState<Record<string, string>>({});
  const [generalFeedback, setGeneralFeedback] = useState("");
  const [expandedSupplement, setExpandedSupplement] = useState<Record<string, boolean>>({});
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const visibleMessages = messages.filter((message) => message.stepId === step.id && message.role !== "agent");
  const value = step.output ?? step.input;
  const clarification = step.id === "clarification" && isRecord(value) ? value as ClarificationOutput : null;
  const questions = useMemo(() => clarification?.questions ?? [], [clarification]);
  const openQuestions = useMemo(
    () => questions.filter((q) => (q as { status?: string }).status !== "resolved"),
    [questions],
  );

  useEffect(() => {
    setQuestionFeedback({});
    setGeneralFeedback("");
    setExpandedSupplement({});
    setSelectedOptions({});
  }, [step.id]);
  useEffect(() => {
    if (submitRef) {
      submitRef.current = submitFeedback;
      return () => { if (submitRef.current === submitFeedback) submitRef.current = null; };
    }
  }, [submitFeedback, submitRef]);
  useEffect(() => {
    const hasQ = Object.values(questionFeedback).some((v) => v.trim());
    const hasSel = Object.values(selectedOptions).some((arr) => arr.length > 0);
    const hasGen = generalFeedback.trim() !== "";
    onFeedbackChange?.(hasQ || hasSel || hasGen);
  }, [questionFeedback, selectedOptions, generalFeedback, onFeedbackChange]);

  useEffect(() => {
    if (!clarification) {
      onContinueCueChange?.(true);
      return;
    }

    const choiceQuestions = openQuestions.filter((question) => question.responseControl);
    if (choiceQuestions.length === 0) {
      onContinueCueChange?.(true);
      return;
    }

    const allChoiceQuestionsHandled = choiceQuestions.every((question) => {
      const selected = selectedOptions[question.id] ?? [];
      const custom = questionFeedback[question.id]?.trim() ?? "";
      return selected.length > 0 || custom.length > 0;
    });
    onContinueCueChange?.(allChoiceQuestionsHandled);
  }, [clarification, onContinueCueChange, openQuestions, questionFeedback, selectedOptions]);

  /** 判断 AI 当前理解是否有有效内容 */
  function isAnswerValid(answer: string | undefined): boolean {
    if (!answer || !answer.trim()) return false;
    const placeholderPatterns = [
      "当前还没有明确理解",
      "暂无",
      "待确认",
      "需要你补充",
      "需要补充",
    ];
    const cleaned = answer.trim();
    if (cleaned.length < 2) return false;
    for (const p of placeholderPatterns) {
      if (cleaned.includes(p) && cleaned.length < 20) return false;
    }
    return true;
  }

  function toggleSupplement(questionId: string) {
    setExpandedSupplement((prev) => ({ ...prev, [questionId]: !prev[questionId] }));
  }

  function handleSupplementBlur(questionId: string) {
    setExpandedSupplement((prev) => ({ ...prev, [questionId]: false }));
  }

  function submitFeedback() {
    const questionReplies = questions
      .map((question, index) => {
        const selected = selectedOptions[question.id];
        const custom = questionFeedback[question.id]?.trim();
        if ((!selected || selected.length === 0) && !custom) return null;

        const parts: string[] = [];
        parts.push(`问题：${question.question}`);

        if (selected && selected.length > 0 && question.responseControl) {
          const labels = question.responseControl.options
            .filter((opt) => selected.includes(opt.id))
            .map((opt) => {
              let line = `选择：${opt.label}`;
              if (opt.description) line += `\n说明：${opt.description}`;
              return line;
            });
          parts.push(...labels);
        }

        if (custom) {
          parts.push(`其他，请告诉 AI 你的预期 ${custom}`);
        }

        return parts.join("\n");
      })
      .filter(Boolean);
    const general = generalFeedback.trim();
    const messageParts = [
      questionReplies.length ? `针对 ${formatAgentName(step.agent)} 的逐条反馈：\n\n${questionReplies.join("\n\n")}` : null,
      general ? `整体补充：\n${general}` : null,
    ].filter(Boolean);

    if (!messageParts.length) return;
    onSubmitMessage(messageParts.join("\n\n"));
    setQuestionFeedback({});
    setGeneralFeedback("");
    setSelectedOptions({});
  }

  return (
    <section className="intervention-workspace">
      {clarification ? (() => {
        const hasDecisions = ((clarification as { decisions?: unknown[] }).decisions?.length ?? 0) > 0;
        const isComplete =
          (clarification as { clarificationComplete?: boolean }).clarificationComplete === true ||
          (openQuestions.length === 0 && questions.length > 0 && hasDecisions);

        // 澄清已完成：显示 decisions，不显示问题列表
        if (isComplete || (openQuestions.length === 0 && questionFeedback && Object.keys(questionFeedback).length === 0 && Object.keys(selectedOptions).length === 0)) {
          return (
            <section className="clarification-review">
              <SurfaceCard title="AI 当前理解" tone="muted">
                {clarification.summary}
              </SurfaceCard>
              <SurfaceCard title="澄清已完成" tone="success">
                {isComplete
                  ? "所有问题已解决。已确认的决策将传递给方案设计阶段。"
                  : "当前没有待审核的开放问题。"}
              </SurfaceCard>
              {(clarification as { decisions?: Array<{ id: string; title: string; finalAnswer: string; source: string }> }).decisions?.map((d) => (
                <SurfaceCard key={d.id} title={d.title} tone="muted">
                  <div style={{ color: "#667085", fontSize: 12 }}>{d.finalAnswer}</div>
                </SurfaceCard>
              ))}
            </section>
          );
        }

        return (
        <section className="clarification-review">
          <SurfaceCard title="AI 当前理解" tone="muted">
            {clarification.summary}
          </SurfaceCard>
          <Collapse
            className="clarification-question-list"
            defaultActiveKey={questions[0]?.id ? [questions[0].id] : []}
            items={openQuestions.map((question, index) => ({
              key: question.id,
              label: (
                <span className="clarification-question-list__label">
                  <b>{question.title ?? getQuestionTopic(question, index)}</b>
                </span>
              ),
              children: (
                <div className="clarification-question">
                  <SurfaceCard title="待确认项">
                    {question.question}
                  </SurfaceCard>
                  {isAnswerValid(question.answer) ? (
                    <SurfaceCard title="AI 当前理解" tone="muted">
                      {question.answer!.trim()}
                    </SurfaceCard>
                  ) : null}
                  <SurfaceCard title="存在风险" tone="warning">
                    {question.riskIfUnanswered}
                  </SurfaceCard>

                  {/* responseControl: AI 输出的选择题 */}
                  {question.responseControl ? (() => {
                    const rc = question.responseControl;
                    const selected = selectedOptions[question.id] ?? [];
                    const isSingle = rc.type === "single";
                    const letters = "ABCDEFGH";

                    function toggleOption(optionId: string) {
                      setSelectedOptions((prev) => {
                        const current = prev[question.id] ?? [];
                        if (isSingle) {
                          return { ...prev, [question.id]: current.includes(optionId) ? [] : [optionId] };
                        }
                        return {
                          ...prev,
                          [question.id]: current.includes(optionId)
                            ? current.filter((id) => id !== optionId)
                            : [...current, optionId],
                        };
                      });
                    }

                    const customId = `__custom__${question.id}`;
                    const customText = questionFeedback[question.id]?.trim();
                    const customPrefix = letters[rc.options.length] ?? "?";

                    function toggleCustom() {
                      toggleSupplement(question.id);
                      // 点击自定义即标记为「已选择」（有文本内容时选中态随之生效）
                      if (!customText) {
                        setSelectedOptions((prev) => {
                          const current = prev[question.id] ?? [];
                          if (isSingle) return { ...prev, [question.id]: [] };
                          return { ...prev, [question.id]: current };
                        });
                      }
                    }

                    return (
                      <SurfaceCard title={isSingle ? "请选择（单选）" : "请选择（多选）"} tone="accent">
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {/* AI 给出的选项 */}
                          {rc.options.map((opt, i) => {
                            const isSelected = selected.includes(opt.id);
                            return (
                              <SurfaceCard
                                key={opt.id}
                                tone={isSelected ? "success" : "default"}
                                interactive
                                selected={isSelected}
                                onClick={() => toggleOption(opt.id)}
                              >
                                <span style={{ fontWeight: 700 }}>{letters[i]}.</span> {opt.label}
                                {opt.description && (
                                  <div style={{ color: "#667085", fontSize: 12, marginTop: 4 }}>{opt.description}</div>
                                )}
                              </SurfaceCard>
                            );
                          })}

                          {/* 自定义补充：作为最后一个选项，可选中 */}
                          {expandedSupplement[question.id] ? (
                            <SurfaceCard
                              tone={customText ? "success" : "accent"}
                              selected={!!customText}
                            >
                              <span style={{ fontWeight: 700 }}>{customPrefix}.</span> 其他，请告诉 AI 你的预期
                              <Input.TextArea
                                autoFocus
                                autoSize={{ minRows: 2, maxRows: 4 }}
                                disabled={running}
                                onBlur={() => handleSupplementBlur(question.id)}
                                onChange={(event) => setQuestionFeedback((current) => ({ ...current, [question.id]: event.target.value }))}
                                placeholder="请在此输入你的预期"
                                value={questionFeedback[question.id] ?? ""}
                                style={{ marginTop: 8 }}
                              />
                            </SurfaceCard>
                          ) : (
                            <SurfaceCard
                              tone={customText ? "success" : "muted"}
                              interactive
                              selected={!!customText}
                              onClick={toggleCustom}
                            >
                              <span style={{ fontWeight: 700 }}>{customPrefix}.</span> 其他，请告诉 AI 你的预期
                              {customText && (
                                <Typography.Text ellipsis style={{ color: "#344054", display: "block", marginTop: 4 }}>
                                  {customText}
                                </Typography.Text>
                              )}
                            </SurfaceCard>
                          )}
                        </div>
                      </SurfaceCard>
                    );
                  })() : (
                    /* 无 responseControl 的降级：纯文本补充 */
                    expandedSupplement[question.id] ? (
                      <SurfaceCard title="用户补充" tone="accent">
                        <Input.TextArea
                          autoFocus
                          autoSize={{ minRows: 2, maxRows: 5 }}
                          disabled={running}
                          onBlur={() => handleSupplementBlur(question.id)}
                          onChange={(event) => setQuestionFeedback((current) => ({ ...current, [question.id]: event.target.value }))}
                          placeholder="补充额外约束，例如：不统计 Markdown 标签，仅统计纯文本内容。"
                          value={questionFeedback[question.id] ?? ""}
                        />
                      </SurfaceCard>
                    ) : (
                      <SurfaceCard
                        title="用户补充"
                        tone="accent"
                        interactive
                        onClick={() => toggleSupplement(question.id)}
                      >
                        {questionFeedback[question.id]?.trim() || null}
                      </SurfaceCard>
                    )
                  )}
                </div>
              ),
            }))}
          />
        </section>
      );
    })() : showReview ? (
        <section className="clarification-review">
          {renderStepSummary(step)}
        </section>
      ) : null}

      <section className="intervention-composer">
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={running}
          onChange={(event) => setGeneralFeedback(event.target.value)}
          placeholder="也可以在这里补充说明，系统会和上面的逐条反馈一起发送。"
          value={generalFeedback}
        />
        <div className="intervention-composer__footer">
          <span>{questions.length ? `${questions.length} 条待确认问题` : "当前阶段可直接补充说明"}</span>
        </div>
      </section>

      <section className="intervention-history-inline">
        <RuntimeMemoryPanel messages={visibleMessages} />
      </section>
    </section>
  );
}

function RuntimeMemoryPanel({ messages }: { messages: InterventionMessage[] }) {
  const items = parseDecisionMemoryItems(messages);

  const typeTags: Record<DecisionMemoryItem["type"], { label: string; color: string }> = {
    "business-rule": { label: "业务规则", color: "blue" },
    "display-rule": { label: "展示规则", color: "purple" },
    "technical-constraint": { label: "技术约束", color: "cyan" },
    risk: { label: "风险规避", color: "orange" },
    preference: { label: "用户偏好", color: "green" },
    other: { label: "其他", color: "default" },
  };
  const sourceLabel: Record<DecisionMemoryItem["source"], string> = {
    "user-confirmed": "用户确认",
    "user-feedback": "用户补充",
    "option-selection": "选择题选项",
  };

  return (
    <section className="runtime-memory-panel">
      <header>
        <span>已确认约束</span>
        <h3>已确认约束</h3>
      </header>
      {items.length ? items.map((item) => (
        <SurfaceCard key={item.id} title={item.title} tone="muted">
          <Space wrap size={4}>
            <Tag color={typeTags[item.type].color}>{typeTags[item.type].label}</Tag>
            {item.target && <Tag variant="outlined">{item.target}</Tag>}
          </Space>
          <div style={{ margin: "4px 0", color: "#344054", fontSize: 13, lineHeight: 1.5 }}>
            {item.content}
          </div>
          <Space size={8} style={{ fontSize: 11, color: "#667085" }}>
            <span>来源: {sourceLabel[item.source]}</span>
            {item.sourceStepLabel && <span>阶段: {formatStepLabel(item.sourceStepLabel)}</span>}
            <span>{new Date(item.updatedAt).toLocaleTimeString()}</span>
          </Space>
        </SurfaceCard>
      )) : (
        <p className="runtime-muted">尚未沉淀结构化约束。你的反馈会在这里沉淀为当前运行状态，而不是聊天记录。</p>
      )}
    </section>
  );
}

function ContextSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="runtime-context-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function InlineList({ items, empty }: { items: string[]; empty: string }) {
  return (
    <ul className="runtime-context-list">
      {(items.length ? items : [empty]).map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

type ChangedFileEntry = {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
  contentPreview?: string;
  source: "applied" | "pending" | "summary" | "derived";
};

function getRepoChangeEntries(repoResult?: RepoWriteResult): ChangedFileEntry[] {
  const source = repoResult?.appliedChanges?.length
    ? { files: repoResult.appliedChanges, source: "applied" as const }
    : repoResult?.pendingChanges?.length
      ? { files: repoResult.pendingChanges, source: "pending" as const }
      : repoResult?.filesChanged?.length
        ? { files: repoResult.filesChanged, source: "summary" as const }
        : { files: [], source: "summary" as const };

  return source.files.map((file) => ({
    path: file.path,
    changeType: file.changeType,
    additions: file.additions,
    deletions: file.deletions,
    contentPreview: file.contentPreview,
    source: source.source,
  }));
}

function getCodeGenerationRepoResult(step?: StepRun): RepoWriteResult | undefined {
  const output = step?.output as (CodeGenerationPlan & { repoWriteResult?: RepoWriteResult }) | undefined;
  if (output?.repoWriteResult) return output.repoWriteResult;
  if (output && "mode" in output && "filesChanged" in output) return output as unknown as RepoWriteResult;
  return undefined;
}

function getChangedFiles(step: StepRun, repoResult?: RepoWriteResult) {
  const repoEntries = getRepoChangeEntries(repoResult);
  if (repoEntries.length) {
    return repoEntries.map((file) => file.path);
  }

  const value = step.output;
  if (step.id === "module_mapping" && isRecord(value) && Array.isArray((value as ModuleMapping).touchedModules)) {
    return (value as ModuleMapping).touchedModules.flatMap((module) => module.files);
  }
  if (step.id === "code_generation" && isRecord(value) && Array.isArray((value as CodeGenerationPlan).tasks)) {
    return (value as CodeGenerationPlan).tasks.flatMap((task) => task.files);
  }
  return [];
}

function getChangedFileEntries(step: StepRun, repoResult?: RepoWriteResult): ChangedFileEntry[] {
  const repoEntries = getRepoChangeEntries(repoResult);
  if (repoEntries.length) {
    return repoEntries;
  }

  return getChangedFiles(step).map((path) => ({
    path,
    changeType: "modified" as const,
    additions: 0,
    deletions: 0,
    source: "derived" as const,
  }));
}

function splitFilePath(path: string) {
  const parts = path.split("/");
  const filename = parts.pop() ?? path;
  return {
    directory: parts.length ? `${parts.join("/")}/` : "",
    filename,
  };
}

function getFileType(path: string) {
  const extension = path.split(".").pop()?.toUpperCase();
  if (!extension || extension === path.toUpperCase()) return "FILE";
  if (["TS", "TSX", "JS", "JSX", "JSON", "MD", "CSS"].includes(extension)) return extension;
  return extension.slice(0, 4);
}

function isPatchReviewStep(step: StepRun) {
  return ["repo_write", "verification"].includes(step.id);
}

// ---- Display Model: legacy run 兼容。新 workflow 只有 code_generation 一个真实“生成代码”阶段。 ----

type DisplayStepId = WorkflowStepId | "code_delivery";

type DisplayStep = {
  id: DisplayStepId;
  label: string;
  sourceStepIds: WorkflowStepId[];
  status: "idle" | "running" | "waiting-human" | "success" | "failed";
  sourceSteps: StepRun[];
};

/** 将展示步骤 id 映射回后端步骤 id，按动作类型区分语义 */
function resolveBackendStepId(
  displayId: WorkflowStepId,
  displaySteps: DisplayStep[],
  action: "select" | "continue" | "replay" | "feedback",
): WorkflowStepId {
  if (displayId !== ("code_delivery" as WorkflowStepId)) return displayId;
  const ds = displaySteps.find((d) => d.id === "code_delivery");
  if (!ds) return "code_generation";

  const repoStep = ds.sourceSteps.find((s) => s.id === "repo_write");
  const codegenStep = ds.sourceSteps.find((s) => s.id === "code_generation");
  const repoIsActionable = Boolean(
    repoStep &&
    codegenStep?.status === "success" &&
    repoStep.status !== "success",
  );

  switch (action) {
    case "replay":
      // 重放永远从 code_generation 开始
      return "code_generation";
    case "continue":
      // 代码计划已确认后，继续必须推进到写入阶段，否则合并展示会断链。
      return "code_generation";
    case "feedback":
      // legacy run: repo_write 等待确认时仍可接收反馈并由后端回灌到代码生成。
      return "code_generation";
    case "select":
      // 计划完成后，展示阶段的真实落点应是写入阶段，避免继续按钮重新执行计划。
      return "code_generation";
  }
}

function getCodeDeliveryEffectiveStep(codegenStep?: StepRun, repoWriteStep?: StepRun, action: "continue" | "feedback" = "continue") {
  if (!codegenStep) return codegenStep;
  if (!repoWriteStep) return codegenStep;

  if (action === "feedback") {
    return codegenStep;
  }

  if (codegenStep.status === "success" && repoWriteStep.status !== "success") {
    return codegenStep;
  }
  return codegenStep;
}

/** 兼容旧版运行：把 code_generation + repo_write 合并为一个展示步骤。 */
function getDisplaySteps(steps: StepRun[]): DisplayStep[] {
  const result: DisplayStep[] = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].id === "code_generation" && i + 1 < steps.length && steps[i + 1].id === "repo_write") {
      const cg = steps[i];
      const rw = steps[i + 1];
      result.push({
        id: "code_delivery",
        label: "生成代码",
        sourceStepIds: ["code_generation", "repo_write"],
        status: mergedStepStatus(cg.status, rw.status),
        sourceSteps: [cg, rw],
      });
      i += 2;
    } else {
      result.push({
        id: steps[i].id,
        label: steps[i].label,
        sourceStepIds: [steps[i].id],
        status: steps[i].status as DisplayStep["status"],
        sourceSteps: [steps[i]],
      });
      i += 1;
    }
  }
  return result;
}

function mergedStepStatus(cgStatus: string, rwStatus: string): DisplayStep["status"] {
  if (cgStatus === "failed" || rwStatus === "failed") return "failed";
  if (cgStatus === "running" || rwStatus === "running") return "running";
  if (rwStatus === "waiting-human") return "waiting-human";
  if (rwStatus === "success") return "success";
  if (cgStatus === "waiting-human") return "waiting-human";
  return "idle";
}

function getDisplayActiveStep(run: WorkflowRun, displaySteps: DisplayStep[]): DisplayStep | null {
  const activeId = run.activeStepId;
  return displaySteps.find((ds) => ds.sourceStepIds.includes(activeId)) ?? null;
}

// ---- CodeDeliveryWorkspace: 合并展示组件 ----

const codeDeliveryBanner = {
  running: { eyebrow: "正在执行", title: "AI 正在生成代码", description: "完成后必须展示可审查的文件 diff。" },
  blocked: { eyebrow: "待审核", title: "请确认生成的代码", description: "你可以审查文件 diff，补充反馈，或从阶段条继续。" },
  success: { eyebrow: "已完成", title: "代码已生成", description: "请审查变更文件和真实 diff。" },
  failed: { eyebrow: "执行失败", title: "生成代码失败", description: "" },
  waiting: { eyebrow: "等待执行", title: "等待生成代码", description: "上游阶段完成后会进入代码生成。" },
  paused: { eyebrow: "已暂停", title: "生成代码已暂停", description: "" },
};

function CodeDeliveryWorkspace({
  codegenStep,
  repoWriteStep,
  repoResult,
  status,
  running,
  onInterventionMessage,
  draft,
  onDraftChange,
}: {
  codegenStep: StepRun;
  repoWriteStep?: StepRun;
  repoResult?: RepoWriteResult;
  status: RuntimeStatus;
  running: boolean;
  onInterventionMessage: (message: string) => void;
  draft?: string;
  onDraftChange?: (value: string) => void;
}) {
  const plan = codegenStep.output as CodeGenerationPlan | undefined;
  const reviewStep = repoWriteStep ?? codegenStep;
  const files = getChangedFileEntries(reviewStep, repoResult);
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const hasRealDiff = files.some((file) => Boolean(file.contentPreview?.trim()) || file.additions > 0 || file.deletions > 0);
  const baseCopy = codeDeliveryBanner[status] ?? codeDeliveryBanner.waiting;
  const copy = status === "blocked" || status === "success"
    ? hasRealDiff
      ? baseCopy
      : {
        ...baseCopy,
        eyebrow: "执行失败",
        title: "生成代码失败",
        description: "当前阶段没有产生可审查 diff，请重试或接入安全写入链路。",
      }
    : baseCopy;
  const failureReason = repoWriteStep?.logs.at(-1) ?? codegenStep.logs.at(-1);

  // running / failed / missing diff: 只显示 banner
  if (status === "running" || status === "failed" || ((status === "blocked" || status === "success") && !hasRealDiff)) {
    return (
      <div className={`runtime-state-layout runtime-state-layout--${status}`}>
        <section className={`runtime-state-banner runtime-state-banner--${status}`}>
          <div>
            <span>生成代码 · {copy.eyebrow}</span>
            <h2>{copy.title}</h2>
            <p>{status === "failed" && failureReason ? `原因：${failureReason}` : copy.description}</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={`runtime-state-layout runtime-state-layout--${status}`}>
      <section className={`runtime-state-banner runtime-state-banner--${status}`}>
        <div>
          <span>生成代码 · {copy.eyebrow}</span>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </section>

      <section className="runtime-output-workspace code-delivery-workspace">
        <Tabs
          className="patch-workspace__tabs code-delivery-tabs"
          defaultActiveKey="overview"
          items={[
            {
              key: "overview",
              label: "变更概览",
              children: (
                <div className="code-delivery-review-card">
                  {plan?.strategy && (
                    <header className="code-delivery-review-header">
                      <Typography.Text>{plan.strategy}</Typography.Text>
                      <span className="patch-metadata-line">{plan.tasks?.length ?? 0} 个修改项 · {files.length} 个文件</span>
                    </header>
                  )}

                  <Collapse
                    className="patch-file-list-collapse code-delivery-file-collapse"
                    ghost
                    items={files.length ? files.map((file) => {
                      const fileTasks = plan?.tasks?.filter((t) =>
                        t.files?.includes(file.path) || getCodeGenerationTaskTestFiles(t).includes(file.path),
                      ) ?? [];
                      const hasContent = Boolean(file.contentPreview?.trim()) || file.additions > 0 || file.deletions > 0;
                      return {
                        key: file.path,
                        showArrow: false,
                        label: (
                          <Tooltip title={file.path}>
                            <span className="changed-file-row">
                              <Tag className="changed-file-row__type" variant="outlined">{getFileType(file.path)}</Tag>
                              <span className="changed-file-row__identity">
                                <Typography.Text className="changed-file-row__path" ellipsis>{splitFilePath(file.path).directory || "./"}</Typography.Text>
                                <Typography.Text className="changed-file-row__name" ellipsis>{splitFilePath(file.path).filename}</Typography.Text>
                              </span>
                              {hasContent ? (
                                <span className="changed-file-row__stats">
                                  <span className="git-stat git-stat--add">+{file.additions}</span>
                                  <span className="git-stat git-stat--del">-{file.deletions}</span>
                                </span>
                              ) : null}
                            </span>
                          </Tooltip>
                        ),
                        children: (() => {
                          const implTasks = fileTasks.filter((t) => t.files?.includes(file.path));
                          const testTasks = fileTasks.filter((t) => !t.files?.includes(file.path) && getCodeGenerationTaskTestFiles(t).includes(file.path));
                          const allItems: Array<{ type: "impl"; task: typeof fileTasks[0] } | { type: "test"; task: typeof fileTasks[0]; implTask: typeof fileTasks[0] }> = [];
                          for (const t of implTasks) allItems.push({ type: "impl", task: t });
                          for (const t of testTasks) {
                            const implTask = fileTasks.find((it) => getCodeGenerationTaskTestFiles(it).includes(file.path) && it.files?.length);
                            allItems.push({ type: "test", task: t, implTask: implTask ?? t });
                          }

                          const layerLabel: Record<string, string> = { data: "数据层", api: "接口层", ui: "界面层" };
                          return (
                            <div style={{ display: "grid", gap: 6, padding: "4px 0" }}>
                              {allItems.map((item, i) => {
                                const isImpl = item.type === "impl";
                                const implTask = isImpl ? item.task : (item as { implTask: typeof fileTasks[0] }).implTask;
                                const testFiles = getCodeGenerationTaskTestFiles(implTask);
                                return (
                                  <div className="code-delivery-task-meta" key={`${item.task.id}-${i}`}>
                                    <strong className="code-delivery-task-meta__title">
                                      {isImpl
                                        ? implTask.title
                                        : `为 ${implTask.title?.replace(/^(实现|重构|新增|修复)\s*/, "").slice(0, 20) || "相关实现"} 补齐单元测试`}
                                    </strong>
                                    <span className="code-delivery-task-meta__tags">
                                      {isImpl ? (
                                        <>
                                          {testFiles.length > 0 && testFiles.map((tf) => (
                                            <Tag key={tf} className="code-delivery-tag code-delivery-tag--test" color="geekblue" variant="outlined">单元测试 {tf}</Tag>
                                          ))}
                                          {implTask.coverLayer && (
                                            <Tag className="code-delivery-tag code-delivery-tag--layer" color="blue" variant="outlined">{layerLabel[implTask.coverLayer] ?? implTask.coverLayer}</Tag>
                                          )}
                                        </>
                                      ) : (
                                        <>
                                          {implTask.files?.length > 0 && implTask.files.map((f) => (
                                            <Tag key={f} className="code-delivery-tag code-delivery-tag--target" color="geekblue" variant="outlined">测试对象 {f}</Tag>
                                          ))}
                                          <Tag className="code-delivery-tag code-delivery-tag--test" color="blue" variant="outlined">单元测试</Tag>
                                        </>
                                      )}
                                    </span>
                                  </div>
                                );
                              })}
                              {hasContent ? <FileContentPreview file={file} /> : null}
                            </div>
                          );
                        })(),
                      };
                    }) : []}
                  />

                  {reviewStep.status === "waiting-human" && (
                    <section className="code-delivery-section code-delivery-feedback-section">
                      <h4 className="code-delivery-section__title">反馈</h4>
                      <Input.TextArea
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        disabled={running}
                        value={draft ?? ""}
                        onChange={(e) => onDraftChange?.(e.target.value)}
                        placeholder="也可以在这里补充说明，例如：添加单元测试、调整展示位置。"
                      />
                      <div className="intervention-composer__footer" style={{ marginTop: 8 }}>
                        <span>反馈会影响生成代码阶段的重新生成</span>
                        <Button type="primary" loading={running} onClick={() => { if (draft?.trim()) onInterventionMessage(draft); }}>
                          提交反馈
                        </Button>
                      </div>
                    </section>
                  )}
                </div>
              ),
            },
          ]}
        />
      </section>
    </div>
  );
}

function ChangedFileLabel({ file }: { file: ChangedFileEntry }) {
  const { path } = file;
  const pathParts = splitFilePath(path);
  return (
    <span className="changed-file-row">
      <Tag className="changed-file-row__type" variant="outlined">{getFileType(path)}</Tag>
      <span className="changed-file-row__identity">
        <Typography.Text className="changed-file-row__path" ellipsis>{pathParts.directory || "./"}</Typography.Text>
        <Typography.Text className="changed-file-row__name" ellipsis>{pathParts.filename}</Typography.Text>
      </span>
      <span className="changed-file-row__stats">
        <span className="git-stat git-stat--add">+{file.additions}</span>
        <span className="git-stat git-stat--del">-{file.deletions}</span>
      </span>
    </span>
  );
}

function highlightCodeLine(line: string) {
  const parts = line.split(/(\b(?:import|from|export|default|function|const|let|var|return|if|else|for|while|class|interface|type|async|await|new|try|catch|throw)\b|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|\/\*.*\*\/|\b\d+(?:\.\d+)?\b)/g);
  return parts.filter(Boolean).map((part, index) => {
    if (/^["'`]/.test(part)) return <span className="code-token code-token--string" key={`${index}-${part}`}>{part}</span>;
    if (/^\/\/|^\/\*/.test(part)) return <span className="code-token code-token--comment" key={`${index}-${part}`}>{part}</span>;
    if (/^\d/.test(part)) return <span className="code-token code-token--number" key={`${index}-${part}`}>{part}</span>;
    if (/^(import|from|export|default|function|const|let|var|return|if|else|for|while|class|interface|type|async|await|new|try|catch|throw)$/.test(part)) {
      return <span className="code-token code-token--keyword" key={`${index}-${part}`}>{part}</span>;
    }
    return <span key={`${index}-${part}`}>{part}</span>;
  });
}

function getPreviewLineTone(line: string, file: ChangedFileEntry): "added" | "deleted" | "context" | "meta" {
  if (/^(diff --git|index |@@|--- |\+\+\+ )/.test(line)) return "meta";
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "deleted";
  if (file.changeType === "deleted") return "deleted";
  return "context";
}

function getDiffPreviewLines(content: string, file: ChangedFileEntry) {
  let oldLine = 1;
  let newLine = 1;
  const looksLikeDiff = content.split(/\r?\n/).some((line) => /^@@ -\d+/.test(line));

  if (!looksLikeDiff) {
    return content.split(/\r?\n/).map((text, index) => ({
      key: `${index}-${text}`,
      newLine: index + 1,
      oldLine: file.changeType === "created" || file.changeType === "added" ? undefined : index + 1,
      text,
      tone: file.changeType === "created" || file.changeType === "added" ? "added" as const : "context" as const,
    }));
  }

  return content.split(/\r?\n/).map((text, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { key: `${index}-${text}`, text, tone: "meta" as const };
    }

    const tone = getPreviewLineTone(text, file);
    if (tone === "added") {
      return { key: `${index}-${text}`, newLine: newLine++, text, tone };
    }
    if (tone === "deleted") {
      return { key: `${index}-${text}`, oldLine: oldLine++, text, tone };
    }
    if (tone === "meta") {
      return { key: `${index}-${text}`, text, tone };
    }

    return { key: `${index}-${text}`, oldLine: oldLine++, newLine: newLine++, text, tone };
  });
}

function FileContentPreview({ file }: { file: ChangedFileEntry }) {
  const content = file.contentPreview;
  if (!content?.trim()) {
    return <p className="patch-file-preview__empty">当前结果没有提供内容预览；可在本地 git diff 中查看完整变更。</p>;
  }

  const lines = getDiffPreviewLines(content, file);
  return (
    <div className="patch-file-preview" role="region" aria-label="文件内容预览">
      {lines.map((line) => (
        <div className={`patch-file-preview__line patch-file-preview__line--${line.tone}`} key={line.key}>
          <span className="patch-file-preview__line-number">{line.oldLine ?? ""}</span>
          <span className="patch-file-preview__line-number">{line.newLine ?? ""}</span>
          <code>{line.text ? highlightCodeLine(line.text) : " "}</code>
        </div>
      ))}
    </div>
  );
}

function ChecklistItem({ content, warning = false }: { content: string; warning?: boolean }) {
  const summary = content.replace(/^已/, "").replace(/，.*/, "");
  return (
    <Tooltip title={content}>
      <li className={`review-check-item ${warning ? "review-check-item--warning" : ""}`}>
        <span>{warning ? "!" : "✓"}</span>
        <Typography.Text ellipsis>{summary}</Typography.Text>
      </li>
    </Tooltip>
  );
}

function PatchReviewWorkspace({
  step,
  repoResult,
  verification,
}: {
  step: StepRun;
  repoResult?: RepoWriteResult;
  verification?: VerificationResult;
}) {
  const fileEntries = getChangedFileEntries(step, repoResult);
  const files = fileEntries.map((file) => file.path);
  const totalAdditions = fileEntries.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = fileEntries.reduce((sum, file) => sum + file.deletions, 0);
  const reviewMode = repoResult?.mode === "applied"
    ? "已写入工作区"
    : repoResult?.mode === "planned"
      ? "等待手动落盘"
      : "等待生成";
  const checklist = step.id === "pull_request" && isRecord(step.output) && Array.isArray((step.output as PullRequestResult).checklist)
    ? (step.output as PullRequestResult).checklist
    : [];
  const passedChecks = checklist.filter((c) => c.includes("pass") || c.includes("通过")).length;
  const riskSummary = verification && verification.lint === "passed" && verification.unitTests === "passed"
    ? "无关键风险"
    : verification
      ? "质量门需要复核"
      : "等待质量门";
  const hasQualityWarning = Boolean(verification && (verification.lint !== "passed" || verification.unitTests !== "passed"));
  const checksRequiringReview = hasQualityWarning ? 1 : 0;
  const overviewPanel = (
    <section className="patch-section patch-section--overview">
      <div className="patch-overview-flow">
        <article className="patch-git-summary">
          <div className="patch-git-summary__header">
            <strong>{reviewMode}</strong>
            <span>{repoResult?.branch ? `分支 ${repoResult.branch}` : "等待分支信息"}</span>
          </div>
          {repoResult?.diffSummary?.trim() ? (
            <pre>{repoResult.diffSummary}</pre>
          ) : (
            <p>暂无 git status 摘要；下面展示 AI 已返回的文件变更内容。</p>
          )}
        </article>
        <article className="patch-overview__files">
          <div className="patch-overview__files-header">
            <strong>变更文件</strong>
            <span className="patch-metadata-line">
              {files.length} 个文件变更
              <span className="git-stat git-stat--add">+{totalAdditions}</span>
              <span className="git-stat git-stat--del">-{totalDeletions}</span>
              {repoResult ? <span>已准备在 {repoResult.branch}</span> : <span>补丁等待生成</span>}
            </span>
          </div>
          <Collapse
            className="patch-file-list-collapse"
            ghost
            items={fileEntries.length ? fileEntries.map((file) => ({
              key: file.path,
              showArrow: false,
              label: (
                <Tooltip title={file.path}>
                  <ChangedFileLabel file={file} />
                </Tooltip>
              ),
              children: <FileContentPreview file={file} />,
            })) : [{
              key: "empty",
              showArrow: false,
              label: "暂无文件变更",
              children: <p className="patch-empty-row">当前阶段尚未产生文件变更。</p>,
            }]}
          />
        </article>
      </div>
    </section>
  );
  const verificationPanel = (
    <section className="patch-section patch-section--verification">
      <div className="quality-gate-strip">
        <span className={verification?.lint === "failed" ? "quality-gate-strip__item quality-gate-strip__item--failed" : "quality-gate-strip__item"}>
          Lint {formatRuntimeStatusValue(verification?.lint)}
        </span>
        <span className={verification?.unitTests === "failed" ? "quality-gate-strip__item quality-gate-strip__item--failed" : "quality-gate-strip__item"}>
          单测 {formatRuntimeStatusValue(verification?.unitTests)}
        </span>
        <span className={(verification?.coverage ?? 0) <= 0 ? "quality-gate-strip__item quality-gate-strip__item--warning" : "quality-gate-strip__item"}>
          覆盖率 {verification?.coverage ?? 0}%
        </span>
      </div>
      <Collapse
        className="patch-disclosure"
        defaultActiveKey={[]}
        items={[
          {
            key: "checklist",
            label: checksRequiringReview ? `${passedChecks} 项检查通过 · ${checksRequiringReview} 项需要复核` : `${passedChecks} 项检查通过`,
            children: (
              <ul className="review-check-list">
                {checklist.length ? checklist.map((item) => <ChecklistItem content={item} key={item} />) : <li className="patch-empty-row">等待 PR 助手生成审查清单。</li>}
                {hasQualityWarning ? <ChecklistItem content={`覆盖率仍为 ${verification?.coverage ?? 0}%`} warning /> : null}
              </ul>
            ),
          },
          {
            key: "risk",
            label: riskSummary,
            children: (
              <div className="risk-summary-flow">
                <p>{verification ? `Lint ${formatRuntimeStatusValue(verification.lint)} · 单测 ${formatRuntimeStatusValue(verification.unitTests)}` : "等待验证器输出 Lint / 单测 / 风险摘要。"}</p>
                <p>{verification ? `覆盖率 ${verification.coverage}% · ${verification.testSuites.length} 个套件` : "覆盖率等待中"}</p>
              </div>
            ),
          },
        ]}
      />
    </section>
  );

  return (
    <section className="patch-workspace">
      <Tabs
        className="patch-workspace__tabs"
        items={[
          { key: "overview", label: "变更概览", children: overviewPanel },
          { key: "verification", label: "质量门禁", children: verificationPanel },
        ]}
      />
    </section>
  );
}

function RuntimeStateBanner({
  step,
  status,
}: {
  step: StepRun;
  status: RuntimeStatus;
}) {
  const copy = runtimeStateCopy[status];
  const lastLog = step.logs.at(-1);
  const stageLabel = formatStepLabel(step.label);
  const agentLabel = formatAgentName(step.agent);
  const statusLine = stageLabel === agentLabel
    ? `${stageLabel} · ${runtimeStatusLabels[status]}`
    : `${stageLabel} · ${agentLabel} · ${runtimeStatusLabels[status]}`;

  return (
    <section className={`runtime-state-banner runtime-state-banner--${status}`}>
      <div>
        <span>{statusLine}</span>
        <h2>{copy.title}</h2>
        <p>{status === "failed" && lastLog ? `原因：${lastLog}` : copy.description}</p>
      </div>
    </section>
  );
}

function OutputWorkspace({
  step,
  workspaceView,
  onWorkspaceViewChange,
  onRestore,
  extraTabs = [],
  summaryChildren,
  summaryLabel = "结构化结果",
  compact = false,
}: {
  step: StepRun;
  workspaceView: WorkspaceView;
  onWorkspaceViewChange: (value: WorkspaceView) => void;
  onRestore?: (snapshotId: string) => void;
  extraTabs?: Array<{ key: string; label: ReactNode; children: ReactNode }>;
  summaryChildren?: ReactNode;
  summaryLabel?: ReactNode;
  compact?: boolean;
}) {
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const historyItems = (step.history ?? []).slice().reverse();

  function renderSnapshotPreview(snapshot: StepRun["history"][number]) {
    const snapshotStep: StepRun = {
      ...step,
      status: "success",
      output: snapshot.output,
      logs: snapshot.logs,
      interventions: snapshot.interventions,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
    };

    return (
      <div className="step-history-item__preview">
        {renderStepSummary(snapshotStep)}
      </div>
    );
  }

  async function doRestore(snapshotId: string) {
    if (!onRestore || restoringId) return;
    Modal.confirm({
      title: "还原到此版本？",
      content: "还原后，当前阶段将恢复到该历史输出，该阶段之后的所有阶段会被回滚为待重新生成，后续阶段需要基于还原后的结果重新推进。",
      okText: "确认还原",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        setRestoringId(snapshotId);
        try {
          await onRestore(snapshotId);
          message.success("已还原到历史版本，后续阶段已重置，请重新审核后继续推进");
          onWorkspaceViewChange("summary");
        } catch {
          message.error("还原历史版本失败");
        } finally {
          setRestoringId(null);
        }
      },
    });
  }

  const tabs = [
    { key: "summary", label: summaryLabel, children: summaryChildren ?? renderStepSummary(step) },
    ...extraTabs,
    ...(historyItems.length > 0 ? [{
      key: "history",
      label: `历史版本 (${historyItems.length})`,
      children: (
        <div className="step-history-list">
          {historyItems.map((snapshot) => (
            <div key={snapshot.id} className="step-history-item">
              <div className="step-history-item__header">
                <div className="step-history-item__meta">
                  <Tag color={snapshot.reason === "replay" ? "purple" : "blue"} variant="outlined">{snapshot.reason === "replay" ? "重放前状态" : "重新生成前状态"}</Tag>
                  <small>{new Date(snapshot.createdAt).toLocaleString()}</small>
                </div>
                {onRestore ? (
                  <Button size="small" loading={restoringId === snapshot.id} onClick={() => doRestore(snapshot.id)}>还原此版本</Button>
                ) : null}
              </div>
              <p className="step-history-item__summary">
                {onRestore
                  ? "这是重放或重新生成之前保存的完整结构化结果。确认内容后再还原。"
                  : "这是重放或重新生成之前保存的完整结构化结果，可用于对比。"}
              </p>
              {renderSnapshotPreview(snapshot)}
            </div>
          ))}
        </div>
      ),
    }] : []),
  ];

  return (
    <section className={`runtime-output-workspace ${compact ? "runtime-output-workspace--compact" : ""}`}>
      <Tabs
        activeKey={tabs.some((item) => item.key === workspaceView) ? workspaceView : "summary"}
        onChange={(key) => onWorkspaceViewChange(key as WorkspaceView)}
        items={tabs}
      />
    </section>
  );
}

function PullRequestExecutionWorkspace({
  draft,
  onDraftChange,
  output,
  editable = false,
}: {
  draft: PullRequestDraft;
  onDraftChange: (value: PullRequestDraft) => void;
  output?: PullRequestResult;
  editable?: boolean;
}) {
  return (
    <section className="pr-execution-workspace">
      {editable && (
        <div className="pr-execution-workspace__grid">
          <label>
            <span>分支名</span>
            <Input
              value={draft.branch}
              onChange={(event) => onDraftChange({ ...draft, branch: event.target.value })}
              placeholder="feature/article-word-count"
            />
          </label>
          <label>
            <span>Commit 信息</span>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              value={draft.commitMessage}
              onChange={(event) => onDraftChange({ ...draft, commitMessage: event.target.value })}
              placeholder="描述这次提交的改动"
            />
          </label>
        </div>
      )}
      {output ? (
        <div className="pr-execution-workspace__result">
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            <div>
              <Tag color={output.pushed ? "success" : "default"}>{output.pushed ? "已推送" : "未推送"}</Tag>
              <Tag>{output.status}</Tag>
            </div>
            <SurfaceCard title="分支" tone="muted">{output.branch ?? draft.branch}</SurfaceCard>
            <SurfaceCard title="Commit" tone="muted">{output.commitMessage ?? draft.commitMessage}</SurfaceCard>
            {output.url && output.url !== "pending://pull-request" ? (
              <SurfaceCard title="PR" tone="accent">
                <a href={output.url} target="_blank" rel="noopener noreferrer">
                  {output.prNumber ? `#${output.prNumber}` : "View PR"} — {output.url}
                </a>
              </SurfaceCard>
            ) : null}
            {(output as { commitSha?: string }).commitSha && (
              <SurfaceCard title="Commit SHA" tone="muted">{(output as { commitSha?: string }).commitSha}</SurfaceCard>
            )}
            {output.checklist?.length > 0 && (
              <SurfaceCard title="Checklist" tone="muted">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {output.checklist.map((item, i) => <li key={i} style={{ fontSize: 12 }}>{item}</li>)}
                </ul>
              </SurfaceCard>
            )}
          </Space>
        </div>
      ) : (
        !editable && <Text type="secondary">PR 尚未生成，请先确认分支名和 commit message</Text>
      )}
    </section>
  );
}

function StateDrivenWorkspace({
  step,
  status,
  messages,
  draft,
  running,
  workspaceView,
  repoResult,
  verification,
  pullRequestDraft,
  onDraftChange,
  onPullRequestDraftChange,
  onInterventionSubmit,
  onInterventionMessage,
  onPrimaryAction,
  onSecondaryAction,
  onRestore,
  onFeedbackChange,
  onContinueCueChange,
  submitRef,
  onWorkspaceViewChange,
  hasPendingFeedback,
}: {
  hasPendingFeedback?: boolean;
  step: StepRun;
  status: RuntimeStatus;
  messages: InterventionMessage[];
  draft: string;
  running: boolean;
  workspaceView: WorkspaceView;
  repoResult?: RepoWriteResult;
  verification?: VerificationResult;
  pullRequestDraft?: PullRequestDraft;
  onDraftChange: (value: string) => void;
  onPullRequestDraftChange?: (value: PullRequestDraft) => void;
  onInterventionSubmit: (event: FormEvent) => void;
  onInterventionMessage: (message: string) => void;
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
  onRestore?: (snapshotId: string) => void;
  onWorkspaceViewChange: (value: WorkspaceView) => void;
  onFeedbackChange?: (hasPending: boolean) => void;
  onContinueCueChange?: (ready: boolean) => void;
  submitRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const chat = (
    <StepChatThread
      draft={draft}
      messages={messages}
      onDraftChange={onDraftChange}
      onSubmit={onInterventionSubmit}
      running={running}
      step={step}
    />
  );
  const output = (
    <OutputWorkspace
      onRestore={onRestore}
      onWorkspaceViewChange={onWorkspaceViewChange}
      step={step}
      workspaceView={workspaceView}
    />
  );

  const prOutput = step.id === "pull_request" ? step.output as PullRequestResult | undefined : undefined;
  const prEditor = step.id === "pull_request" && pullRequestDraft && onPullRequestDraftChange ? (
    <PullRequestExecutionWorkspace
      draft={pullRequestDraft}
      onDraftChange={onPullRequestDraftChange}
      output={prOutput}
    />
  ) : null;

  if (status === "blocked") {
    if (step.id === "repo_write") {
      return (
        <div className="runtime-state-layout runtime-state-layout--blocked runtime-state-layout--patch-review">
          <RuntimeStateBanner status={status} step={step} />
          <OutputWorkspace
            onRestore={onRestore}
            onWorkspaceViewChange={onWorkspaceViewChange}
            step={step}
            summaryChildren={(
              <div className="runtime-summary-decision-flow">
                <PatchReviewWorkspace repoResult={repoResult} step={step} verification={verification} />
                <StepInterventionWorkspace
                  messages={messages}
                  onSubmitMessage={onInterventionMessage}
                  running={running}
                  showReview={false}
                  step={step}
                  onFeedbackChange={onFeedbackChange}
                  onContinueCueChange={onContinueCueChange}
                  submitRef={submitRef}
                />
              </div>
            )}
            summaryLabel="变更审查"
            workspaceView={workspaceView}
          />
        </div>
      );
    }

    return (
      <div className="runtime-state-layout runtime-state-layout--blocked">
        <RuntimeStateBanner status={status} step={step} />
        {step.id === "pull_request" && pullRequestDraft && onPullRequestDraftChange ? (
          <PullRequestExecutionWorkspace
            draft={pullRequestDraft}
            onDraftChange={onPullRequestDraftChange}
            output={step.output as PullRequestResult | undefined}
            editable
          />
        ) : (
        <OutputWorkspace
          onRestore={onRestore}
          onWorkspaceViewChange={onWorkspaceViewChange}
          step={step}
          summaryChildren={(
            <StepInterventionWorkspace
              messages={messages}
              onSubmitMessage={onInterventionMessage}
              running={running}
              step={step}
              onFeedbackChange={onFeedbackChange}
              onContinueCueChange={onContinueCueChange}
              submitRef={submitRef}
            />
          )}
          workspaceView={workspaceView}
        />
        )}
      </div>
    );
  }

  if (status === "running") {
    return (
      <div className="runtime-state-layout runtime-state-layout--running">
        <RuntimeStateBanner status={status} step={step} />
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="runtime-state-layout runtime-state-layout--failed">
        <RuntimeStateBanner status={status} step={step} />
      </div>
    );
  }

  if (status === "success") {
    const interventionCount = messages.filter((message) => message.stepId === step.id).length;
    const rawOutputDisclosure = (
      <Collapse
        className="raw-output-disclosure"
        items={[{
          key: "raw-output",
          label: "结构化结果 / 历史版本",
          children: (
            <OutputWorkspace
              compact
              onWorkspaceViewChange={onWorkspaceViewChange}
              step={step}
              workspaceView={workspaceView}
            />
          ),
        }]}
      />
    );
    const interventionDisclosure = (
      <Collapse
        className="completed-intervention"
        items={[{
          key: "intervention",
          label: `反馈历史 · ${interventionCount} 条消息`,
          children: (
            <StepChatThread
              composerEnabled={false}
              density="minimized"
              draft={draft}
              messages={messages}
              onDraftChange={onDraftChange}
              onSubmit={onInterventionSubmit}
              running={running}
              step={step}
            />
          ),
        }]}
      />
    );

    if (isPatchReviewStep(step)) {
      return (
        <div className="runtime-state-layout runtime-state-layout--success runtime-state-layout--patch-review">
          <RuntimeStateBanner status={status} step={step} />
          <PatchReviewWorkspace repoResult={repoResult} step={step} verification={verification} />
          {rawOutputDisclosure}
          {interventionDisclosure}
        </div>
      );
    }

    if (step.id === "pull_request" && pullRequestDraft) {
      return (
        <div className="runtime-state-layout runtime-state-layout--success">
          <RuntimeStateBanner status={status} step={step} />
          <PullRequestExecutionWorkspace
            draft={pullRequestDraft}
            onDraftChange={onPullRequestDraftChange ?? (() => {})}
            output={step.output as PullRequestResult | undefined}
          />
          {interventionDisclosure}
        </div>
      );
    }

    return (
      <div className="runtime-state-layout runtime-state-layout--success">
        <RuntimeStateBanner status={status} step={step} />
        {output}
        {interventionDisclosure}
      </div>
    );
  }

  return (
    <div className="runtime-state-layout runtime-state-layout--waiting">
      <RuntimeStateBanner status={status} step={step} />
      {prEditor ?? output}
      {prEditor ? output : null}
      {chat}
    </div>
  );
}

function SkillBadge({ run, step }: { run: WorkflowRun; step: StepRun }) {
  // 优先从 run 级别读取（API 响应已注入），fallback 到 step output 中的 trace
  const runReason = run.skillMatchReason;
  const trace = (step.output as Record<string, unknown> | undefined)?.runtimeTrace as
    | {
        selectedSkillId?: string;
        skillMatchReason?: {
          skillId: string;
          skillName: string;
          matchedPattern: string;
          matchedScope?: string;
          hitKeywords: string[];
          hitFileGlobs?: string[];
          hitFiles?: string[];
          hitRouteHints?: string[];
          score?: number;
        };
      }
    | undefined;
  const skillId = run.selectedSkillId ?? trace?.selectedSkillId;
  const reason = runReason ?? trace?.skillMatchReason;
  if (!skillId) return null;

  const tooltipLines: string[] = [];
  if (reason) {
    tooltipLines.push(`Skill: ${reason.skillName}`);
    tooltipLines.push(`命中 Pattern: ${reason.matchedPattern}`);
    if (reason.matchedScope) tooltipLines.push(`Scope: ${reason.matchedScope}`);
    if (reason.hitKeywords.length) tooltipLines.push(`命中关键词: ${reason.hitKeywords.join(", ")}`);
    if (reason.hitFileGlobs?.length) tooltipLines.push(`命中文件规则: ${reason.hitFileGlobs.join(", ")}`);
    if (reason.hitFiles?.length) tooltipLines.push(`命中文件: ${reason.hitFiles.slice(0, 5).join(", ")}${(reason.hitFiles.length > 5) ? " …" : ""}`);
    if (reason.hitRouteHints?.length) tooltipLines.push(`命中路由提示: ${reason.hitRouteHints.join(", ")}`);
    if (reason.score != null) tooltipLines.push(`匹配分数: ${reason.score}`);
  }

  return (
    <ContextSection title="命中 Skill">
      <Tooltip title={tooltipLines.length ? <div>{tooltipLines.map((l, i) => <div key={i}>{l}</div>)}</div> : undefined}>
        <Tag color="purple">{reason?.skillName ?? skillId}</Tag>
      </Tooltip>
    </ContextSection>
  );
}

function DynamicSidePanel({
  activeStep,
  run,
  requirement,
  repository,
  repoResult,
  verification,
  metrics,
  agentMetrics,
}: {
  activeStep: StepRun;
  run: WorkflowRun;
  requirement: RequirementDraft;
  repository: RepositorySnapshot;
  repoResult?: RepoWriteResult;
  verification?: VerificationResult;
  metrics: ReturnType<typeof summarizeMetrics>;
  agentMetrics: AgentMetric[];
}) {
  if (activeStep.id === "clarification" || activeStep.id === "solution_design" || activeStep.id === "requirement_intake") {
    return (
      <Card className="runtime-panel runtime-context-panel" title="运行上下文" bordered={false}>
        <SkillBadge run={run} step={activeStep} />
        <ContextSection title="需求与确认">
          <Typography.Paragraph>{requirement.rawText}</Typography.Paragraph>
        </ContextSection>
        <ContextSection title="仓库">
          <div className="workbench__meta">
            <span>{repository.name}</span>
            <span>{repository.branch}</span>
          </div>
        </ContextSection>
        <ContextSection title="范围标签">
          <Space wrap>
            <Tag color="blue" variant="outlined">{requirement.pattern}</Tag>
            <Tag variant="outlined">{repository.name}</Tag>
            <Tag variant="outlined">{formatAgentName(activeStep.agent)}</Tag>
          </Space>
        </ContextSection>
      </Card>
    );
  }

  if (activeStep.id === "module_mapping" || activeStep.id === "code_generation") {
    const mapping = activeStep.output as ModuleMapping | CodeGenerationPlan | undefined;
    const files = activeStep.id === "module_mapping" && mapping && "touchedModules" in mapping
      ? mapping.touchedModules.flatMap((item) => item.files)
      : activeStep.id === "code_generation" && mapping && "tasks" in mapping
        ? mapping.tasks.flatMap((task) => task.files)
        : [];
    const modules = activeStep.id === "module_mapping" && mapping && "touchedModules" in mapping
      ? mapping.touchedModules.map((item) => item.name)
      : [];
    return (
      <Card className="runtime-panel runtime-context-panel" title="运行上下文" bordered={false}>
        <SkillBadge run={run} step={activeStep} />
        <ContextSection title="上下文定位">
          <InlineList items={files} empty="等待 AI 定位文件后展示代码上下文。" />
        </ContextSection>
        <ContextSection title="候选模块">
          <InlineList items={modules} empty="候选模块会在上下文定位完成后出现。" />
        </ContextSection>
        <ContextSection title="搜索结果">
          <span className="runtime-muted">预留给 SSE / 仓库搜索事件流。</span>
        </ContextSection>
      </Card>
    );
  }

  if (activeStep.id === "repo_write") {
    return (
      <Card className="runtime-panel runtime-context-panel" title="运行上下文" bordered={false}>
        <SkillBadge run={run} step={activeStep} />
        <ContextSection title="代码生成 / 写入">
          <RepositoryChanges repository={repository} result={repoResult} />
        </ContextSection>
        <ContextSection title="补丁摘要">
          <InlineList
            items={(repoResult?.filesChanged ?? []).map((file) => `${formatChangeType(file.changeType)}：${file.path}（+${file.additions} / -${file.deletions}）`)}
            empty="等待生成代码后展示补丁摘要。"
          />
        </ContextSection>
      </Card>
    );
  }

  if (activeStep.id === "verification") {
    return (
      <Card className="runtime-panel runtime-context-panel" title="运行上下文" bordered={false}>
        <SkillBadge run={run} step={activeStep} />
        <ContextSection title="验证器 / 质量门">
          <TestResultPanel result={verification} />
        </ContextSection>
        <ContextSection title="风险摘要">
          <InlineList
            items={verification ? [`Lint ${formatRuntimeStatusValue(verification.lint)}`, `单测 ${formatRuntimeStatusValue(verification.unitTests)}`, `覆盖率 ${verification.coverage}%`] : []}
            empty="等待质量门产出风险摘要。"
          />
        </ContextSection>
      </Card>
    );
  }

  if (activeStep.id === "pull_request") {
    const pr = activeStep.output as PullRequestResult | undefined;
    const files = getChangedFileEntries(activeStep, repoResult);
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return (
      <Card className="runtime-panel runtime-context-panel" title="运行上下文" bordered={false}>
        <SkillBadge run={run} step={activeStep} />
        <ContextSection title="PR 状态">
          <div className="runtime-sidecar-status">
            <Tag color={pr?.status === "ready" ? "success" : "blue"} variant="outlined">{formatRuntimeStatusValue(pr?.status)}</Tag>
            <Typography.Text ellipsis>{pr?.title ?? "PR 摘要等待生成"}</Typography.Text>
            <span>{pr?.url ?? "等待 PR 链接"}</span>
          </div>
        </ContextSection>
        <ContextSection title="补丁元信息">
          <div className="runtime-sidecar-metadata">
            <span>{files.length} 个文件</span>
            <span className="git-stat git-stat--add">+{additions}</span>
            <span className="git-stat git-stat--del">-{deletions}</span>
          </div>
        </ContextSection>
        <ContextSection title="质量门摘要">
          <div className="runtime-sidecar-quality">
            <Tag color={verification?.lint === "failed" ? "error" : "success"} variant="outlined">Lint {formatRuntimeStatusValue(verification?.lint)}</Tag>
            <Tag color={verification?.unitTests === "failed" ? "error" : "success"} variant="outlined">单测 {formatRuntimeStatusValue(verification?.unitTests)}</Tag>
            <Tag color={(verification?.coverage ?? 0) <= 0 ? "warning" : "success"} variant="outlined">覆盖率 {verification?.coverage ?? 0}%</Tag>
          </div>
        </ContextSection>
      </Card>
    );
  }

  return (
    <Card className="runtime-panel runtime-telemetry-panel" title="执行遥测" bordered={false}>
      <SkillBadge run={run} step={activeStep} />
      <div className="runtime-telemetry-grid">
        <Statistic title="AI 调用" value={metrics.calls} />
        <Statistic title="上下文 Token" value={formatTokenCount(metrics.inputTokens + metrics.outputTokens)} />
        <Statistic title="耗时" value={formatDuration(metrics.latencyMs)} />
        <Statistic title="成本" value={formatCurrency(metrics.estimatedCost)} />
      </div>
      <div className="runtime-agent-list">
        {agentMetrics.map((metric) => (
          <article className="runtime-agent-row" key={metric.agent}>
            <strong>{metric.agent}</strong>
            <span>{formatTokenCount(metric.inputTokens + metric.outputTokens)} Token · {formatDuration(metric.latencyMs)} · {metric.calls} 次调用</span>
          </article>
        ))}
      </div>
    </Card>
  );
}

function ExecutionFeed({ events }: { events: RuntimeEvent[] }) {
  const feedRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  return (
    <Card className="runtime-panel execution-feed" title="运行日志" bordered={false}>
      {events.length === 0 ? <p className="runtime-muted">等待 AI 运行日志。后续可接入 SSE 或任务事件流。</p> : null}
      <ul ref={feedRef}>
        {events.map((event, index) => (
          <li className={index === events.length - 1 || event.live ? "execution-feed__event--current" : ""} key={event.id}>
            <time>{event.time ? new Date(event.time).toLocaleTimeString() : "--:--:--"}</time>
            <strong>{formatRuntimeEventTitle(event.title)}</strong>
            <span>{event.detail}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function WorkbenchPage() {
  const { projectId, runId } = useParams();
  const [run, setRun] = useState<WorkflowRun | null>(null);

  /** 单调更新 run：仅当快照 updatedAt 比当前新才覆盖，防止旧 GET 覆盖新 SSE */
  function applyRunSnapshot(next: WorkflowRun) {
    setRun((prev) => {
      if (!prev) return next;
      if (!prev.updatedAt || !next.updatedAt) return next;
      return next.updatedAt >= prev.updatedAt ? next : prev;
    });
  }

  const [projectBreadcrumb, setProjectBreadcrumb] = useState<{ id: string; name?: string } | undefined>(
    projectId ? { id: projectId, name: "正在加载项目..." } : undefined,
  );
  const [agentMetrics, setAgentMetrics] = useState<AgentMetric[]>([]);
  const [repository, setRepository] = useState<RepositorySnapshot | null>(null);
  const [apiStatus, setApiStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("summary");
  const [chatDraft, setChatDraft] = useState("");
  const [pullRequestDraft, setPullRequestDraft] = useState<PullRequestDraft | null>(null);
  const [hasQuestionFeedback, setHasQuestionFeedback] = useState(false);
  const [continueCueReady, setContinueCueReady] = useState(false);
  const structuredSubmitRef = useRef<(() => void) | null>(null);

  /** 统一提交所有待提交反馈（聊天框 + 结构化） */
  async function submitPendingFeedback() {
    const chat = chatDraft.trim();
    const targetId = effectiveStep?.id ?? activeStep?.id;
    structuredSubmitRef.current?.();
    if (chat && targetId) {
      await submitInterventionMessage(chat, targetId);
      setChatDraft("");
    }
  }

  /** 检查是否存在于聊天框/深层反馈表单中未提交的反馈草稿 */
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const activeStep = run ? getActiveStep(run) : null;
  const displaySteps = useMemo(() => run ? getDisplaySteps(run.steps) : [], [run]);
  const displayActiveStep = useMemo(() => run ? getDisplayActiveStep(run, displaySteps) : null, [run, displaySteps]);
  const isCodeDelivery = displayActiveStep?.id === "code_delivery" || activeStep?.id === "code_generation";
  // 当处于 code_delivery 显示阶段时，effectiveStep 用于反馈/确认的目标后端 step
  const codegenStep = run?.steps.find((s) => s.id === "code_generation");
  const repoWriteStep = run?.steps.find((s) => s.id === "repo_write");
  const effectiveStep = isCodeDelivery
    ? (getCodeDeliveryEffectiveStep(codegenStep, repoWriteStep) ?? activeStep)
    : activeStep;
  // 重放 code_delivery 永远从 code_generation 开始
  const replayTargetStep = isCodeDelivery ? codegenStep ?? activeStep : activeStep;
  const activeRuntimeStatus: RuntimeStatus = displayActiveStep
    ? (mapRuntimeStatus(displayActiveStep.sourceSteps[0]) === "blocked" || mapRuntimeStatus(displayActiveStep.sourceSteps[1] ?? displayActiveStep.sourceSteps[0]) === "blocked" ? "blocked"
      : displayActiveStep.status === "failed" ? "failed"
      : displayActiveStep.status === "running" ? "running"
      : displayActiveStep.status === "success" ? "success"
      : "waiting")
    : "waiting";
  const hasPendingFeedback = activeRuntimeStatus === "blocked" && (chatDraft.trim() !== "" || hasQuestionFeedback);
  const shouldCueContinue =
    Boolean(activeStep) &&
    ["blocked", "waiting", "paused"].includes(activeRuntimeStatus) &&
    (activeRuntimeStatus === "blocked" && activeStep?.id === "clarification" ? continueCueReady : true);
  const metrics = summarizeMetrics(agentMetrics);
  const legacyRepoResult = run ? getStepOutput<RepoWriteResult>(run.steps, "repo_write") : undefined;
  const repoResult = legacyRepoResult ?? getCodeGenerationRepoResult(codegenStep);
  const verification = run ? getStepOutput<VerificationResult>(run.steps, "verification") : undefined;
  const requirement = run && activeStep ? (getStepOutput<RequirementDraft>(run.steps, "requirement_intake") ?? activeStep.output) as RequirementDraft : null;
  const executionEvents = useMemo(() => {
    const derivedEvents = run ? buildExecutionEvents(run.steps, activeStep, activeRuntimeStatus) : [];
    return [...derivedEvents, ...runtimeEvents].slice(-24);
  }, [run, activeStep, activeRuntimeStatus, runtimeEvents]);

  function appendRuntimeEvents(step: StepRun, titles: string[]) {
    const timestamp = new Date().toISOString();
    setRuntimeEvents((current) => [
      ...current,
      ...titles.map((title, index) => ({
        id: `${step.id}-${Date.now()}-${index}`,
        time: timestamp,
        title,
        detail: step.label,
        live: true,
      })),
    ].slice(-16));
  }

  function getRunOptionsForStep(stepId: WorkflowStepId): WorkflowStepRunOptions | undefined {
    if (stepId !== "pull_request" || !pullRequestDraft) return undefined;
    return {
      pullRequest: {
        branch: pullRequestDraft.branch,
        commitMessage: pullRequestDraft.commitMessage,
      },
    };
  }

  useEffect(() => {
    if (!run) {
      setPullRequestDraft(null);
      return;
    }

    setPullRequestDraft((current) => current ?? getPullRequestDraftFromRun(run));
  }, [run?.id]);

  useEffect(() => {
    if (!run) return;
    const output = getStepOutput<PullRequestResult>(run.steps, "pull_request");
    if (!output?.branch && !output?.commitMessage) return;
    setPullRequestDraft({
      branch: output.branch ?? deriveDefaultPullRequestBranch(run),
      commitMessage: output.commitMessage ?? deriveDefaultCommitMessage(run),
    });
  }, [run?.steps]);

  useEffect(() => {
    let ignore = false;

    async function loadLiveData() {
      try {
        const [workflowRun, nextMetrics, nextRepository] = await Promise.all([
          getWorkflowRun(runId!),
          getAgentMetrics(),
          getRepositorySnapshot(),
        ]);

        const activeProjectId = projectId ?? workflowRun.projectId;
        if (activeProjectId) {
          openWorkspace(activeProjectId)
            .then(async (workspaceContext) => {
              saveWorkspace(workspaceContext);
              const projectWorkspace = await getProjectWorkspace(activeProjectId).catch(() => undefined);

              if (!ignore) {
                setProjectBreadcrumb({
                  id: activeProjectId,
                  name: projectWorkspace?.name ?? workspaceContext.repoName,
                });
              }
            })
            .catch(() => {
              if (!ignore) {
                setProjectBreadcrumb({ id: activeProjectId, name: "正在加载项目..." });
              }
            });
        }

        if (!ignore) {
          applyRunSnapshot(workflowRun);
          setAgentMetrics(nextMetrics);
          setRepository(nextRepository);
          setApiStatus("live");
          setErrorMessage("");
        }
      } catch (error) {
        if (!ignore) {
          setRun(null);
          setAgentMetrics([]);
          setRepository(null);
          setErrorMessage(error instanceof Error ? error.message : "后端 API 不可达，请确认后端服务已启动。");
        }
      }
    }

    loadLiveData();
    return () => {
      ignore = true;
    };
  }, [projectId, runId]);

  // SSE：订阅当前 run 的增量事件，后端 mutate 后立即同步到 UI，无需轮询。
  useEffect(() => {
    if (!runId) {
      return undefined;
    }

    const dispose = subscribeWorkflowRun(runId, {
      onUpdate: (latest) => {
        applyRunSnapshot(latest);
        setApiStatus("live");
      },
      onStepEvent: () => {
        getAgentMetrics().then(setAgentMetrics).catch(() => undefined);
        getWorkflowRun(runId!).then(applyRunSnapshot).catch(() => undefined);
      },
      onMetrics: setAgentMetrics,
      onError: () => {
        // SSE 断开时不影响主流程；onUpdate 仍会在重连后重新推送。
      },
    });

    return dispose;
  }, [runId]);

  async function completeCurrentStep() {
    if (!run || !activeStep) return;
    const targetStep = effectiveStep ?? activeStep;

    // pull_request always uses regenerate: Phase 1 runs → draft (waiting-human),
    // confirm triggers Phase 2 (git + push + create PR) via runWorkflowStep
    const action = targetStep.id === "pull_request"
      ? "run"
      : targetStep.status === "waiting-human" ? "confirm" : "run";

    try {
      const nextRun = action === "confirm"
        ? await confirmWorkflowStep(run.id, targetStep.id)
        : await runWorkflowStep(run.id, targetStep.id, getRunOptionsForStep(targetStep.id));
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "运行阶段失败，请确认后端服务可达。");
    }
  }

  async function handleReplay(stepId: WorkflowStepId) {
    if (!run) return;
    if (!canReplayStep(stepId)) return;

    try {
      setRun(await replayWorkflowFrom(run.id, stepId));
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "重放流程失败，请确认后端服务可达。");
    }
  }

  async function handleStepContinue(stepId: WorkflowStepId) {
    if (!run || !activeStep) return;
    const step = run.steps.find((item) => item.id === stepId);
    if (!step) return;
    const stepStatus = step.id === activeStep.id ? activeRuntimeStatus : mapRuntimeStatus(step);

    if (stepStatus === "success") {
      const index = run.steps.findIndex((item) => item.id === stepId);
      const next = run.steps[index + 1];
      if (next && next.status !== "success") {
        setRun((currentRun) => currentRun ? ({ ...currentRun, activeStepId: next.id }) : currentRun);
      }
      return;
    }

    if (step.id === activeStep.id && hasPendingFeedback) {
      await submitPendingFeedback();
      return;
    }

    try {
      const nextRun = step.status === "waiting-human"
        ? await confirmWorkflowStep(run.id, step.id)
        : await runWorkflowStep(run.id, step.id, getRunOptionsForStep(step.id));
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "运行阶段失败，请确认后端服务可达。");
    }
  }

  async function handleRestore(snapshotId: string) {
    if (!run || !activeStep) return;

    try {
      const nextRun = await restoreStepSnapshot(run.id, activeStep.id, snapshotId, { replayDownstream: true });
      setRun(nextRun);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "还原历史版本失败。");
      throw error;
    }
  }

  async function submitInterventionMessage(message: string, targetStepId?: WorkflowStepId) {
    if (!run || !message.trim()) return;
    const target = targetStepId ?? activeStep?.id;
    if (!target) return;

    const nextMessage = message.trim();
    const targetStep = run.steps.find((s) => s.id === target);
    const localUserMessage: InterventionMessage = {
      id: `${target}-local-user-${Date.now()}`,
      stepId: target,
      role: "user",
      content: nextMessage,
      createdAt: new Date().toISOString(),
    };
    setChatDraft("");

    // Optimistic update
    const previousRun = run;
    setRun({
      ...run,
      steps: run.steps.map((step) =>
        step.id === target
          ? { ...step, interventions: [...(step.interventions ?? []), localUserMessage] }
          : step,
      ),
    });
    appendRuntimeEvents(targetStep ?? run.steps[0], ["用户已提交反馈", "AI 正在处理反馈", `${targetStep?.agent ?? "Agent"} started`]);

    try {
      const nextRun = await createStepIntervention(run.id, target, nextMessage);
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      appendRuntimeEvents(targetStep ?? run.steps[0], ["结构化输出已更新", "待审核"]);
    } catch (error) {
      setRun(previousRun);
      setErrorMessage(error instanceof Error ? error.message : "AI 重新生成失败，请确认后端服务可达。");
    }
  }

  async function handleInterventionSubmit(event: FormEvent) {
    event.preventDefault();
    await submitInterventionMessage(chatDraft);
  }

  if (apiStatus === "connecting") {
    return (
      <main className="workbench runtime-workbench">
        <AppBreadcrumb
          project={projectBreadcrumb}
          workflow={runId ? { id: runId, title: "正在加载工作流..." } : undefined}
        />
        <PageSkeleton variant="workbench" />
      </main>
    );
  }

  if (apiStatus === "error" || !run || !activeStep || !requirement || !repository) {
    return (
      <main className="workbench runtime-workbench">
        <AppBreadcrumb
          project={projectBreadcrumb}
          workflow={runId ? { id: runId, title: run?.title ?? "正在加载工作流..." } : undefined}
        />
        <Alert message="无法加载真实交付链路" description={errorMessage || "请确认后端服务运行在 3001，并且前端 /api 代理可访问后端。"} type="error" showIcon />
      </main>
    );
  }

  return (
    <main className="workbench runtime-workbench">
      <AppBreadcrumb
        project={projectBreadcrumb ?? (run.projectId ? { id: run.projectId, name: "正在加载项目..." } : undefined)}
        workflow={{ id: run.id, title: run.title || requirement.title }}
      />
      <section className="runtime-run-header">
        <div>
          <span className="workbench__eyebrow">交付任务</span>
          <h1>{run.title || requirement.title}</h1>
          <p>{requirement.rawText}</p>
          <div className="workbench__meta runtime-chip-row">
            {projectBreadcrumb?.name ? <span className="runtime-chip">{projectBreadcrumb.name}</span> : null}
            <span className="runtime-chip">{requirement.pattern}</span>
            <span className="runtime-chip">{repository.name}</span>
            <span className="runtime-chip">{runtimeStatusLabels[activeRuntimeStatus]}</span>
          </div>
        </div>
        <div className="runtime-telemetry-strip runtime-chip-row" id="observability">
          <span className="runtime-chip"><strong>{metrics.calls}</strong> 次调用</span>
          <span className="runtime-chip"><strong>{formatTokenCount(metrics.inputTokens + metrics.outputTokens)}</strong> Token</span>
          <span className="runtime-chip"><strong>{formatDuration(metrics.latencyMs)}</strong></span>
        </div>
      </section>

      {errorMessage ? <Alert type="error" message={errorMessage} showIcon /> : null}

      <section className="runtime-progress-shell">
        <StepProgress
          activeStatus={activeRuntimeStatus}
          activeStepId={(displayActiveStep?.id ?? run.activeStepId) as WorkflowStepId}
          continueCueStepId={shouldCueContinue ? (displayActiveStep?.id ?? run.activeStepId) as WorkflowStepId : null}
          onContinue={(stepId) => handleStepContinue(resolveBackendStepId(stepId, displaySteps, "continue"))}
          onReplay={(stepId) => handleReplay(resolveBackendStepId(stepId, displaySteps, "replay"))}
          onSelect={(stepId: WorkflowStepId) => {
            const backendId = resolveBackendStepId(stepId, displaySteps, "select");
            setRun((currentRun) => currentRun ? ({ ...currentRun, activeStepId: backendId }) : currentRun);
          }}
          steps={displaySteps.map((ds) => ({
            id: ds.id as WorkflowStepId,
            label: ds.label,
            status: ds.status,
            agent: ds.sourceSteps[0]?.agent ?? "",
            sourceStepIds: ds.sourceStepIds,
          }))}
        />
      </section>

      <section className={`runtime-layout runtime-layout--focused runtime-layout--${activeRuntimeStatus}`} id="workflow">
        <section className="runtime-center" id="contract">
          <Card className={`runtime-panel runtime-step-workspace runtime-state--${activeRuntimeStatus}`} bordered={false}>
            {isCodeDelivery && codegenStep ? (
              <CodeDeliveryWorkspace
                codegenStep={codegenStep}
                repoWriteStep={repoWriteStep}
                repoResult={repoResult}
                status={activeRuntimeStatus}
                running={activeRuntimeStatus === "running"}
                onInterventionMessage={(msg) => submitInterventionMessage(msg, effectiveStep!.id)}
                draft={chatDraft}
                onDraftChange={setChatDraft}
              />
            ) : (
            <StateDrivenWorkspace
              draft={chatDraft}
              messages={activeStep.interventions ?? []}
              onDraftChange={setChatDraft}
              onInterventionMessage={submitInterventionMessage}
              onInterventionSubmit={handleInterventionSubmit}
              onPrimaryAction={
                activeRuntimeStatus === "success" ? () => handleReplay(activeStep.id)
                : hasPendingFeedback
                  ? submitPendingFeedback
                  : completeCurrentStep
              }
              onRestore={handleRestore}
              hasPendingFeedback={hasPendingFeedback}
              submitRef={structuredSubmitRef}
              onFeedbackChange={setHasQuestionFeedback}
              onContinueCueChange={setContinueCueReady}
              onSecondaryAction={
                hasPendingFeedback && chatDraft.trim()
                  ? completeCurrentStep
                  : activeRuntimeStatus === "blocked"
                    ? () => runWorkflowStep(run.id, activeStep.id, getRunOptionsForStep(activeStep.id)).then(setRun).catch(() => undefined)
                    : undefined
              }
              onWorkspaceViewChange={setWorkspaceView}
              onPullRequestDraftChange={setPullRequestDraft}
              pullRequestDraft={pullRequestDraft ?? undefined}
              repoResult={repoResult}
              running={activeRuntimeStatus === "running"}
              status={activeRuntimeStatus}
              step={activeStep}
              verification={verification}
              workspaceView={workspaceView}
            />
            )}
          </Card>
        </section>
      </section>
    </main>
  );
}
