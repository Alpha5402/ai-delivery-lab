import { Router } from "express";
import { listMetrics } from "../services/metricsService.js";

export const metricsRoutes = Router();

metricsRoutes.get("/", (_req, res) => {
  res.json(listMetrics());
});

