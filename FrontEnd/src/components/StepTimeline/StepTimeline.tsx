import type { StepRun, WorkflowStepId } from "../../features/workflow/types";
import { StatusBadge } from "../StatusBadge/StatusBadge";
import "./StepTimeline.css";

function formatStepLabel(value: string) {
  const labelMap: Record<string, string> = {
    "PM 输入": "接收需求",
    "澄清 Agent": "确认需求",
    "方案 DSL": "生成方案",
    "模块定位": "定位代码",
    "代码计划": "生成代码",
    "写入仓库": "生成代码",
    "Lint / 单测": "验证结果",
    "提交 PR": "提交 PR",
  };
  return labelMap[value] ?? value;
}

function formatAgentName(value: string) {
  const agentMap: Record<string, string> = {
    "Requirement Composer": "接收需求",
    "Clarifier Agent": "确认需求",
    "Planner Agent": "生成方案",
    "Context Locator": "定位代码",
    "Codegen Skill": "生成代码",
    Verifier: "验证结果",
    "PR Assistant": "提交 PR",
  };
  if (/Writer$/i.test(value)) return "生成代码";
  return agentMap[value] ?? value;
}

export function StepTimeline({ steps, activeStepId, onSelect }: { steps: StepRun[]; activeStepId: WorkflowStepId; onSelect: (stepId: WorkflowStepId) => void }) {
  return (
    <section className="step-timeline" aria-label="AI 交付流程">
      {steps.map((step, index) => (
        <button
          className={`step-timeline__item ${step.id === activeStepId ? "step-timeline__item--active" : ""}`}
          key={step.id}
          onClick={() => onSelect(step.id)}
          type="button"
        >
          <span className="step-timeline__index">{String(index + 1).padStart(2, "0")}</span>
          <span className="step-timeline__content">
            <strong>{formatStepLabel(step.label)}</strong>
            <small>{formatAgentName(step.agent)}</small>
          </span>
          <StatusBadge status={step.status} />
        </button>
      ))}
    </section>
  );
}
