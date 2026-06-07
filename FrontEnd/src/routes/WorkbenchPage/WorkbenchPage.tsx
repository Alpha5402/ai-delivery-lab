import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Alert, Button, Card, Collapse, Input, Modal, Progress, Space, Statistic, Tabs, Tag, Timeline, Tooltip, Typography, message } from "antd";
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
  const statusMessage = (() => {
    switch (step.status) {
      case "running":
        return `${formatStepLabel(step.label)} 正在生成结构化结果，请稍候。`;
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
      <SummaryCard title={step.status === "running" ? "生成中" : step.status === "failed" ? "执行失败" : "等待执行"}>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
          <SummaryCard title="可复用技能">
            <p>{mapping.reusableSkill}</p>
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
          files: task.files,
        })),
        ...derivedVerificationTasks
          .filter((task) => !explicitVerificationTasks.some((verificationTask) => verificationTask.id === task.id))
          .map((task) => ({
            id: `${task.id}-verification`,
            title: `覆盖「${task.title}」的关键验收场景`,
            files: task.files,
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
    case "pull_request": {
      const result = value as PullRequestResult;
      if (!result.title || !Array.isArray(result.checklist)) {
        return <EmptyStepSummary step={step} />;
      }
      return (
        <div className="step-summary">
          <SummaryCard title="PR">
            <p>{result.title}</p>
          </SummaryCard>
          <SummaryCard title="检查清单">
            <ul className="step-summary__list">
              {result.checklist.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </SummaryCard>
        </div>
      );
    }
  }
}


type RuntimeStatus = "waiting" | "running" | "blocked" | "success" | "failed" | "paused";
type RuntimeEvent = { id: string; time: string; title: string; detail: string; live?: boolean };
type ChatDensity = "primary" | "secondary" | "minimized";

function mapRuntimeStatus(step: StepRun): RuntimeStatus {
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
    "Codegen Skill": "准备修改",
    Verifier: "验证结果",
    "PR Assistant": "准备 PR",
  };
  if (/Writer$/i.test(value)) return "写入变更";
  return agentMap[value] ?? value;
}

function formatStepLabel(value: string) {
  const labelMap: Record<string, string> = {
    "PM 输入": "接收需求",
    "澄清 Agent": "确认需求",
    "方案 DSL": "生成方案",
    "模块定位": "定位代码",
    "代码计划": "准备修改",
    "写入仓库": "写入变更",
    "Lint / 单测": "验证结果",
    "提交 PR": "准备 PR",
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
    "Codegen Skill": "准备修改",
    Verifier: "验证结果",
    "PR Assistant": "准备 PR",
    Runtime: "AI",
    Trigger: "触发器",
    Step: "阶段",
  }).reduce((nextTitle, [source, target]) => nextTitle.replaceAll(source, target), title)
    .replace(/\b[A-Za-z]+\s+Writer\b/g, "写入变更")
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

function StepProgress({
  steps,
  activeStepId,
  activeStatus,
  continueCueStepId,
  onSelect,
  onReplay,
  onContinue,
}: {
  steps: StepRun[];
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
  onSubmitMessage,
  onFeedbackChange,
  onContinueCueChange,
  submitRef,
}: {
  step: StepRun;
  messages: InterventionMessage[];
  running: boolean;
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
  useEffect(() => { if (submitRef) submitRef.current = submitFeedback; }, [submitFeedback, submitRef]);
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
    })() : (
        <section className="clarification-review">
          {renderStepSummary(step)}
        </section>
      )}

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
  return ["repo_write", "verification", "pull_request"].includes(step.id);
}

function ChangedFileRow({ file }: { file: ChangedFileEntry }) {
  const { path } = file;
  const pathParts = splitFilePath(path);
  return (
    <Tooltip title={path}>
      <li className="changed-file-row">
        <Tag className="changed-file-row__type" variant="outlined">{getFileType(path)}</Tag>
        <span className="changed-file-row__identity">
          <Typography.Text className="changed-file-row__path" ellipsis>{pathParts.directory || "./"}</Typography.Text>
          <Typography.Text className="changed-file-row__name" ellipsis>{pathParts.filename}</Typography.Text>
        </span>
        <span className="changed-file-row__stats">
          <span className="git-stat git-stat--add">+{file.additions}</span>
          <span className="git-stat git-stat--del">-{file.deletions}</span>
        </span>
      </li>
    </Tooltip>
  );
}

