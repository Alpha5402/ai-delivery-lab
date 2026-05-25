import { randomUUID } from "node:crypto";
import { runClarifierAgent } from "../agents/clarifierAgent.js";
import { runPlannerAgent } from "../agents/plannerAgent.js";
import { runWorkflowStepAgent } from "../agents/workflowStepAgent.js";
import {
  type ClarificationOutput,
  type InterventionMessage,
  type RequirementDraft,
  type StepRun,
  type WorkflowRun,
  type WorkflowStepId,
  stepAgents,
  stepExecutionModes,
  stepLabels,
  stepOrder,
} from "../domain/workflow.js";
import { getCurrentWorkspace } from "./workspaceService.js";
import { deleteWorkflowRunFromStore, getStoredWorkflowRun, saveWorkflowRunToStore } from "./workspaceStore.js";

const humanEditableSteps = new Set<WorkflowStepId>([
  "clarification",
  "solution_design",
  "module_mapping",
  "code_generation",
]);

const runs = new Map<string, WorkflowRun>();
let currentRunId: string | null = null;

function now() {
  return new Date().toISOString();
}

function createSteps(requirement: RequirementDraft): StepRun[] {
  return stepOrder.map((stepId, index) => ({
    id: stepId,
    label: stepLabels[stepId],
    agent: stepAgents[stepId],
    status: index === 0 ? "success" : "idle",
    input: index === 0 ? { source: "pm" } : undefined,
    output: index === 0 ? requirement : undefined,
    startedAt: index === 0 ? now() : undefined,
    finishedAt: index === 0 ? now() : undefined,
    logs: index === 0 ? ["PM 需求已接收", "Runtime Trigger 已创建，自动进入 Clarifier Agent"] : [],
    interventions: index === 0 ? [{
      id: `${stepId}-agent-${Date.now()}`,
      stepId,
      role: "agent",
      content: "已接收需求，Runtime 将自动进入下一个 Agent Step。",
      createdAt: now(),
    }] : [],
    humanEditable: humanEditableSteps.has(stepId),
  }));
}

function persistRun(run: WorkflowRun) {
  const projectId = run.projectId ?? getCurrentWorkspace()?.id;
  if (projectId) {
    saveWorkflowRunToStore(projectId, { ...run, projectId });
  }
}

export function getCurrentWorkflowRun() {
  return currentRunId ? runs.get(currentRunId) : undefined;
}

export function getWorkflowRun(runId: string) {
  const run = runs.get(runId) ?? getStoredWorkflowRun(runId) ?? undefined;
  if (run) {
    runs.set(run.id, run);
    currentRunId = run.id;
  }

  return run;
}

export async function createWorkflowRun(input: RequirementDraft & { projectId?: string }) {
  const timestamp = now();
  const run: WorkflowRun = {
    id: `run-${randomUUID()}`,
    title: input.title,
    createdAt: timestamp,
    updatedAt: timestamp,
    projectId: input.projectId ?? getCurrentWorkspace()?.id,
    activeStepId: "clarification",
    steps: createSteps(input),
  };

  runs.set(run.id, run);
  currentRunId = run.id;
  persistRun(run);
  try {
    return await autoContinue(run.id);
  } catch {
    return getExistingRun(run.id);
  }
}

export function updateStepOutput(runId: string, stepId: WorkflowStepId, output: unknown) {
  const run = getExistingRun(runId);
  run.updatedAt = now();
  run.steps = run.steps.map((step) =>
    step.id === stepId
      ? { ...step, output, logs: [...step.logs, "人工修订了 Step JSON 输出"] }
      : step,
  );
  persistRun(run);
  return run;
}

export function replayFromStep(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const replayIndex = stepOrder.indexOf(stepId);
  run.activeStepId = stepId;
  run.updatedAt = now();
  run.steps = run.steps.map((step, index) => {
    if (index < replayIndex) {
      return step;
    }

    if (index === replayIndex) {
      return {
        ...step,
        status: "replayed",
        logs: [...step.logs, "从这里开始重放下游流程", "Runtime 将根据 Step 模式自动继续，直到需要人工介入"],
      };
    }

    return {
      ...step,
      status: "idle",
      output: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      logs: [],
    };
  });
  persistRun(run);
  return run;
}

