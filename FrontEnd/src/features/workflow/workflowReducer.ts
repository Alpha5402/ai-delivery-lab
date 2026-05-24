import { stepOrder } from "./stepDefinitions";
import type { StepRun, WorkflowAction, WorkflowRun, WorkflowStepId } from "./types";

function now() {
  return new Date().toISOString();
}

function stepIndex(stepId: WorkflowStepId) {
  return stepOrder.indexOf(stepId);
}

function updateStep(steps: StepRun[], stepId: WorkflowStepId, updater: (step: StepRun) => StepRun) {
  return steps.map((step) => (step.id === stepId ? updater(step) : step));
}

export function workflowReducer(state: WorkflowRun, action: WorkflowAction): WorkflowRun {
  switch (action.type) {
    case "START_STEP":
      return {
        ...state,
        activeStepId: action.stepId,
        steps: updateStep(state.steps, action.stepId, (step) => ({
          ...step,
          status: "running",
          startedAt: now(),
          logs: [...step.logs, "开始执行当前 Step"],
        })),
      };
    case "COMPLETE_STEP": {
      const currentIndex = stepIndex(action.stepId);
      const nextStepId = stepOrder[currentIndex + 1] ?? action.stepId;
      return {
        ...state,
        activeStepId: nextStepId,
        steps: state.steps.map((step, index) => {
          if (step.id === action.stepId) {
            return {
              ...step,
              status: "success",
              output: action.output,
              finishedAt: now(),
              logs: [...step.logs, "Step 执行成功"],
            };
          }

          if (index === currentIndex + 1) {
            return {
              ...step,
              input: action.output,
            };
          }

          return step;
        }),
      };
    }
    case "WAIT_FOR_HUMAN":
      return {
        ...state,
        activeStepId: action.stepId,
        steps: updateStep(state.steps, action.stepId, (step) => ({
          ...step,
          status: "waiting-human",
          logs: [...step.logs, action.message],
        })),
      };
    case "FAIL_STEP":
      return {
        ...state,
        activeStepId: action.stepId,
        steps: updateStep(state.steps, action.stepId, (step) => ({
          ...step,
          status: "failed",
          finishedAt: now(),
          logs: [...step.logs, action.message],
        })),
      };
    case "UPDATE_STEP_JSON":
      return {
        ...state,
        steps: updateStep(state.steps, action.stepId, (step) => ({
          ...step,
          output: action.output,
          logs: [...step.logs, "人工修订了 Step JSON 输出"],
        })),
      };
    case "REPLAY_FROM": {
      const replayIndex = stepIndex(action.stepId);
      return {
        ...state,
        activeStepId: action.stepId,
        steps: state.steps.map((step, index) => {
          if (index < replayIndex) {
            return step;
          }

          if (index === replayIndex) {
            return {
              ...step,
              status: "replayed",
              logs: [...step.logs, "从这里开始重放下游流程"],
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
        }),
      };
    }
    default:
      return state;
  }
}
