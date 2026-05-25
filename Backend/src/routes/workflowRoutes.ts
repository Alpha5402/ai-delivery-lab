import { Router } from "express";
import {
  createWorkflowSchema,
  createInterventionSchema,
  replayWorkflowSchema,
  updateStepSchema,
  workflowStepIdSchema,
} from "../domain/workflow.js";
import {
  addInterventionAndRegenerate,
  createWorkflowRun,
  deleteWorkflowRun,
  getCurrentWorkflowRun,
  getWorkflowRun,
  replayFromStep,
  runStep,
  updateStepOutput,
} from "../services/workflowService.js";

export const workflowRoutes = Router();

workflowRoutes.get("/current", (_req, res) => {
  const run = getCurrentWorkflowRun();

  if (!run) {
    res.status(404).json({ message: "Workflow run not found" });
    return;
  }

  res.json(run);
});

workflowRoutes.get("/:runId", (req, res) => {
  const run = getWorkflowRun(req.params.runId);

  if (!run) {
    res.status(404).json({ message: "Workflow run not found" });
    return;
  }

  res.json(run);
});

workflowRoutes.post("/", async (req, res) => {
  const parsed = createWorkflowSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid workflow input", issues: parsed.error.issues });
    return;
  }

  const run = await createWorkflowRun({
    projectId: parsed.data.projectId ?? parsed.data.workspaceId,
    title: parsed.data.title ?? parsed.data.rawText.slice(0, 40),
    rawText: parsed.data.rawText,
    pattern: parsed.data.pattern,
    targetRepo: parsed.data.targetRepo,
  });

  res.status(201).json(run);
});

workflowRoutes.delete("/:runId", (req, res) => {
  try {
    deleteWorkflowRun(req.params.runId);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Workflow run not found" });
  }
});

workflowRoutes.post("/:runId/steps/:stepId/interventions", async (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);
  const parsedBody = createInterventionSchema.safeParse(req.body);

  if (!parsedStepId.success || !parsedBody.success) {
    res.status(400).json({ message: "Invalid intervention payload" });
    return;
  }

  try {
    res.json(await addInterventionAndRegenerate(req.params.runId, parsedStepId.data, parsedBody.data.message));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Workflow intervention failed" });
  }
});

workflowRoutes.post("/:runId/steps/:stepId/run", async (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);

  if (!parsedStepId.success) {
    res.status(400).json({ message: "Invalid step id" });
    return;
  }

  try {
    res.json(await runStep(req.params.runId, parsedStepId.data));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Workflow step failed" });
  }
});

workflowRoutes.patch("/:runId/steps/:stepId", (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);
  const parsedBody = updateStepSchema.safeParse(req.body);

  if (!parsedStepId.success || !parsedBody.success) {
    res.status(400).json({ message: "Invalid step update payload" });
    return;
  }

  try {
    res.json(updateStepOutput(req.params.runId, parsedStepId.data, parsedBody.data.output));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Workflow run not found" });
  }
});

workflowRoutes.post("/:runId/replay", (req, res) => {
  const parsed = replayWorkflowSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid replay payload", issues: parsed.error.issues });
    return;
  }

  try {
    res.json(replayFromStep(req.params.runId, parsed.data.stepId));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Workflow run not found" });
  }
});
