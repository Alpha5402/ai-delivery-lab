import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { metricsRoutes } from "./routes/metricsRoutes.js";
import { repositoryRoutes } from "./routes/repositoryRoutes.js";
import { workflowRoutes } from "./routes/workflowRoutes.js";
import { workspaceRoutes } from "./routes/workspaceRoutes.js";

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "super-individual-backend",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/workspaces", workspaceRoutes);
  app.use("/api/workflows", workflowRoutes);
  app.use("/api/repository", repositoryRoutes);
  app.use("/api/metrics", metricsRoutes);

  return app;
}
