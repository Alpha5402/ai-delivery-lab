import { useMemo, useReducer } from "react";
import { createMockWorkflowRun } from "../features/workflow/mockWorkflow";
import { workflowReducer } from "../features/workflow/workflowReducer";

export function useWorkflowRun() {
  const initialRun = useMemo(() => createMockWorkflowRun(), []);
  return useReducer(workflowReducer, initialRun);
}
