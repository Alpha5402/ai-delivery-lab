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
  confirmStep,
  createWorkflowRun,
  deleteWorkflowRun,
  getStepHistory,
  getWorkflowRun,
  replayFromStep,
  restoreStepSnapshot,
  runStep,
  updateStepOutput,
} from "../services/workflowService.js";
import { workflowEventBus } from "../services/workflowEvents.js";
import {
  getWorkflowSettings,
  updateWorkflowSettings,
  workflowSettingsPatchSchema,
} from "../services/workflowSettingsService.js";

export const workflowRoutes = Router();

// ---- Settings ----------------------------------------------------------------

workflowRoutes.get("/settings", (_req, res) => {
  res.json(getWorkflowSettings());
});

workflowRoutes.patch("/settings", (req, res) => {
  const parsed = workflowSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid settings payload", issues: parsed.error.issues });
    return;
  }

  res.json(updateWorkflowSettings(parsed.data));
});

// ---- Run lifecycle -----------------------------------------------------------

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

// ---- SSE stream --------------------------------------------------------------

workflowRoutes.get("/:runId/stream", (req, res) => {
  const run = getWorkflowRun(req.params.runId);
  if (!run) {
    res.status(404).json({ message: "Workflow run not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 初始快照，前端订阅成功后立刻渲染。
  send("update", { run });

  const unsubscribe = workflowEventBus.subscribe(req.params.runId, (event) => {
    if (event.type === "update") {
      send("update", { run: event.run });
    } else if (event.type === "settings") {
      send("settings", { settings: event.settings });
    } else {
      send("step", event);
    }
  });

  // 心跳，避免代理切断长连接。
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

// ---- Step actions ------------------------------------------------------------

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

workflowRoutes.post("/:runId/steps/:stepId/confirm", (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);

  if (!parsedStepId.success) {
    res.status(400).json({ message: "Invalid step id" });
    return;
  }

  try {
    res.json(confirmStep(req.params.runId, parsedStepId.data));
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : "Workflow step confirm failed" });
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

// ---- Step history ------------------------------------------------------------

workflowRoutes.get("/:runId/steps/:stepId/history", (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);
  if (!parsedStepId.success) {
    res.status(400).json({ message: "Invalid step id" });
    return;
  }

  try {
    res.json(getStepHistory(req.params.runId, parsedStepId.data));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Step not found" });
  }
});

workflowRoutes.post("/:runId/steps/:stepId/restore", (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);
  if (!parsedStepId.success) {
    res.status(400).json({ message: "Invalid step id" });
    return;
  }

  const { snapshotId, replayDownstream } = req.body as { snapshotId?: string; replayDownstream?: boolean };
  if (!snapshotId || typeof snapshotId !== "string") {
    res.status(400).json({ message: "Missing or invalid snapshotId" });
    return;
  }

  try {
    res.json(restoreStepSnapshot(req.params.runId, parsedStepId.data, snapshotId, replayDownstream));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Restore failed" });
  }
});