function FileContentPreview({ content }: { content?: string }) {
  if (!content?.trim()) {
    return <p className="patch-file-preview__empty">当前结果没有提供内容预览；可在本地 git diff 中查看完整变更。</p>;
  }

  const lines = content.split(/\r?\n/);
  return (
    <div className="patch-file-preview" role="region" aria-label="文件内容预览">
      {lines.map((line, index) => (
        <div className="patch-file-preview__line" key={`${index}-${line}`}>
          <span>{index + 1}</span>
          <code>{line || " "}</code>
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
  const headline = step.id === "repo_write"
    ? "检查已写入的文件"
    : step.id === "verification"
      ? "检查验证结果"
      : "检查交付产出";
  const eyebrow = step.id === "repo_write" ? "写入变更" : "交付审阅";
  const checklist = step.id === "pull_request" && isRecord(step.output) && Array.isArray((step.output as PullRequestResult).checklist)
    ? (step.output as PullRequestResult).checklist
    : [
      "结构化输出已生成",
      files.length ? "变更文件已定位" : "等待定位变更文件",
      verification ? `质量门：Lint ${formatRuntimeStatusValue(verification.lint)}，单测 ${formatRuntimeStatusValue(verification.unitTests)}` : "等待质量门",
    ];
  const passedChecks = checklist.length;
  const riskSummary = verification && verification.lint === "passed" && verification.unitTests === "passed"
    ? "无关键风险"
    : verification
      ? "质量门需要复核"
      : "等待质量门";
  const hasQualityWarning = Boolean(verification && (verification.lint !== "passed" || verification.unitTests !== "passed" || (verification.coverage ?? 0) <= 0));
  const checksRequiringReview = hasQualityWarning ? 1 : 0;

  return (
    <section className="patch-workspace">
      <header>
        <span>{eyebrow}</span>
        <h3>{headline}</h3>
      </header>

      <section className="patch-section patch-section--overview">
        <div className="patch-section__title">
          <span>Git Review</span>
          <h4>变更概览</h4>
        </div>
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
              ghost
              items={[{
                key: "files",
                label: files.length ? `${files.length} 个变更文件` : "暂无文件变更",
                children: (
                  <ul className="changed-file-list">
                    {fileEntries.length ? fileEntries.map((file) => <ChangedFileRow file={file} key={file.path} />) : <li className="patch-empty-row">当前阶段尚未产生文件变更。</li>}
                  </ul>
                ),
              }]}
            />
          </article>
          <Collapse
            className="patch-disclosure patch-file-disclosure"
            defaultActiveKey={fileEntries.length ? [fileEntries[0].path] : []}
            items={fileEntries.length ? fileEntries.map((file) => ({
              key: file.path,
              label: `${formatChangeType(file.changeType)} ${file.path}`,
              children: <FileContentPreview content={file.contentPreview} />,
            })) : [{
              key: "empty",
              label: "文件内容预览",
              children: <p className="patch-empty-row">等待写入阶段返回文件内容。</p>,
            }]}
          />
        </div>
      </section>

      <section className="patch-section patch-section--verification">
        <div className="patch-section__title">
          <span>辅助信息</span>
          <h4>审查与验证</h4>
        </div>
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
  compact = false,
}: {
  step: StepRun;
  workspaceView: "summary" | "history";
  onWorkspaceViewChange: (value: "summary" | "history") => void;
  onRestore?: (snapshotId: string) => void;
  compact?: boolean;
}) {
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const historyItems = (step.history ?? []).slice().reverse();

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
    { key: "summary", label: "结构化结果", children: renderStepSummary(step) },
    ...(historyItems.length > 0 ? [{
      key: "history",
      label: `历史版本 (${historyItems.length})`,
      children: (
        <div className="step-history-list">
          {historyItems.map((snapshot) => (
            <div key={snapshot.id} className="step-history-item">
              <div className="step-history-item__header">
                <Tag color={snapshot.reason === "replay" ? "purple" : "blue"} variant="outlined">{snapshot.reason === "replay" ? "重放" : "重新生成"}</Tag>
                <small>{new Date(snapshot.createdAt).toLocaleString()}</small>
                {onRestore ? (
                  <Button size="small" loading={restoringId === snapshot.id} onClick={() => doRestore(snapshot.id)}>还原此版本</Button>
                ) : null}
              </div>
              <p className="step-history-item__summary">
                {onRestore
                  ? "已保存一份结构化结果快照，点击「还原此版本」可将当前阶段恢复到此版本并重置后续阶段。"
                  : "已保存一份结构化结果快照，可用于对比历史输出。"}
              </p>
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
        onChange={(key) => onWorkspaceViewChange(key as "summary" | "history")}
        items={tabs}
      />
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
  onDraftChange,
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
  workspaceView: "summary" | "history";
  repoResult?: RepoWriteResult;
  verification?: VerificationResult;
  onDraftChange: (value: string) => void;
  onInterventionSubmit: (event: FormEvent) => void;
  onInterventionMessage: (message: string) => void;
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
  onRestore?: (snapshotId: string) => void;
  onWorkspaceViewChange: (value: "summary" | "history") => void;
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

  if (status === "blocked") {
    if (step.id === "repo_write") {
      return (
        <div className="runtime-state-layout runtime-state-layout--blocked runtime-state-layout--patch-review">
          <RuntimeStateBanner status={status} step={step} />
          <PatchReviewWorkspace repoResult={repoResult} step={step} verification={verification} />
          <StepChatThread
            density="primary"
            draft={draft}
            messages={messages}
            onDraftChange={onDraftChange}
            onSubmit={onInterventionSubmit}
            running={running}
            step={step}
          />
        </div>
      );
    }

    return (
      <div className="runtime-state-layout runtime-state-layout--blocked">
        <RuntimeStateBanner status={status} step={step} />
        <StepInterventionWorkspace
          messages={messages}
          onSubmitMessage={onInterventionMessage}
          running={running}
          step={step}
          onFeedbackChange={onFeedbackChange}
          onContinueCueChange={onContinueCueChange}
          submitRef={submitRef}
        />
      </div>
    );
  }

  if (status === "running") {
    return (
      <div className="runtime-state-layout runtime-state-layout--running">
        <RuntimeStateBanner status={status} step={step} />
        <section className="running-workspace">
          <div className="running-workspace__pulse">
            <span className="runtime-presence-dot runtime-presence-dot--running" />
            <strong>{formatAgentName(step.agent)}</strong>
            <p>正在处理「{formatStepLabel(step.label)}」。完成后会自动更新当前工作区。</p>
          </div>
        </section>
        <OutputWorkspace
          compact
          onWorkspaceViewChange={onWorkspaceViewChange}
          step={step}
          workspaceView={workspaceView}
        />
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="runtime-state-layout runtime-state-layout--failed">
        <RuntimeStateBanner status={status} step={step} />
        <div className="runtime-priority-grid runtime-priority-grid--error">
          <section className="failure-workspace">
            <h3>{formatStepLabel(step.label)} 执行失败</h3>
            <p>{step.logs.at(-1) ?? "当前阶段执行失败，尚未提供详细错误。"}</p>
            <Space wrap>
              <Button danger onClick={onPrimaryAction} loading={running} type="primary">重试当前阶段</Button>
              <Button onClick={() => onDraftChange("请缩小当前阶段的约束，并基于已有输出重试。")}>编辑约束</Button>
            </Space>
          </section>
          <StepChatThread
            density="primary"
            draft={draft}
            messages={messages}
            onDraftChange={onDraftChange}
            onSubmit={onInterventionSubmit}
            running={running}
            step={step}
          />
        </div>
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
      {output}
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
            empty="等待写入变更后展示补丁摘要。"
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
  const [projectBreadcrumb, setProjectBreadcrumb] = useState<{ id: string; name?: string } | undefined>(
    projectId ? { id: projectId, name: "正在加载项目..." } : undefined,
  );
  const [agentMetrics, setAgentMetrics] = useState<AgentMetric[]>([]);
  const [repository, setRepository] = useState<RepositorySnapshot | null>(null);
  const [apiStatus, setApiStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [workspaceView, setWorkspaceView] = useState<"summary" | "history">("summary");
  const [chatDraft, setChatDraft] = useState("");
  const [hasQuestionFeedback, setHasQuestionFeedback] = useState(false);
  const [continueCueReady, setContinueCueReady] = useState(false);
  const structuredSubmitRef = useRef<(() => void) | null>(null);

  /** 统一提交所有待提交反馈（聊天框 + 结构化） */
  async function submitPendingFeedback() {
    const chat = chatDraft.trim();
    // 先触发结构化提交（通过 ref 调用 StepInterventionWorkspace 的 submitFeedback），
    // submitFeedback 内部调用 onSubmitMessage 即 submitInterventionMessage
    structuredSubmitRef.current?.();
    // 如果聊天框也有内容，单独提交一份聊天框消息
    if (chat) {
      await submitInterventionMessage(chat);
      setChatDraft("");
    }
  }

  /** 检查是否存在于聊天框/深层反馈表单中未提交的反馈草稿 */
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const activeStep = run ? getActiveStep(run) : null;
  const activeRuntimeStatus: RuntimeStatus = activeStep ? mapRuntimeStatus(activeStep) : "waiting";
  const hasPendingFeedback = activeRuntimeStatus === "blocked" && (chatDraft.trim() !== "" || hasQuestionFeedback);
  const shouldCueContinue =
    Boolean(activeStep) &&
    ["blocked", "waiting", "paused"].includes(activeRuntimeStatus) &&
    (activeRuntimeStatus === "blocked" && activeStep?.id === "clarification" ? continueCueReady : true);
  const metrics = summarizeMetrics(agentMetrics);
  const repoResult = run ? getStepOutput<RepoWriteResult>(run.steps, "repo_write") : undefined;
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
          setRun(workflowRun);
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
        setRun(latest);
        setApiStatus("live");
      },
      onStepEvent: () => {
        // step 级事件目前仅作为 UI hint，主要由 onUpdate 驱动状态。
        // 后续可在此 append 一条 runtimeEvent 用于实时反馈。
        getAgentMetrics().then(setAgentMetrics).catch(() => undefined);
      },
      onError: () => {
        // SSE 断开时不影响主流程；onUpdate 仍会在重连后重新推送。
      },
    });

    return dispose;
  }, [runId]);

  async function completeCurrentStep() {
    if (!run || !activeStep) return;

    // 拆分 confirm vs run 两种语义：
    // - waiting-human：用户审阅通过，调用 /confirm；
    // - 其他状态（idle / failed / success）：调用 /run 重新生成当前阶段。
    const action = activeStep.status === "waiting-human" ? "confirm" : "run";

    try {
      const nextRun = action === "confirm"
        ? await confirmWorkflowStep(run.id, activeStep.id)
        : await runWorkflowStep(run.id, activeStep.id);
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "运行阶段失败，请确认后端服务可达。");
    }
  }

  async function handleReplay(stepId: WorkflowStepId) {
    if (!run) return;

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
        : await runWorkflowStep(run.id, step.id);
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

  async function submitInterventionMessage(message: string) {
    if (!run || !activeStep || !message.trim()) return;

    const nextMessage = message.trim();
    const localUserMessage: InterventionMessage = {
      id: `${activeStep.id}-local-user-${Date.now()}`,
      stepId: activeStep.id,
      role: "user",
      content: nextMessage,
      createdAt: new Date().toISOString(),
    };
    setChatDraft("");

    // Optimistic update: 直接将临时消息插入 run.steps 的 interventions
    const previousRun = run;
    setRun({
      ...run,
      steps: run.steps.map((step) =>
        step.id === activeStep.id
          ? { ...step, interventions: [...(step.interventions ?? []), localUserMessage] }
          : step,
      ),
    });
    appendRuntimeEvents(activeStep, ["用户已提交反馈", "AI 正在处理反馈", `${activeStep.agent} started`]);

    try {
      const nextRun = await createStepIntervention(run.id, activeStep.id, nextMessage);
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      appendRuntimeEvents(activeStep, ["结构化输出已更新", "待审核"]);
    } catch (error) {
      // 回滚 optimistic update
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
          activeStepId={run.activeStepId}
          continueCueStepId={shouldCueContinue ? run.activeStepId : null}
          onContinue={handleStepContinue}
          onReplay={handleReplay}
          onSelect={(stepId) => setRun((currentRun) => currentRun ? ({ ...currentRun, activeStepId: stepId }) : currentRun)}
          steps={run.steps}
        />
      </section>

      <section className={`runtime-layout runtime-layout--focused runtime-layout--${activeRuntimeStatus}`} id="workflow">
        <section className="runtime-center" id="contract">
          <Card className={`runtime-panel runtime-step-workspace runtime-state--${activeRuntimeStatus}`} bordered={false}>
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
                    ? () => runWorkflowStep(run.id, activeStep.id).then(setRun).catch(() => undefined)
                    : undefined
              }
              onWorkspaceViewChange={setWorkspaceView}
              repoResult={repoResult}
              running={activeRuntimeStatus === "running"}
              status={activeRuntimeStatus}
              step={activeStep}
              verification={verification}
              workspaceView={workspaceView}
            />
          </Card>
        </section>
      </section>
    </main>
  );
}
