import { Router } from "express";
import { llmSettingsPatchSchema, getPublicLlmSettings, updateLlmSettings } from "../services/llmSettingsService.js";
import { listDailyMetrics, listMetrics } from "../services/metricsService.js";

export const metricsRoutes = Router();

metricsRoutes.get("/", (_req, res) => {
  res.json(listMetrics());
});

metricsRoutes.get("/daily", (_req, res) => {
  res.json(listDailyMetrics());
});

metricsRoutes.get("/llm-settings", (_req, res) => {
  res.json(getPublicLlmSettings());
});

metricsRoutes.patch("/llm-settings", (req, res) => {
  const parsed = llmSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid LLM settings payload", issues: parsed.error.issues });
    return;
  }

  res.json(updateLlmSettings(parsed.data));
});
