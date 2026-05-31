import { Router } from "express";
import {
  getDefaultWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
} from "../workflowTemplates/templateRegistry.js";

export const templateRoutes = Router();

/** 列出所有已注册 template 的轻量 metadata */
templateRoutes.get("/", (_req, res) => {
  const templates = listWorkflowTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    version: t.version,
    stepCount: t.steps.length,
    stepIds: t.steps.map((s) => s.id),
  }));
  res.json(templates);
});

/** 获取默认 template（8 步 default-software-delivery） */
templateRoutes.get("/default", (_req, res) => {
  const t = getDefaultWorkflowTemplate();
  res.json(t);
});

/** 获取指定 template */
templateRoutes.get("/:id", (req, res) => {
  const t = getWorkflowTemplate(req.params.id);
  if (!t) {
    res.status(404).json({ message: `Template not found: ${req.params.id}` });
    return;
  }
  res.json(t);
});
