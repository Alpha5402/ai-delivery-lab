import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Alert, Button, Card, Collapse, Input, Space, Statistic, Tabs, Tag, Timeline, Tooltip, Typography } from "antd";
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
import { RepositoryChanges } from "../../components/RepositoryChanges/RepositoryChanges";
import { TestResultPanel } from "../../components/TestResultPanel/TestResultPanel";
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
import { formatCurrency, formatDuration } from "../../lib/formatters";
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
  return (
    <div className="step-summary step-summary--empty">
      <SummaryCard title="等待执行">
        <p>{step.label} 还没有产出结构化结果。点击“确认并继续”后，后端会运行对应智能体并把结构化结果传递给下游步骤。</p>
      </SummaryCard>
      <SummaryCard title="当前状态">
        <div className="workbench__meta">
          <span>{formatRuntimeStatusValue(step.status)}</span>
          <span>{step.agent}</span>
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
              <span>{requirement.targetRepo}</span>
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
      return (
        <div className="step-summary">
          <SummaryCard title="澄清摘要">
            <p>{clarification.summary}</p>
          </SummaryCard>
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
      return (
        <div className="step-summary">
          <SummaryCard title="生成策略">
            <p>{plan.strategy}</p>
          </SummaryCard>
          <SummaryCard title="任务拆解">
            <ul className="step-summary__list">
              {plan.tasks.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <small>{task.files.join(" · ")}</small>
                  <small>{task.testRequired ? "需要测试" : "无需新增测试"}</small>
                </li>
              ))}
            </ul>
          </SummaryCard>
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
  blocked: "等待用户",
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
    eyebrow: "步骤就绪",
    title: "当前步骤等待运行",
    description: "结构化输出尚未稳定，运行智能体后会把结果传递到下游运行时。",
    cta: "运行当前步骤",
  },
  running: {
    eyebrow: "智能体运行中",
    title: "智能体正在生成当前步骤",
    description: "运行事件流是此刻的主信号。结构化输出会在智能体完成后更新。",
    cta: "正在运行",
  },
  blocked: {
    eyebrow: "需要人工介入",
    title: "智能体正在等待你的修正",
    description: "请补充当前步骤的约束或纠正智能体理解，这段介入会成为运行记忆。",
    cta: "发送补充并重新生成",
  },
  success: {
    eyebrow: "步骤已完成",
    title: "当前步骤已完成",
    description: "现在优先查看结果、补丁摘要、检查清单与下一步操作。介入记录已降级为历史上下文。",
    cta: "从此步骤重放",
  },
  failed: {
    eyebrow: "步骤失败",
    title: "当前步骤执行失败",
    description: "先查看失败原因，再选择重试当前步骤或通过介入缩小约束。",
    cta: "重试步骤",
  },
  paused: {
    eyebrow: "运行已暂停",
    title: "当前运行时已暂停",
    description: "选择时间轴中的步骤继续运行、重放或查看历史输出。",
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
    "waiting-human": "等待人工介入",
    idle: "等待执行",
  };
  return statusMap[value] ?? value;
}

function formatAgentName(value: string) {
  const agentMap: Record<string, string> = {
    "Requirement Composer": "需求编排器",
    "Clarifier Agent": "澄清智能体",
    "Planner Agent": "规划智能体",
    "Context Locator": "上下文定位器",
    "Codegen Skill": "代码生成技能",
    "Conduit Writer": "Conduit 写入器",
    Verifier: "验证器",
    "PR Assistant": "PR 助手",
  };
  return agentMap[value] ?? value;
}

