import { AgentCard } from "./components/AgentCard/AgentCard";
import { AppShell } from "./components/AppShell/AppShell";
import { JsonPanel } from "./components/JsonPanel/JsonPanel";
import { MetricCard } from "./components/MetricCard/MetricCard";
import { ReplayControls } from "./components/ReplayControls/ReplayControls";
import { RepositoryChanges } from "./components/RepositoryChanges/RepositoryChanges";
import { RequirementComposer } from "./components/RequirementComposer/RequirementComposer";
import { StepTimeline } from "./components/StepTimeline/StepTimeline";
import { TestResultPanel } from "./components/TestResultPanel/TestResultPanel";
import { mockMetrics, summarizeMetrics } from "./features/observability/mockMetrics";
import { mockRepository } from "./features/repository/mockRepository";
import type { RepoWriteResult, VerificationResult, WorkflowStepId } from "./features/workflow/types";
import { getActiveStep } from "./features/workflow/workflowSelectors";
import { useStepReplay } from "./hooks/useStepReplay";
import { useWorkflowRun } from "./hooks/useWorkflowRun";
import { formatCurrency, formatDuration } from "./lib/formatters";
import "./styles/global.css";

function getStepOutput<T>(steps: Array<{ id: WorkflowStepId; output?: unknown }>, stepId: WorkflowStepId) {
  return steps.find((step) => step.id === stepId)?.output as T | undefined;
}

export default function App() {
  const [run, dispatch] = useWorkflowRun();
  const activeStep = getActiveStep(run);
  const replayFrom = useStepReplay(dispatch);
  const metrics = summarizeMetrics(mockMetrics);
  const repoResult = getStepOutput<RepoWriteResult>(run.steps, "repo_write");
  const verification = getStepOutput<VerificationResult>(run.steps, "verification");
  const requirement = getStepOutput(run.steps, "requirement_intake") ?? activeStep.output;

  function completeCurrentStep() {
    dispatch({ type: "COMPLETE_STEP", stepId: activeStep.id, output: activeStep.output ?? activeStep.input });
  }

  return (
    <AppShell>
      <main className="workbench">
        <section className="workbench__hero">
          <RequirementComposer requirement={requirement as never} />
          <div className="workbench__metrics" id="observability">
            <MetricCard label="Agent Calls" value={String(metrics.calls)} />
            <MetricCard label="Total Tokens" value={String(metrics.inputTokens + metrics.outputTokens)} />
            <MetricCard label="Latency" value={formatDuration(metrics.latencyMs)} tone="warn" />
            <MetricCard label="Cost" value={formatCurrency(metrics.estimatedCost)} tone="good" />
          </div>
        </section>

        <section className="workbench__grid" id="workflow">
          <aside className="workbench__left">
            <div className="panel-heading">
              <span>Step Orchestration</span>
              <h2>可暂停、可修订、可重放的端到端链路</h2>
            </div>
            <StepTimeline steps={run.steps} activeStepId={run.activeStepId} onSelect={(stepId) => dispatch({ type: "WAIT_FOR_HUMAN", stepId, message: "人工切换查看此 Step" })} />
          </aside>

          <section className="workbench__center" id="contract">
            <ReplayControls step={activeStep} onReplay={() => replayFrom(activeStep.id)} onRunNext={completeCurrentStep} />
            <JsonPanel
              title={`${activeStep.label} 输出`}
              value={activeStep.output ?? activeStep.input}
              editable={activeStep.humanEditable}
              onSave={(output) => dispatch({ type: "UPDATE_STEP_JSON", stepId: activeStep.id, output })}
            />
          </section>

          <aside className="workbench__right">
            <RepositoryChanges repository={mockRepository} result={repoResult} />
            <TestResultPanel result={verification} />
            <section className="agent-stack">
              <header>
                <span>Agent Observability</span>
                <h3>AI 调用留痕</h3>
              </header>
              {mockMetrics.map((metric) => <AgentCard key={metric.agent} metric={metric} />)}
            </section>
          </aside>
        </section>
      </main>
    </AppShell>
  );
}
