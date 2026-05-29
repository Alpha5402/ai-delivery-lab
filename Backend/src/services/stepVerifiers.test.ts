import { describe, expect, it } from "vitest";
import type {
  ClarificationOutput,
  CodeGenerationPlan,
  ModuleMapping,
  RepoWriteResult,
  SolutionDsl,
  VerificationResult,
} from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import {
  runStepVerifier,
  verifyClarification,
  verifyCodeGenerationPlan,
  verifyModuleMapping,
  verifyRepoWrite,
  verifySolutionDsl,
  verifyVerification,
} from "./stepVerifiers.js";

function makeWorkspace(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    id: "test-workspace",
    mode: "quick-project",
    hasRepository: false,
    repoName: "test-repo",
    architectureSummary: "",
    repositoryScan: {
      repoName: "test-repo",
      scannedAt: new Date().toISOString(),
      source: "quick-project",
      filesInspected: 3,
      fileTree: ["src/app.ts", "src/services/foo.ts", "package.json"],
      directories: ["src", "src/services"],
      packageManagers: ["npm"],
      scripts: { root: ["test"] },
      stack: ["TypeScript"],
      testEntrypoints: ["root: npm run test"],
      notes: [],
      keyFiles: {},
    },
    agentReadme: { fileName: "readme-for-agent.md", content: "", sections: { architecture: "", stack: [], conventions: [], testing: [], riskNotes: [] } },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("stepVerifiers", () => {
  describe("verifyClarification", () => {
    it("auto-continues when confidence and answers are sufficient", () => {
      const output: ClarificationOutput = {
        summary: "summary",
        confidence: 0.9,
        questions: [
          { id: "q1", question: "Q1", answer: "A1", riskIfUnanswered: "low" },
        ],
      };
      const result = verifyClarification(output);
      expect(result.qualityGate.decision).toBe("auto-continue");
    });

    it("requires repair when confidence is low (allows one follow-up)", () => {
      const output: ClarificationOutput = {
        summary: "summary",
        confidence: 0.4,
        questions: [
          { id: "q1", question: "Q1", answer: "A1", riskIfUnanswered: "low" },
        ],
      };
      const result = verifyClarification(output);
      expect(result.qualityGate.decision).toBe("repair");
      expect(result.checks.some((c) => c.id === "clarification.confidence" && c.status === "failed")).toBe(true);
    });

    it("flags high-risk unanswered questions (repair to allow follow-up)", () => {
      const output: ClarificationOutput = {
        summary: "summary",
        confidence: 0.95,
        questions: [
          { id: "q1", question: "Q1", answer: "", riskIfUnanswered: "data loss" },
        ],
      };
      const result = verifyClarification(output);
      expect(result.qualityGate.decision).toBe("repair");
    });
  });

  describe("verifySolutionDsl", () => {
    it("warns when acceptance criteria too short", () => {
      const output: SolutionDsl = {
        requirementId: "req-1",
        scope: "frontend",
        userStory: "user story",
        acceptanceCriteria: ["a", "b"],
        dataContract: {},
      };
      const result = verifySolutionDsl(output);
      expect(result.checks.some((c) => c.id === "solution.acceptance_criteria_length" && c.status === "warning")).toBe(true);
    });

    it("fails when acceptance criteria too few", () => {
      const output: SolutionDsl = {
        requirementId: "req-1",
        scope: "frontend",
        userStory: "user story",
        acceptanceCriteria: ["only one criterion that is fairly long"],
        dataContract: { foo: "bar" },
      };
      const result = verifySolutionDsl(output);
      expect(result.qualityGate.decision).toBe("need-human");
    });
  });

  describe("verifyModuleMapping", () => {
    it("auto-continues when all files exist in fileTree", () => {
      const output: ModuleMapping = {
        touchedModules: [
          { name: "App", reason: "main entry", files: ["src/app.ts"] },
        ],
        reusableSkill: "frontend-add-field",
      };
      const result = verifyModuleMapping(output, makeWorkspace());
      expect(result.qualityGate.decision).toBe("auto-continue");
    });

    it("fails (repair) when files missing without new declaration", () => {
      const output: ModuleMapping = {
        touchedModules: [
          { name: "Mystery", reason: "should modify", files: ["src/does-not-exist.ts"] },
        ],
        reusableSkill: "frontend-add-field",
      };
      const result = verifyModuleMapping(output, makeWorkspace());
      expect(result.qualityGate.decision).toBe("repair");
      expect(result.checks.find((c) => c.id === "module_mapping.missing_files")?.status).toBe("failed");
    });

    it("warns but allows new files when reason claims new", () => {
      const output: ModuleMapping = {
        touchedModules: [
          { name: "NewModule", reason: "新增模块", files: ["src/new.ts"] },
        ],
        reusableSkill: "frontend-add-field",
      };
      const result = verifyModuleMapping(output, makeWorkspace());
      // warnings only → auto-continue
      expect(result.qualityGate.decision).toBe("auto-continue");
    });
  });

  describe("verifyCodeGenerationPlan", () => {
    it("fails when tasks have no files", () => {
      const output: CodeGenerationPlan = {
        strategy: "incremental",
        tasks: [
          { id: "t1", title: "title", files: [], testRequired: true },
        ],
      };
      const result = verifyCodeGenerationPlan(output, makeWorkspace());
      expect(result.qualityGate.decision).toBe("repair");
    });

    it("flags suspicious paths as security failure", () => {
      const output: CodeGenerationPlan = {
        strategy: "incremental",
        tasks: [
          { id: "t1", title: "title", files: ["/etc/passwd"], testRequired: true },
        ],
      };
      const result = verifyCodeGenerationPlan(output, makeWorkspace());
      expect(result.checks.some((c) => c.type === "security" && c.status === "failed")).toBe(true);
    });
  });

  describe("verifyRepoWrite", () => {
    it("planned mode requires human", () => {
      const output: RepoWriteResult = {
        branch: "feat/x",
        mode: "planned",
        pendingChanges: [{ path: "src/app.ts", changeType: "modified", additions: 1, deletions: 0 }],
        appliedChanges: [],
        diffSummary: "",
        filesChanged: [],
      };
      const result = verifyRepoWrite(output, makeWorkspace());
      expect(result.qualityGate.decision).toBe("need-human");
    });

    it("applied mode fails when appliedChanges empty", () => {
      const output: RepoWriteResult = {
        branch: "feat/x",
        mode: "applied",
        pendingChanges: [],
        appliedChanges: [],
        diffSummary: "",
        filesChanged: [],
      };
      const result = verifyRepoWrite(output, makeWorkspace());
      expect(result.qualityGate.decision).toBe("need-human");
    });
  });

  describe("verifyVerification", () => {
    it("requires human when no real commands executed", () => {
      const output: VerificationResult = {
        lint: "not_executed",
        unitTests: "not_executed",
        build: "not_configured",
        typecheck: "not_configured",
        coverage: null,
        testSuites: [],
        commands: [],
        diagnosis: "",
      };
      const result = verifyVerification(output);
      expect(result.qualityGate.decision).toBe("need-human");
    });

    it("auto-continues when commands all passed", () => {
      const output: VerificationResult = {
        lint: "passed",
        unitTests: "passed",
        build: "not_configured",
        typecheck: "not_configured",
        coverage: null,
        testSuites: [],
        commands: [
          {
            label: "unit_tests",
            command: "npm test",
            cwd: "/tmp",
            exitCode: 0,
            durationMs: 100,
            status: "passed",
            stdoutPreview: "",
            stderrPreview: "",
          },
        ],
        diagnosis: "",
      };
      const result = verifyVerification(output);
      expect(result.qualityGate.decision).toBe("auto-continue");
    });

    it("triggers repair when a command failed", () => {
      const output: VerificationResult = {
        lint: "failed",
        unitTests: "passed",
        build: "not_configured",
        typecheck: "not_configured",
        coverage: null,
        testSuites: [],
        commands: [
          {
            label: "lint",
            command: "npm run lint",
            cwd: "/tmp",
            exitCode: 1,
            durationMs: 200,
            status: "failed",
            stdoutPreview: "",
            stderrPreview: "ESLint: parsing error",
          },
          {
            label: "unit_tests",
            command: "npm test",
            cwd: "/tmp",
            exitCode: 0,
            durationMs: 100,
            status: "passed",
            stdoutPreview: "",
            stderrPreview: "",
          },
        ],
        diagnosis: "",
      };
      const result = verifyVerification(output);
      expect(result.qualityGate.decision).toBe("repair");
    });
  });

  describe("runStepVerifier dispatcher", () => {
    it("returns trivial result when output undefined", () => {
      const result = runStepVerifier("requirement_intake", undefined);
      expect(result.qualityGate.decision).toBe("need-human");
    });

    it("falls back to trivial when workspace missing for module_mapping", () => {
      const output: ModuleMapping = {
        touchedModules: [],
        reusableSkill: "x",
      };
      const result = runStepVerifier("module_mapping", output);
      expect(result.qualityGate.decision).toBe("auto-continue");
    });
  });
});
