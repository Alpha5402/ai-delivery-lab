import { Router } from "express";
import { importWorkspaceSchema, openWorkspaceSchema, quickProjectSchema } from "../domain/workspace.js";
import {
  createQuickProjectWorkspace,
  deleteProjectWorkspace,
  getCurrentWorkspace,
  getProjectWorkspace,
  importWorkspace,
  listRecentProjectWorkspaces,
  listParsedWorkspaces,
  openParsedWorkspace,
} from "../services/workspaceService.js";
import { evictWorkflowRunsForProject } from "../services/workflowService.js";

export const workspaceRoutes = Router();

workspaceRoutes.get("/", (_req, res) => {
  res.json(listParsedWorkspaces());
});

workspaceRoutes.get("/recent", (_req, res) => {
  res.json(listRecentProjectWorkspaces());
});

workspaceRoutes.get("/current", (_req, res) => {
  const workspace = getCurrentWorkspace();

  if (!workspace) {
    res.status(404).json({ message: "Workspace not found" });
    return;
  }

  res.json(workspace);
});

workspaceRoutes.get("/:projectId", (req, res) => {
  try {
    res.json(getProjectWorkspace(req.params.projectId));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Project not found" });
  }
});

workspaceRoutes.delete("/:projectId", async (req, res) => {
  try {
    await deleteProjectWorkspace(req.params.projectId, req.query.deleteDirectory === "true");
    evictWorkflowRunsForProject(req.params.projectId);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Project not found" });
  }
});

workspaceRoutes.post("/open", (req, res) => {
  const parsed = openWorkspaceSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid workspace open payload", issues: parsed.error.issues });
    return;
  }

  try {
    res.json(openParsedWorkspace(parsed.data.workspaceId));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Workspace not found" });
  }
});

workspaceRoutes.post("/import", async (req, res) => {
  const parsed = importWorkspaceSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid workspace import payload", issues: parsed.error.issues });
    return;
  }

  try {
    res.status(201).json(await importWorkspace(parsed.data));
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "Workspace import failed" });
  }
});

workspaceRoutes.post("/quick-project", async (req, res) => {
  const parsed = quickProjectSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid quick project payload", issues: parsed.error.issues });
    return;
  }

  try {
    res.status(201).json(await createQuickProjectWorkspace(parsed.data));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Quick project workspace creation failed" });
  }
});
