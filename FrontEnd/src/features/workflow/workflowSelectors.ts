import { stepOrder } from "./stepDefinitions";
import type { WorkflowRun, WorkflowStepId } from "./types";

export function getActiveStep(run: WorkflowRun) {
  return run.steps.find((step) => step.id === run.activeStepId) ?? run.steps[0];
}

export function getCompletedSteps(run: WorkflowRun) {
  return run.steps.filter((step) => step.status === "success");
}

export function hasHumanBlocker(run: WorkflowRun) {
  return run.steps.some((step) => step.status === "waiting-human");
}

export function canSubmitPullRequest(run: WorkflowRun) {
  const verification = run.steps.find((step) => step.id === "verification");
  return verification?.status === "success" && !hasHumanBlocker(run);
}

export function getDownstreamStepIds(stepId: WorkflowStepId) {
  const index = stepOrder.indexOf(stepId);
  return index === -1 ? [] : stepOrder.slice(index + 1);
}
