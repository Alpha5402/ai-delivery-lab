import { Router } from "express";
import { z } from "zod";
import {
  createWorkflowSchema,
  createInterventionSchema,
  replayWorkflowSchema,
  updateStepSchema,
  workflowStepIdSchema,
} from "../domain/workflow.js";
import {
  addInterventionAndRegenerate,
  confirmRecalledCases,
  confirmStep,
  createWorkflowRun,
  deleteExecutionTreeNode,
  deleteWorkflowRun,
  favoriteWorkflowRunCase,
  getStepHistory,
  getWorkflowExecutionTree,
  getWorkflowRun,
  replayFromStep,
  restoreExecutionTreeNode,
  restoreStepSnapshot,
  runStep,
  updateStepOutput,
} from "../services/workflowService.js";
import { getCurrentWorkspace } from "../services/workspaceService.js";
import { listMetrics } from "../services/metricsService.js";
import { workflowEventBus } from "../services/workflowEvents.js";
import {
  getWorkflowSettings,
  updateWorkflowSettings,
  workflowSettingsPatchSchema,
} from "../services/workflowSettingsService.js";
import { buildMatchReason } from "../skills/skillRegistry.js";
import type { WorkflowRun } from "../domain/workflow.js";

/** 在返回给前端前注入 Skill 命中信息（run 级别）。 */
function enrichWithSkill(run: WorkflowRun): WorkflowRun {
  const reason = buildMatchReason(run, getCurrentWorkspace() ?? undefined);
  if (reason) {
    return { ...run, selectedSkillId: reason.skillId, skillMatchReason: reason };
  }
  return run;
}

export const workflowRoutes = Router();

const runStepOptionsSchema = z.object({
  pullRequest: z.object({
    branch: z.string().optional(),
    commitMessage: z.string().optional(),
  }).optional(),
}).optional();

const confirmRecalledCasesSchema = z.object({
  selectedCaseIds: z.array(z.string().min(1)).max(3).default([]),
});

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

  res.json(enrichWithSkill(run));
});

workflowRoutes.post("/", async (req, res) => {
  const parsed = createWorkflowSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid workflow input", issues: parsed.error.issues });
    return;
  }

  const run = await createWorkflowRun({
    projectId: parsed.data.projectId ?? parsed.data.workspaceId,
    title: parsed.data.title,
    rawText: parsed.data.rawText,
    pattern: parsed.data.pattern,
    targetRepo: parsed.data.targetRepo,
  });

  res.status(201).json(enrichWithSkill(run));
});

workflowRoutes.delete("/:runId", (req, res) => {
  try {
    deleteWorkflowRun(req.params.runId);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Workflow run not found" });
  }
});

workflowRoutes.post("/:runId/favorite-case", async (req, res) => {
  try {
    const result = await favoriteWorkflowRunCase(req.params.runId);
    res.status(201).json({ ...result, run: enrichWithSkill(result.run) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow run cannot be favorited";
    res.status(message.includes("已完成") ? 409 : 404).json({ message });
  }
});

workflowRoutes.post("/:runId/recalled-cases/confirm", async (req, res) => {
  const parsed = confirmRecalledCasesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid recalled case selection", issues: parsed.error.issues });
    return;
  }

  try {
    const run = await confirmRecalledCases(req.params.runId, parsed.data.selectedCaseIds);
    res.json(enrichWithSkill(run));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to confirm recalled cases";
    res.status(message.includes("不存在") || message.includes("not found") ? 404 : 409).json({ message });
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
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const streamId = `${req.params.runId}:${Date.now()}`;
  let closed = false;
  console.log("[workflow-sse]", JSON.stringify({
    event: "connect",
    streamId,
    runId: req.params.runId,
    activeStepId: run.activeStepId,
  }));

  const send = (event: string, data: unknown) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      console.log("[workflow-sse]", JSON.stringify({
        event: "send",
        streamId,
        runId: req.params.runId,
        type: event,
        stepId: event === "step" && typeof data === "object" && data !== null ? (data as { stepId?: unknown }).stepId : undefined,
        phase: event === "step" && typeof data === "object" && data !== null ? (data as { phase?: unknown }).phase : undefined,
      }));
    } catch (error) {
      console.error("[workflow-sse]", JSON.stringify({
        event: "send.failed",
        streamId,
        runId: req.params.runId,
        type: event,
        message: error instanceof Error ? error.message : "unknown SSE write error",
      }));
    }
  };

  res.write("retry: 3000\n\n");

  // 先订阅，再发送最新快照——避免订阅与快照之间的丢事件窗口
  const unsubscribe = workflowEventBus.subscribe(req.params.runId, (event) => {
    if (event.type === "update") {
      send("update", { run: enrichWithSkill(event.run) });
    } else if (event.type === "settings") {
      send("settings", { settings: event.settings });
    } else if (event.type === "metrics") {
      send("metrics", { metrics: event.metrics });
    } else {
      send("step", event);
    }
  });

  // 订阅后再发送最新快照 + 初始 metrics
  const latest = getWorkflowRun(req.params.runId);
  if (latest) send("update", { run: enrichWithSkill(latest) });
  send("metrics", { metrics: listMetrics() });

  // 心跳，避免代理切断长连接。
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(": ping\n\n");
    } catch (error) {
      console.error("[workflow-sse]", JSON.stringify({
        event: "heartbeat.failed",
        streamId,
        runId: req.params.runId,
        message: error instanceof Error ? error.message : "unknown SSE heartbeat error",
      }));
    }
  }, 15000);

  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    console.log("[workflow-sse]", JSON.stringify({
      event: "disconnect",
      streamId,
      runId: req.params.runId,
    }));
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
    res.json(enrichWithSkill(await addInterventionAndRegenerate(req.params.runId, parsedStepId.data, parsedBody.data.message)));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Workflow intervention failed" });
  }
});

