import cors from "cors";
import express from "express";
import { runClarifierAgent } from "./agents/clarifierAgent.js";
import { runPlannerAgent } from "./agents/plannerAgent.js";
import { runWorkflowStepAgent } from "./agents/workflowStepAgent.js";
import { env } from "./config/env.js";
import { llmRoutes } from "./routes/llmRoutes.js";
import { metricsRoutes } from "./routes/metricsRoutes.js";
import { repositoryRoutes } from "./routes/repositoryRoutes.js";
import { skillRoutes } from "./routes/skillRoutes.js";
import { templateRoutes } from "./routes/templateRoutes.js";
import { workflowRoutes } from "./routes/workflowRoutes.js";
import { workspaceRoutes } from "./routes/workspaceRoutes.js";
import { registerBuiltinSkills } from "./skills/builtin/index.js";
import { loadAndRegisterJsonSkills } from "./skills/jsonSkillLoader.js";
import { getSkillStepSpec } from "./skills/skillRegistry.js";
import { getCurrentWorkspace } from "./services/workspaceService.js";
import {
  verifyTrivialOutput,
  verifyClarification,
  verifyCodeGenerationPlan,
  verifyCodeReviewResult,
  verifyModuleMapping,
  verifyRepoWrite,
  verifySolutionDsl,
  verifyVerification,
} from "./services/stepVerifiers.js";
import { buildRuntimeMemoryContext } from "./services/workflowMemory.js";
import { registerBuiltinTemplates } from "./workflowTemplates/templateRegistry.js";
import type { WorkflowRun, WorkflowStepId, StepRun } from "./domain/workflow.js";
import { registerDefaultStepResolvers } from "./workflowExecution/stepResolverRegistry.js";
import { registerDefaultStepVerifiers } from "./workflowExecution/verifierRegistry.js";

export function createApp() {
  // 启动时注册：1. 内置 TS Skill → 2. JSON Skill → 3. WorkflowTemplate
  //              4. Step Resolvers → 5. Step Verifiers
  registerBuiltinSkills();
  loadAndRegisterJsonSkills();
  registerBuiltinTemplates();

  // 注册 default 7 步 resolver（repo_write 仅保留 legacy 兼容）
  registerDefaultStepResolvers({
    runClarifierAgent,
    runPlannerAgent,
    runWorkflowStepAgent,
    getStepOutput: <T>(run: WorkflowRun, stepId: WorkflowStepId) => {
      const output = run.steps.find((s: StepRun) => s.id === stepId)?.output;
      if (!output) throw new Error(`Step output not found: ${stepId}`);
      return output as T;
    },
    buildRuntimeMemoryContext,
    resolveSkillStepSpec: (run: WorkflowRun, stepId: WorkflowStepId) => getSkillStepSpec(run, stepId, getCurrentWorkspace() ?? undefined),
  });

  // 注册 default 7 步 verifier（repo_write 仅保留 legacy 兼容）
  registerDefaultStepVerifiers({
    verifyClarification,
    verifySolutionDsl,
    verifyModuleMapping,
    verifyCodeGenerationPlan,
    verifyCodeReviewResult,
    verifyRepoWrite,
    verifyVerification,
    verifyTrivialOutput,
  });

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
  app.use("/api/llm", llmRoutes);
  app.use("/api/metrics", metricsRoutes);
  app.use("/api/skills", skillRoutes);
  app.use("/api/templates", templateRoutes);

  return app;
}