function formatRuntimeEventTitle(title: string) {
  const titleMap: Record<string, string> = {
    "User intervention submitted": "用户已提交介入",
    "Regenerating current step": "正在重新生成当前步骤",
    "Structured output updated": "结构化输出已更新",
    "Waiting for user confirmation": "等待用户确认",
    "Waiting for intervention": "等待人工介入",
    "Runtime auto-continue enabled": "运行时已启用自动继续",
    "User confirmed; Runtime auto-continue resumed": "用户已确认，运行时继续执行",
  };
  if (titleMap[title]) return titleMap[title];
  return Object.entries({
    "Requirement Composer": "需求编排器",
    "Clarifier Agent": "澄清智能体",
    "Planner Agent": "规划智能体",
    "Context Locator": "上下文定位器",
    "Codegen Skill": "代码生成技能",
    "Conduit Writer": "Conduit 写入器",
    Verifier: "验证器",
    "PR Assistant": "PR 助手",
    Runtime: "运行时",
    Trigger: "触发器",
    Step: "步骤",
  }).reduce((nextTitle, [source, target]) => nextTitle.replaceAll(source, target), title)
    .replace(/ started$/, " 开始执行")
    .replace(/ finished$/, " 执行完成")
    .replace(/ waiting for user$/i, " 等待用户")
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
  const text = `${question.question} ${question.answer} ${question.riskIfUnanswered}`;
  if (/Markdown|标签|字数|统计|字符|单词|空格/.test(text)) return "字数统计规则";
  if (/UI|展示|位置|标题|按钮|页面|样式|布局/.test(text)) return "UI 展示规则";
  if (/空|异常|边界|未登录|错误|特殊/.test(text)) return "特殊场景处理";
  if (/接口|后端|API|幂等|数据/.test(text)) return "接口与数据规则";
  return question.question.replace(/[？?。]/g, "").slice(0, 16) || `待确认项 ${index + 1}`;
}