workflowRoutes.post("/:runId/steps/:stepId/run", async (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);
  const parsedBody = runStepOptionsSchema.safeParse(req.body);

  if (!parsedStepId.success || !parsedBody.success) {
    res.status(400).json({ message: "Invalid step run payload" });
    return;
  }

  try {
    res.json(enrichWithSkill(await runStep(req.params.runId, parsedStepId.data, parsedBody.data)));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Workflow step failed" });
  }
});

workflowRoutes.post("/:runId/steps/:stepId/confirm", async (req, res) => {
  const parsedStepId = workflowStepIdSchema.safeParse(req.params.stepId);

  if (!parsedStepId.success) {
    res.status(400).json({ message: "Invalid step id" });
    return;
  }

  try {
    res.json(enrichWithSkill(await confirmStep(req.params.runId, parsedStepId.data)));
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
    res.json(enrichWithSkill(updateStepOutput(req.params.runId, parsedStepId.data, parsedBody.data.output)));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Workflow run not found" });
  }
});

workflowRoutes.post("/:runId/replay", async (req, res) => {
  const parsed = replayWorkflowSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid replay payload", issues: parsed.error.issues });
    return;
  }

  try {
    console.log("[workflow-replay][route]", JSON.stringify({
      runId: req.params.runId,
      stepId: parsed.data.stepId,
      codeReviewContext: parsed.data.codeReviewContext ?? null,
    }));
    res.json(enrichWithSkill(await replayFromStep(req.params.runId, parsed.data.stepId, {
      codeReviewContext: parsed.data.codeReviewContext,
    })));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Workflow run not found" });
  }
});

// ---- Code Review Retry --------------------------------------------------------

workflowRoutes.post("/:runId/steps/code_review/retry-code-generation", async (req, res) => {
  try {
    const { retryCodeGenerationFromCodeReview } = await import("../services/workflowService.js");
    res.json(enrichWithSkill(await retryCodeGenerationFromCodeReview(req.params.runId)));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "按审查意见重跑生成代码失败" });
  }
});

workflowRoutes.post("/:runId/steps/code_review/repair", async (req, res) => {
  try {
    const { retryCodeGenerationFromCodeReview } = await import("../services/workflowService.js");
    res.json(enrichWithSkill(await retryCodeGenerationFromCodeReview(req.params.runId)));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "按审查意见重跑生成代码失败" });
  }
});

// ---- Step history ------------------------------------------------------------

workflowRoutes.get("/:runId/execution-tree", (req, res) => {
  try {
    res.json(getWorkflowExecutionTree(req.params.runId));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Execution tree not found" });
  }
});

workflowRoutes.post("/:runId/execution-tree/nodes/:nodeId/restore", async (req, res) => {
  try {
    res.json(enrichWithSkill(await restoreExecutionTreeNode(req.params.runId, req.params.nodeId)));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Execution node restore failed" });
  }
});

workflowRoutes.delete("/:runId/execution-tree/nodes/:nodeId", (req, res) => {
  try {
    res.json(enrichWithSkill(deleteExecutionTreeNode(req.params.runId, req.params.nodeId)));
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : "Execution node delete failed" });
  }
});

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

workflowRoutes.post("/:runId/steps/:stepId/restore", async (req, res) => {
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
    res.json(enrichWithSkill(await restoreStepSnapshot(req.params.runId, parsedStepId.data, snapshotId, replayDownstream)));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Restore failed" });
  }
});