export async function runStep(runId: string, stepId: WorkflowStepId) {
  const run = getExistingRun(runId);
  const stepIndex = stepOrder.indexOf(stepId);
  const step = run.steps[stepIndex];

  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  if (step.status === "waiting-human" && step.output) {
    return continueAfterManualConfirmation(run, stepId);
  }

  run.activeStepId = stepId;
  run.updatedAt = now();
  run.steps = run.steps.map((current) => current.id === stepId ? {
    ...current,
    status: "running",
    startedAt: current.startedAt ?? now(),
    logs: [...current.logs, `${current.agent} started`],
  } : current);

  try {
    const output = await resolveStepOutput(run, stepId);
    const nextStepId = stepOrder[stepIndex + 1] ?? stepId;

    const mode = stepExecutionModes[stepId];
    run.activeStepId = mode === "manual-confirmation" ? stepId : nextStepId;
    run.updatedAt = now();
    run.steps = run.steps.map((current, index) => {
      if (current.id === stepId) {
        return {
          ...current,
          status: mode === "manual-confirmation" ? "waiting-human" : "success",
          output,
          finishedAt: now(),
          logs: [
            ...current.logs,
            `${current.agent} finished`,
            mode === "manual-confirmation" ? `${current.agent} waiting for user` : "Runtime auto-continue enabled",
          ],
          interventions: mode === "manual-confirmation"
            ? [...(current.interventions ?? []), {
              id: `${stepId}-agent-${Date.now()}`,
              stepId,
              role: "agent",
              content: "我已生成当前 Step 的结构化结果，请确认或继续补充需求。",
              createdAt: now(),
            }]
            : current.interventions,
        };
      }

      if (mode === "automatic" && index === stepIndex + 1) {
        return {
          ...current,
          input: output,
          status: current.status === "idle" ? "idle" : current.status,
        };
      }

      return current;
    });

    persistRun(run);
    return run;
  } catch (error) {
    run.updatedAt = now();
    run.steps = run.steps.map((current) => current.id === stepId ? {
      ...current,
      status: "failed",
      finishedAt: now(),
      logs: [...current.logs, error instanceof Error ? error.message : "Agent 执行失败"],
    } : current);
    persistRun(run);
    throw error;
  }
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
  run.updatedAt = now();
  run.steps = run.steps.map((current) => current.id === stepId
    ? {
      ...current,
      interventions: [...(current.interventions ?? []), userMessage, agentMessage],
      logs: [...current.logs, "User intervention submitted", "Regenerating current step"],
    }
    : current);
  persistRun(run);

  return runStep(runId, stepId);
}

export function deleteWorkflowRun(runId: string) {
  runs.delete(runId);
  if (currentRunId === runId) {
    currentRunId = null;
  }
  deleteWorkflowRunFromStore(runId);
}

export function evictWorkflowRunsForProject(projectId: string) {
  for (const [runId, run] of runs.entries()) {
    if (run.projectId === projectId) {
      runs.delete(runId);
      if (currentRunId === runId) {
        currentRunId = null;
      }
    }
  }
}

async function autoContinue(runId: string) {
  let run = getExistingRun(runId);
  let guard = 0;

  while (guard < stepOrder.length) {
    guard += 1;
    const step = run.steps.find((item) => item.id === run.activeStepId);
    if (!step || step.status === "waiting-human" || step.status === "failed") {
      return run;
    }

    if (stepExecutionModes[step.id] === "automatic" || !step.output) {
      run = await runStep(run.id, step.id);
      continue;
    }

    return run;
  }

  return run;
}

function continueAfterManualConfirmation(run: WorkflowRun, stepId: WorkflowStepId) {
  const stepIndex = stepOrder.indexOf(stepId);
  const nextStepId = stepOrder[stepIndex + 1] ?? stepId;
  run.activeStepId = nextStepId;
  run.updatedAt = now();
  run.steps = run.steps.map((current, index) => {
    if (current.id === stepId) {
      return {
        ...current,
        status: "success",
        logs: [...current.logs, "User confirmed; Runtime auto-continue resumed"],
      };
    }

    if (index === stepIndex + 1) {
      return {
        ...current,
        input: run.steps[stepIndex]?.output,
      };
    }

    return current;
  });
  persistRun(run);
  return autoContinue(run.id);
}

async function resolveStepOutput(run: WorkflowRun, stepId: WorkflowStepId) {
  if (stepId === "requirement_intake") {
    return getStepOutput<RequirementDraft>(run, "requirement_intake");
  }

  if (stepId === "clarification") {
    const requirement = getStepOutput<RequirementDraft>(run, "requirement_intake");
    return runClarifierAgent(requirement);
  }

  if (stepId === "solution_design") {
    const requirement = getStepOutput<RequirementDraft>(run, "requirement_intake");
    const clarification = getStepOutput<ClarificationOutput>(run, "clarification");
    return runPlannerAgent(requirement, clarification);
  }

  return runWorkflowStepAgent(stepId, run);
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
