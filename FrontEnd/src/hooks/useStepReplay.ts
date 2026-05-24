import type { Dispatch } from "react";
import type { WorkflowAction, WorkflowStepId } from "../features/workflow/types";

export function useStepReplay(dispatch: Dispatch<WorkflowAction>) {
  return function replayFrom(stepId: WorkflowStepId) {
    dispatch({ type: "REPLAY_FROM", stepId });
  };
}
