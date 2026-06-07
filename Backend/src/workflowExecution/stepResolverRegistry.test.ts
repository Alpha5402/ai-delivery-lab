import { beforeEach, describe, expect, it } from "vitest";
import type { RequirementDraft } from "../domain/workflow.js";
import {
  registerDefaultStepResolvers,
  resolveRegisteredStepOutput,
} from "./stepResolverRegistry.js";

function makeRun() {
  return {
    id: "run-test",
    title: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeStepId: "clarification" as const,
    steps: [
      {
        id: "requirement_intake" as const,
        label: "PM Input",
        agent: "Composer",
        status: "success" as const,
        input: { source: "pm" },
        output: { title: "test", rawText: "test", pattern: "frontend-only" as const, targetRepo: "conduit" as const },
        logs: [],
        replayCount: 0,
        history: [],
      },
      {
        id: "clarification" as const,
        label: "Clarifier",
        agent: "确认需求",
        status: "idle" as const,
        input: undefined as unknown,
        output: undefined,
        logs: [],
        replayCount: 0,
        history: [],
      },
    ],
  };
}

describe("stepResolverRegistry", () => {
  beforeEach(() => {
    registerDefaultStepResolvers({
      runClarifierAgent: async (_req: unknown, _followUp?: unknown) => ({
        summary: "clarified",
        decisions: [],
        questions: [],
        clarificationComplete: false,
        confidence: 0.9,
      }),
      runPlannerAgent: async (_req: unknown, _clarification: unknown, _context?: unknown) => ({
        requirementId: "r1",
        scope: "frontend",
        userStory: "test",
        acceptanceCriteria: ["a"],
        dataContract: {},
      }),
      runWorkflowStepAgent: async (_stepId: unknown, _run: unknown) => ({
        runtimeTrace: { runtime: "simple-agent-runtime", workspaceId: "w1", observations: [], toolCalls: [] },
      }),
      getStepOutput: <T>(run: unknown, stepId: string) => {
        const r = run as { steps: Array<{ id: string; output?: unknown }> };
        const output = r.steps.find((s: { id: string }) => s.id === stepId)?.output;
        if (!output) throw new Error(`Step output not found: ${stepId}`);
        return output as T;
      },
      buildRuntimeMemoryContext: () => ({
        currentStepMemory: [],
        upstreamMemory: [],
        allUserDecisions: [],
        summary: "",
      }),
    });
  });

  it("returns null for unregistered step", async () => {
    const result = await resolveRegisteredStepOutput({
      run: makeRun(),
      stepId: "nonexistent" as never,
    });
    expect(result).toBeNull();
  });

  it("resolves requirement_intake from step output", async () => {
    const result = await resolveRegisteredStepOutput({
      run: makeRun(),
      stepId: "requirement_intake",
    });
    expect(result).not.toBeNull();
    const r = result as RequirementDraft;
    expect(r.title).toBe("test");
  });

  it("resolves clarification via agent", async () => {
    const result = await resolveRegisteredStepOutput({
      run: makeRun(),
      stepId: "clarification",
    });
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).summary).toBe("clarified");
  });

  it("resolves generic step via runWorkflowStepAgent", async () => {
    const run = makeRun();
    const result = await resolveRegisteredStepOutput({
      run,
      stepId: "module_mapping",
    });
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).runtimeTrace).toBeDefined();
  });
});
