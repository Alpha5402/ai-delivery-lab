import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { metricsRoutes } from "./routes/metricsRoutes.js";
import { repositoryRoutes } from "./routes/repositoryRoutes.js";
import { skillRoutes } from "./routes/skillRoutes.js";
import { workflowRoutes } from "./routes/workflowRoutes.js";
import { workspaceRoutes } from "./routes/workspaceRoutes.js";
import { registerBuiltinSkills } from "./skills/builtin/index.js";
import { loadAndRegisterJsonSkills } from "./skills/jsonSkillLoader.js";
import { registerBuiltinTemplates } from "./workflowTemplates/templateRegistry.js";

export function createApp() {
  // 启动时注册：1. 内置 TS Skill → 2. JSON Skill → 3. WorkflowTemplate
  registerBuiltinSkills();
  loadAndRegisterJsonSkills();
  registerBuiltinTemplates();

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
  app.use("/api/skills", skillRoutes);

  return app;
}
