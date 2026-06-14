import { z } from "zod";

export const workspaceModeSchema = z.enum(["repo-import", "quick-project"]);

export const importWorkspaceSchema = z.object({
  repoUrl: z.string().min(1),
});

export const openWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
});

export const quickProjectSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  stackPreference: z.enum(["react-node", "react-only", "undecided"]).default("react-node"),
});

export type WorkspaceMode = z.infer<typeof workspaceModeSchema>;
export type ImportWorkspaceInput = z.infer<typeof importWorkspaceSchema>;
export type QuickProjectInput = z.infer<typeof quickProjectSchema>;
export type OpenWorkspaceInput = z.infer<typeof openWorkspaceSchema>;

export type AgentReadmeResult = {
  fileName: "readme-for-agent.md";
  content: string;
  sections: {
    architecture: string;
    stack: string[];
    conventions: string[];
    testing: string[];
    riskNotes: string[];
  };
};

export type RepositoryScanResult = {
  repoUrl?: string;
  repoPath?: string;
  repoName: string;
  scannedAt: string;
  source: "cloned" | "local" | "quick-project";
  filesInspected: number;
  fileTree: string[];
  directories: string[];
  packageManagers: string[];
  scripts: Record<string, string[]>;
  stack: string[];
  testEntrypoints: string[];
  notes: string[];
  keyFiles: Record<string, string>;
};

export type WorkspaceContext = {
  id: string;
  mode: WorkspaceMode;
  hasRepository: boolean;
  repoUrl?: string;
  workspaceDir?: string;
  repoName: string;
  architectureSummary: string;
  repositoryScan: RepositoryScanResult;
  agentReadme: AgentReadmeResult;
  createdAt: string;
};

export type VerificationCommandSetting = {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
};

export type ProjectSkillSetting = {
  id: string;
  baseSkillId?: string;
  enabled: boolean;
  name?: string;
  description?: string;
  version?: string;
  requirementPatterns?: string[];
  scopes?: string[];
  match?: {
    keywords?: string[];
    fileGlobs?: string[];
    routeHints?: string[];
  };
  steps?: Record<string, unknown>;
};

export type ProjectSettings = {
  projectId: string;
  verificationCommands: VerificationCommandSetting[];
  stepExecutionModes: Record<string, "automatic" | "manual-confirmation">;
  selectedLlmModelId?: string;
  excludedPublicSkillIds: string[];
  projectSkills: ProjectSkillSetting[];
  updatedAt: string;
};

export type WorkspaceSummary = {
  id: string;
  repoName: string;
  mode: WorkspaceMode;
  hasRepository: boolean;
  repoUrl?: string;
  workspaceDir?: string;
  source: RepositoryScanResult["source"];
  filesInspected: number;
  stack: string[];
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};

export type WorkflowRunSummary = {
  id: string;
  title: string;
  requirement: string;
  status: "running" | "paused" | "success" | "failed";
  currentStep?: string;
  createdAt: string;
  updatedAt: string;
  caseId?: string;
  caseFavorited?: boolean;
};

export type ProjectWorkspace = WorkspaceSummary & {
  name: string;
  path: string;
  workflowRuns: WorkflowRunSummary[];
};

export type RequirementCase = {
  id: string;
  projectId: string;
  workspaceId: string;
  createdFromRunId: string;
  title: string;
  rawRequirement: string;
  requirementPattern: string;
  requirementSummary: string;
  acceptedConstraints: string[];
  solutionSummary: string;
  touchedFiles: string[];
  codeTasks: string[];
  verificationSummary: string;
  pullRequestUrl?: string;
  tags: string[];
  stack: string[];
  keywords: string[];
  embeddingText?: string;
  embedding?: number[];
  embeddingModel?: string;
  embeddingUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RecalledRequirementCase = {
  id: string;
  title: string;
  summary: string;
  matchedReasons: string[];
  score: number;
  ruleScore?: number;
  embeddingScore?: number;
  touchedFiles: string[];
  createdFromRunId: string;
};
