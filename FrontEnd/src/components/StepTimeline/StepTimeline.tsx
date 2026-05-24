import type { StepRun, WorkflowStepId } from "../../features/workflow/types";
import { StatusBadge } from "../StatusBadge/StatusBadge";
import "./StepTimeline.css";

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
            <strong>{step.label}</strong>
            <small>{step.agent}</small>
          </span>
          <StatusBadge status={step.status} />
        </button>
      ))}
    </section>
  );
}
