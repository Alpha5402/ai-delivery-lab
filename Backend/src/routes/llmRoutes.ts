import { Router } from "express";
import {
  createLlmModel,
  deleteLlmModel,
  listPublicLlmModels,
  llmModelCreateSchema,
  llmModelPatchSchema,
  setDefaultLlmModel,
  updateLlmModel,
} from "../services/llmSettingsService.js";

export const llmRoutes = Router();

llmRoutes.get("/models", (_req, res) => {
  res.json(listPublicLlmModels());
});

llmRoutes.post("/models", (req, res) => {
  const parsed = llmModelCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid LLM model payload", issues: parsed.error.issues });
    return;
  }
  res.status(201).json(createLlmModel(parsed.data));
});

llmRoutes.patch("/models/:id", (req, res) => {
  const parsed = llmModelPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid LLM model patch", issues: parsed.error.issues });
    return;
  }
  try {
    res.json(updateLlmModel(req.params.id, parsed.data));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "LLM model not found" });
  }
});

llmRoutes.delete("/models/:id", (req, res) => {
  const deleted = deleteLlmModel(req.params.id);
  if (deleted === 0) {
    res.status(404).json({ message: "LLM model not found" });
    return;
  }
  res.status(204).send();
});

llmRoutes.post("/models/:id/default", (req, res) => {
  try {
    res.json(setDefaultLlmModel(req.params.id));
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "LLM model not found" });
  }
});