function extractRuntimeMemory(messages: InterventionMessage[]) {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => {
      const blocks = message.content.split(/\n\n+/).filter(Boolean);
      return blocks.map((block, index) => {
        const titleMatch = block.match(/问题\s*\d+[:：](.+)/);
        const feedbackMatch = block.match(/我的反馈[:：]([\s\S]+)/);
        const generalMatch = block.match(/整体补充[:：]([\s\S]+)/);
        const title = titleMatch?.[1]?.trim() || (generalMatch ? "整体约束" : `确认约束 ${index + 1}`);
        const rawContent = (feedbackMatch?.[1] ?? generalMatch?.[1] ?? block).trim();
        return {
          id: `${message.id}-${index}`,
          title,
          constraints: rawContent.split(/[；;。\n]/).map((item) => item.trim()).filter(Boolean),
          source: "用户确认",
          updatedAt: message.createdAt,
        };
      });
    });
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
      step.startedAt ? { id: `${step.id}-started`, time: step.startedAt, title: `${step.agent} started`, detail: step.label, live: false } : null,
      ...step.logs.map((log, index) => ({
        id: `${step.id}-log-${index}`,
        time: step.finishedAt ?? step.startedAt ?? "",
        title: log,
        detail: `${step.label} · 事件 ${index + 1}`,
        live: false,
      })),
      step.finishedAt ? { id: `${step.id}-finished`, time: step.finishedAt, title: `${step.agent} finished`, detail: formatRuntimeStatusValue(step.status), live: false } : null,
    ].filter(Boolean) as RuntimeEvent[];
    return lifecycle;
  }).concat(activeStep && ["running", "blocked"].includes(activeStatus) ? [{
    id: `${activeStep.id}-live-${activeStatus}`,
    time: new Date().toISOString(),
    title: activeStatus === "blocked" ? "等待人工介入" : `${activeStep.agent} ${runtimeStatusLabels[activeStatus]}`,
    detail: activeStep.label,
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
    <Card className="runtime-panel runtime-timeline" title="Workflow Runtime" bordered={false}>
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
                  <span className="runtime-step__title">{step.label}</span>
                  <Button
                    aria-label={`从 ${step.label} 重放`}
                    className="runtime-step__replay"
                    size="small"
                    title={`从 ${step.label} 重放`}
                    type="text"
                    onClick={(event) => { event.stopPropagation(); onReplay(step.id); }}
                  >
                    ↺
                  </Button>
                </span>
                <span className="runtime-step__agent">{step.agent}</span>
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
          <span>人工介入</span>
          <h3>当前步骤运行记忆</h3>
        </div>
        {waitingForUser ? <Tag color="warning" variant="outlined">智能体正在等待你的修正</Tag> : <Tag variant="outlined">介入历史</Tag>}
      </header>
      {waitingForUser ? (
        <div className="runtime-chat__waiting">
          <strong>等待人工介入</strong>
          <span>当前步骤已暂停。你可以纠正智能体对当前步骤的理解，然后重新生成结构化输出。</span>
        </div>
      ) : null}
      <div className="runtime-chat__thread">
        {visibleMessages.length === 0 ? (
          <p className="runtime-muted">当前步骤还没有介入历史。补充约束后，它会作为运行记忆影响当前步骤的重新生成。</p>
        ) : threadMessages.map((message) => (
          <article className={`runtime-chat__message runtime-chat__message--${message.role}`} key={message.id}>
            <strong>{message.role === "user" ? "用户" : message.role === "system" ? "运行时" : step.agent}</strong>
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
            placeholder="继续补充当前步骤的约束，例如：不统计 Markdown 标记，只统计纯文本。"
            value={draft}
          />
          <Button htmlType="submit" loading={running} type="primary">发送补充并重新生成当前步骤</Button>
        </form>
      ) : (
        <p className="runtime-chat__minimized-note">当前步骤已完成。介入历史作为运行记忆保留；需要继续修正时可从时间轴重放此步骤。</p>
      )}
    </section>
  );
}

function StepInterventionWorkspace({
  step,
  messages,
  running,
  onSubmitMessage,
}: {
  step: StepRun;
  messages: InterventionMessage[];
  running: boolean;
  onSubmitMessage: (message: string) => void;
}) {
  const [questionFeedback, setQuestionFeedback] = useState<Record<string, string>>({});
  const [generalFeedback, setGeneralFeedback] = useState("");
  const visibleMessages = messages.filter((message) => message.stepId === step.id && message.role !== "agent");
  const value = step.output ?? step.input;
  const clarification = step.id === "clarification" && isRecord(value) ? value as ClarificationOutput : null;
  const questions = clarification?.questions ?? [];

  useEffect(() => {
    setQuestionFeedback({});
    setGeneralFeedback("");
  }, [step.id]);

  function submitFeedback() {
    const questionReplies = questions
      .map((question, index) => {
        const feedback = questionFeedback[question.id]?.trim();
        if (!feedback) return null;
        return [
          `问题 ${index + 1}：${question.question}`,
          question.answer ? `当前理解：${question.answer}` : null,
          `我的反馈：${feedback}`,
        ].filter(Boolean).join("\n");
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
  }

  return (
    <section className="intervention-workspace">
      <header className="intervention-workspace__header">
        <div>
          <span>人工介入工作区</span>
          <h3>确认结构化澄清</h3>
          <p>逐条展开需要确认的问题，补充你的修正意见；这些反馈会作为当前步骤的运行记忆一起发送。</p>
        </div>
        <Tag color="warning" variant="outlined">等待你的确认</Tag>
      </header>

      {clarification ? (
        <section className="clarification-review">
          <div className="clarification-review__summary">
            <span>智能体理解</span>
            <p>{clarification.summary}</p>
          </div>
          <Collapse
            className="clarification-question-list"
            defaultActiveKey={questions[0]?.id ? [questions[0].id] : []}
            items={questions.map((question, index) => ({
              key: question.id,
              label: (
                <span className="clarification-question-list__label">
                  <b>问题 {index + 1}</b>
                  <Typography.Text ellipsis>{getQuestionTopic(question, index)}</Typography.Text>
                </span>
              ),
              children: (
                <div className="clarification-question">
                  <section>
                    <h4>待确认项</h4>
                    <p>{question.question}</p>
                  </section>
                  <section>
                    <h4>Agent 当前理解</h4>
                    <p>{question.answer || "当前还没有明确理解，需要你补充决策信息。"}</p>
                  </section>
                  <section>
                    <h4>存在风险</h4>
                    <p>{question.riskIfUnanswered}</p>
                  </section>
                  <section>
                    <h4>用户补充</h4>
                    <Input.TextArea
                      autoSize={{ minRows: 2, maxRows: 5 }}
                      disabled={running}
                      onChange={(event) => setQuestionFeedback((current) => ({ ...current, [question.id]: event.target.value }))}
                      placeholder="补充额外约束，例如：不统计 Markdown 标签，仅统计纯文本内容。"
                      value={questionFeedback[question.id] ?? ""}
                    />
                  </section>
                </div>
              ),
            }))}
          />
        </section>
      ) : (
        <section className="clarification-review">
          {renderStepSummary(step)}
        </section>
      )}

      <section className="intervention-composer">
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={running}
          onChange={(event) => setGeneralFeedback(event.target.value)}
          placeholder="也可以在这里补充整体约束，系统会和上面的逐条反馈一起发送。"
          value={generalFeedback}
        />
        <div className="intervention-composer__footer">
          <span>{questions.length ? `${questions.length} 条待确认问题` : "当前步骤可直接补充整体约束"}</span>
          <Button type="primary" loading={running} onClick={submitFeedback}>发送全部反馈并重新生成</Button>
        </div>
      </section>

      <section className="intervention-history-inline">
        <RuntimeMemoryPanel messages={visibleMessages} />
      </section>
    </section>
  );
}

function RuntimeMemoryPanel({ messages }: { messages: InterventionMessage[] }) {
  const memories = extractRuntimeMemory(messages);
  return (
    <section className="runtime-memory-panel">
      <header>
        <span>Decision Memory</span>
        <h3>已确认约束</h3>
      </header>
      {memories.length ? memories.map((memory) => (
        <article className="runtime-memory-item" key={memory.id}>
          <h4>{memory.title}</h4>
          <ul>
            {memory.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}
          </ul>
          <footer>
            <span>来源：{memory.source}</span>
            <span>更新时间：{new Date(memory.updatedAt).toLocaleTimeString()}</span>
          </footer>
        </article>
      )) : (
        <p className="runtime-muted">尚未确认约束。你的反馈会在这里沉淀为当前运行状态，而不是聊天记录。</p>
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

function getChangedFiles(step: StepRun, repoResult?: RepoWriteResult) {
  if (repoResult?.filesChanged?.length) {
    return repoResult.filesChanged.map((file) => file.path);
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

function getChangedFileEntries(step: StepRun, repoResult?: RepoWriteResult) {
  if (repoResult?.filesChanged?.length) {
    return repoResult.filesChanged.map((file) => ({
      path: file.path,
      changeType: file.changeType,
      additions: file.additions,
      deletions: file.deletions,
    }));
  }

  return getChangedFiles(step).map((path) => ({
    path,
    changeType: "modified" as const,
    additions: 0,
    deletions: 0,
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

function ChangedFileRow({ file }: { file: ReturnType<typeof getChangedFileEntries>[number] }) {
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
  const hasQualityWarning = Boolean(verification && (verification.lint !== "passed" || verification.unitTests !== "passed" || verification.coverage <= 0));
  const checksRequiringReview = hasQualityWarning ? 1 : 0;

  return (
    <section className="patch-workspace">
      <header>
        <span>AI 代码审查工作区</span>
        <h3>补丁审查</h3>
      </header>

      <section className="patch-section patch-section--overview">
        <div className="patch-section__title">
          <span>主要信息</span>
          <h4>补丁概览</h4>
        </div>
        <div className="patch-overview-flow">
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
                    {fileEntries.length ? fileEntries.map((file) => <ChangedFileRow file={file} key={file.path} />) : <li className="patch-empty-row">当前步骤尚未产生文件变更。</li>}
                  </ul>
                ),
              }]}
            />
          </article>
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
  running,
  onPrimaryAction,
  onSecondaryAction,
}: {
  step: StepRun;
  status: RuntimeStatus;
  running: boolean;
  onPrimaryAction: () => void;
  onSecondaryAction?: () => void;
}) {
  const copy = runtimeStateCopy[status];
  const lastLog = step.logs.at(-1);

  function renderActions() {
    if (status === "running") {
      return (
        <Button disabled loading type="primary">{copy.cta}</Button>
      );
    }

    if (status === "blocked") {
      return (
        <Space>
          <Button type="primary" onClick={onPrimaryAction} loading={running}>确认并继续</Button>
          {onSecondaryAction ? <Button onClick={onSecondaryAction}>重新生成</Button> : null}
        </Space>
      );
    }

    if (status === "success") {
      return (
        <Space>
          {onSecondaryAction ? <Button type="primary" onClick={onSecondaryAction}>运行下一步</Button> : null}
          <Button onClick={onPrimaryAction}>从此重放</Button>
        </Space>
      );
    }

    if (status === "failed") {
      return (
        <Button danger type="primary" onClick={onPrimaryAction} loading={running}>重试当前步骤</Button>
      );
    }

    // waiting / paused
    return (
      <Button type="primary" onClick={onPrimaryAction} loading={running}>{copy.cta}</Button>
    );
  }

  return (
    <section className={`runtime-state-banner runtime-state-banner--${status}`}>
      <div>
        <span>{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{status === "failed" && lastLog ? `原因：${lastLog}` : copy.description}</p>
      </div>
      {renderActions()}
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
  const historyItems = (step.history ?? []).slice().reverse();
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
                  <Button size="small" onClick={() => onRestore(snapshot.id)}>还原此版本</Button>
                ) : null}
              </div>
              <p className="step-history-item__summary">已保存一份结构化结果快照，可按需还原到此版本。</p>
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
  onWorkspaceViewChange,
}: {
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
  onPrimaryAction: () => void;
  onSecondaryAction?: () => void;
  onRestore?: (snapshotId: string) => void;
  onWorkspaceViewChange: (value: "summary" | "history") => void;
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
    return (
      <div className="runtime-state-layout runtime-state-layout--blocked">
        <RuntimeStateBanner onPrimaryAction={onPrimaryAction} onSecondaryAction={onSecondaryAction} running={running} status={status} step={step} />
        <StepInterventionWorkspace
          messages={messages}
          onSubmitMessage={onInterventionMessage}
          running={running}
          step={step}
        />
      </div>
    );
  }

  if (status === "running") {
    return (
      <div className="runtime-state-layout runtime-state-layout--running">
        <RuntimeStateBanner onPrimaryAction={onPrimaryAction} onSecondaryAction={onSecondaryAction} running={running} status={status} step={step} />
        <section className="running-workspace">
          <div className="running-workspace__pulse">
            <span className="runtime-presence-dot runtime-presence-dot--running" />
            <strong>{step.agent}</strong>
            <p>正在处理「{step.label}」。详细运行事件已移到右侧观察区，这里只保留当前工作状态。</p>
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
        <RuntimeStateBanner onPrimaryAction={onPrimaryAction} onSecondaryAction={onSecondaryAction} running={running} status={status} step={step} />
        <div className="runtime-priority-grid runtime-priority-grid--error">
          <section className="failure-workspace">
            <h3>{step.agent} 执行失败</h3>
            <p>{step.logs.at(-1) ?? "当前步骤执行失败，尚未提供详细错误。"}</p>
            <Space wrap>
              <Button danger onClick={onPrimaryAction} loading={running} type="primary">重试步骤</Button>
              <Button onClick={() => onDraftChange("请缩小当前步骤的约束，并基于已有输出重试。")}>编辑约束</Button>
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
          label: `介入历史 · ${interventionCount} 条消息`,
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
          <RuntimeStateBanner onPrimaryAction={onPrimaryAction} onSecondaryAction={onSecondaryAction} running={running} status={status} step={step} />
          <PatchReviewWorkspace repoResult={repoResult} step={step} verification={verification} />
          {rawOutputDisclosure}
          {interventionDisclosure}
        </div>
      );
    }

    return (
      <div className="runtime-state-layout runtime-state-layout--success">
        <RuntimeStateBanner onPrimaryAction={onPrimaryAction} onSecondaryAction={onSecondaryAction} running={running} status={status} step={step} />
        {output}
        <PatchReviewWorkspace repoResult={repoResult} step={step} verification={verification} />
        {interventionDisclosure}
      </div>
    );
  }

  return (
    <div className="runtime-state-layout runtime-state-layout--waiting">
      <RuntimeStateBanner onPrimaryAction={onPrimaryAction} onSecondaryAction={onSecondaryAction} running={running} status={status} step={step} />
      {output}
      {chat}
    </div>
  );
}

function DynamicSidePanel({
  activeStep,
  requirement,
  repository,
  repoResult,
  verification,
  metrics,
  agentMetrics,
}: {
  activeStep: StepRun;
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
        <ContextSection title="PM 输入 / 澄清">
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
            <Tag variant="outlined">{requirement.targetRepo}</Tag>
            <Tag variant="outlined">{activeStep.agent}</Tag>
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
        <ContextSection title="上下文定位">
          <InlineList items={files} empty="等待智能体定位文件后展示代码上下文。" />
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
        <ContextSection title="代码生成 / 写入">
          <RepositoryChanges repository={repository} result={repoResult} />
        </ContextSection>
        <ContextSection title="补丁摘要">
          <InlineList
            items={(repoResult?.filesChanged ?? []).map((file) => `${formatChangeType(file.changeType)}：${file.path}（+${file.additions} / -${file.deletions}）`)}
            empty="等待写入仓库后展示补丁摘要。"
          />
        </ContextSection>
      </Card>
    );
  }

  if (activeStep.id === "verification") {
    return (
      <Card className="runtime-panel runtime-context-panel" title="运行上下文" bordered={false}>
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
      <div className="runtime-telemetry-grid">
        <Statistic title="智能体调用" value={metrics.calls} />
        <Statistic title="上下文 Token" value={metrics.inputTokens + metrics.outputTokens} />
        <Statistic title="运行时长" value={formatDuration(metrics.latencyMs)} />
        <Statistic title="成本" value={formatCurrency(metrics.estimatedCost)} />
      </div>
      <div className="runtime-agent-list">
        {agentMetrics.map((metric) => (
          <article className="runtime-agent-row" key={metric.agent}>
            <strong>{metric.agent}</strong>
            <span>{metric.inputTokens + metric.outputTokens} Token · {formatDuration(metric.latencyMs)} · {metric.calls} 次调用</span>
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
    <Card className="runtime-panel execution-feed" title="运行事件流" bordered={false}>
      {events.length === 0 ? <p className="runtime-muted">等待智能体运行事件。后续可接入 SSE 或任务事件流。</p> : null}
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
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const activeStep = run ? getActiveStep(run) : null;
  const activeRuntimeStatus: RuntimeStatus = activeStep ? mapRuntimeStatus(activeStep) : "waiting";
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
          setApiStatus("error");
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
    // - 其他状态（idle / failed / success）：调用 /run 重新生成当前步骤。
    const action = activeStep.status === "waiting-human" ? "confirm" : "run";

    try {
      const nextRun = action === "confirm"
        ? await confirmWorkflowStep(run.id, activeStep.id)
        : await runWorkflowStep(run.id, activeStep.id);
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      setErrorMessage("");
    } catch (error) {
      setApiStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "运行步骤失败，请确认后端服务可达。");
    }
  }

  async function handleReplay(stepId: WorkflowStepId) {
    if (!run) return;

    try {
      setRun(await replayWorkflowFrom(run.id, stepId));
      setErrorMessage("");
    } catch (error) {
      setApiStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "重放流程失败，请确认后端服务可达。");
    }
  }

  async function handleRunNextStep() {
    if (!run || !activeStep) return;
    const currentIndex = run.steps.findIndex((step) => step.id === activeStep.id);
    const nextStep = run.steps[currentIndex + 1];
    if (!nextStep) return;

    try {
      const nextRun = await runWorkflowStep(run.id, nextStep.id);
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      setErrorMessage("");
    } catch (error) {
      setApiStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "运行下一步失败，请确认后端服务可达。");
    }
  }

  async function handleRestore(snapshotId: string) {
    if (!run || !activeStep) return;

    try {
      const nextRun = await restoreStepSnapshot(run.id, activeStep.id, snapshotId, { replayDownstream: true });
      setRun(nextRun);
      setErrorMessage("");
    } catch (error) {
      setApiStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "还原历史版本失败。");
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
    appendRuntimeEvents(activeStep, ["用户已提交介入", "正在重新生成当前步骤", `${activeStep.agent} started`]);

    try {
      const nextRun = await createStepIntervention(run.id, activeStep.id, nextMessage);
      setRun(nextRun);
      setAgentMetrics(await getAgentMetrics());
      appendRuntimeEvents(activeStep, ["结构化输出已更新", "等待用户确认"]);
    } catch (error) {
      // 回滚 optimistic update
      setRun(previousRun);
      setErrorMessage(error instanceof Error ? error.message : "智能体重新生成失败，请确认后端服务可达。");
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
          <span className="workbench__eyebrow">运行会话</span>
          <h1>工作流：{run.title || requirement.title}</h1>
          <p>{requirement.rawText}</p>
          <div className="workbench__meta">
            <span>{requirement.pattern}</span>
            <span>{requirement.targetRepo}</span>
            <span>{runtimeStatusLabels[activeRuntimeStatus]}</span>
          </div>
        </div>
        <div className="runtime-telemetry-strip" id="observability">
          <span><strong>{metrics.calls}</strong> 次调用</span>
          <span><strong>{metrics.inputTokens + metrics.outputTokens}</strong> Token</span>
          <span><strong>{formatDuration(metrics.latencyMs)}</strong></span>
        </div>
      </section>

      {errorMessage ? <Alert type="error" message={errorMessage} showIcon /> : null}

      <section className={`runtime-layout runtime-layout--${activeRuntimeStatus}`} id="workflow">
        <aside className="runtime-left">
          <RuntimeTimeline
            activeStatus={activeRuntimeStatus}
            activeStepId={run.activeStepId}
            onReplay={handleReplay}
            onSelect={(stepId) => setRun((currentRun) => currentRun ? ({ ...currentRun, activeStepId: stepId }) : currentRun)}
            steps={run.steps}
          />
        </aside>

        <section className="runtime-center" id="contract">
          <Card className={`runtime-panel runtime-step-workspace runtime-state--${activeRuntimeStatus}`} bordered={false}>
            <header className="runtime-step-workspace__header">
              <div>
                <span className="workbench__section-label">WORKSPACE</span>
                <h2>{activeStep.label}</h2>
                <p className="runtime-status-line">
                  <span className={`runtime-presence-dot runtime-presence-dot--${activeRuntimeStatus}`} />
                  {activeStep.agent} · {runtimeStatusLabels[activeRuntimeStatus]}
                </p>
              </div>
              <Space>
                <Tag color={runtimeStatusColors[activeRuntimeStatus]} variant="outlined">{runtimeStateCopy[activeRuntimeStatus].eyebrow}</Tag>
              </Space>
            </header>
            <StateDrivenWorkspace
              draft={chatDraft}
              messages={activeStep.interventions ?? []}
              onDraftChange={setChatDraft}
              onInterventionMessage={submitInterventionMessage}
              onInterventionSubmit={handleInterventionSubmit}
              onPrimaryAction={activeRuntimeStatus === "success" ? () => handleReplay(activeStep.id) : completeCurrentStep}
              onRestore={handleRestore}
              onSecondaryAction={
                activeRuntimeStatus === "blocked"
                  ? () => runWorkflowStep(run.id, activeStep.id).then(setRun).catch(() => undefined)
                  : activeRuntimeStatus === "success"
                    ? handleRunNextStep
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

        <aside className="runtime-right">
          <div className="runtime-feed-sticky">
            <ExecutionFeed events={executionEvents} />
          </div>
          <DynamicSidePanel
            activeStep={activeStep}
            agentMetrics={agentMetrics}
            metrics={metrics}
            repoResult={repoResult}
            repository={repository}
            requirement={requirement}
            verification={verification}
          />
        </aside>
      </section>
    </main>
  );
}
