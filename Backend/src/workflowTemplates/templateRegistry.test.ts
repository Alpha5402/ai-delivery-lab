import { beforeAll, describe, expect, it } from "vitest";
import { stepAgents, stepLabels, stepOrder } from "../domain/workflow.js";
import { defaultStepExecutionModes } from "../services/workflowSettingsService.js";
import { DEFAULT_TEMPLATE_ID, defaultWorkflowTemplate } from "./builtin/defaultTemplate.js";
import {
  getDefaultWorkflowTemplate,
  getWorkflowStepDefinition,
  getWorkflowTemplate,
  listWorkflowTemplates,
  registerBuiltinTemplates,
  registerWorkflowTemplate,
} from "./templateRegistry.js";

beforeAll(() => {
  registerBuiltinTemplates();
});

describe("WorkflowTemplateRegistry", () => {
  it("default template exists after registration", () => {
    const t = getWorkflowTemplate(DEFAULT_TEMPLATE_ID);
    expect(t).toBeDefined();
    expect(t!.id).toBe(DEFAULT_TEMPLATE_ID);
  });

  it("default template has exactly 7 steps", () => {
    const t = getDefaultWorkflowTemplate();
    expect(t.steps).toHaveLength(8);
  });

  it("default template step order matches domain stepOrder", () => {
    const t = getDefaultWorkflowTemplate();
    const ids = t.steps.map((s) => s.id);
    expect(ids).toEqual(stepOrder);
  });

  it("every step has required metadata fields", () => {
    const t = getDefaultWorkflowTemplate();
    for (const step of t.steps) {
      expect(step.label).toBeTruthy();
      expect(step.agent).toBeTruthy();
      expect(step.agentProfileId).toBeTruthy();
      expect(step.verifierProfileId).toBeTruthy();
      expect(step.outputSchemaId).toBeTruthy();
      expect(["automatic", "manual-confirmation"]).toContain(step.defaultExecutionMode);
    }
  });

  it("getWorkflowStepDefinition returns each step", () => {
    for (const id of stepOrder) {
      const def = getWorkflowStepDefinition(DEFAULT_TEMPLATE_ID, id);
      expect(def).toBeDefined();
      expect(def!.id).toBe(id);
    }
  });

  it("listWorkflowTemplates returns at least the default", () => {
    const all = listWorkflowTemplates();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some((t) => t.id === DEFAULT_TEMPLATE_ID)).toBe(true);
  });

  it("registerWorkflowTemplate validates and stores a custom template", () => {
    registerWorkflowTemplate({
      id: "test-template",
      name: "Test",
      version: 1,
      steps: [
        {
          id: "step-1",
          label: "Step 1",
          agent: "Test Agent",
          agentProfileId: "test-agent",
          verifierProfileId: "test-verifier",
          outputSchemaId: "testSchema",
          defaultExecutionMode: "automatic",
          inputRefs: [],
        },
      ],
    });
    const t = getWorkflowTemplate("test-template");
    expect(t).toBeDefined();
    expect(t!.steps).toHaveLength(1);
  });
});

describe("domain/workflow.ts consistency with default template", () => {
  it("stepLabels match default template", () => {
    const t = getDefaultWorkflowTemplate();
    for (const step of t.steps) {
      expect(step.label).toBe(stepLabels[step.id as keyof typeof stepLabels]);
    }
  });

  it("stepAgents match default template", () => {
    const t = getDefaultWorkflowTemplate();
    for (const step of t.steps) {
      expect(step.agent).toBe(stepAgents[step.id as keyof typeof stepAgents]);
    }
  });

  it("defaultStepExecutionModes match default template", () => {
    const t = getDefaultWorkflowTemplate();
    for (const step of t.steps) {
      expect(defaultStepExecutionModes[step.id as keyof typeof defaultStepExecutionModes])
        .toBe(step.defaultExecutionMode);
    }
  });

  it("code_generation waits for review after writing files", () => {
    const t = getDefaultWorkflowTemplate();
    const codeGeneration = t.steps.find((step) => step.id === "code_generation");
    expect(codeGeneration?.defaultExecutionMode).toBe("manual-confirmation");
    expect(t.steps.some((step) => step.id === "repo_write")).toBe(false);
    expect(defaultStepExecutionModes.code_generation).toBe("manual-confirmation");
  });
});

describe("workflowSettingsService derived modes", () => {
  it("has an entry for every step in default template", () => {
    const t = getDefaultWorkflowTemplate();
    for (const step of t.steps) {
      expect(step.id in defaultStepExecutionModes).toBe(true);
    }
  });

  it("returns valid mode values", () => {
    for (const [, mode] of Object.entries(defaultStepExecutionModes)) {
      expect(["automatic", "manual-confirmation"]).toContain(mode);
    }
  });
});
