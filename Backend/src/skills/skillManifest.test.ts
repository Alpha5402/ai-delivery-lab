import { describe, expect, it } from "vitest";
import { skillManifestSchema } from "./skillTypes.js";

const VALID_SKILL = {
  id: "test-skill",
  name: "Test Skill",
  version: "1.0.0",
  requirementPatterns: ["frontend-only"],
  scopes: ["frontend"],
  match: { keywords: ["test"] },
  steps: {
    module_mapping: {
      instructionAddon: "focus on UI components",
    },
  },
};

describe("skillManifestSchema", () => {
  it("accepts valid skill JSON", () => {
    expect(() => skillManifestSchema.parse(VALID_SKILL)).not.toThrow();
  });

  it("rejects empty id", () => {
    expect(() => skillManifestSchema.parse({ ...VALID_SKILL, id: "" })).toThrow();
  });

  it("rejects empty name", () => {
    expect(() => skillManifestSchema.parse({ ...VALID_SKILL, name: "" })).toThrow();
  });

  it("rejects unknown requirementPattern", () => {
    expect(() =>
      skillManifestSchema.parse({ ...VALID_SKILL, requirementPatterns: ["unknown-mode"] }),
    ).toThrow();
  });

  it("rejects unknown scope", () => {
    expect(() =>
      skillManifestSchema.parse({ ...VALID_SKILL, scopes: ["mobile"] }),
    ).toThrow();
  });

  it("rejects unknown step id", () => {
    expect(() =>
      skillManifestSchema.parse({
        ...VALID_SKILL,
        steps: { not_a_step: { instructionAddon: "x" } },
      }),
    ).toThrow();
  });

  it("accepts skill without steps", () => {
    const parsed = skillManifestSchema.parse({ ...VALID_SKILL, steps: undefined });
    expect(parsed.id).toBe("test-skill");
  });
});

describe("confirmationPolicyAddon schema", () => {
  const SKILL_WITH_CONFIRM = {
    ...VALID_SKILL,
    steps: {
      verification: {
        instructionAddon: "verify boundaries",
        confirmationPolicyAddon: {
          mode: "force-manual",
          reason: "safety critical",
          requireHumanWhen: ["writes-files"],
          confidenceFloor: 0.85,
        },
      },
    },
  };

  it("accepts valid confirmationPolicyAddon", () => {
    expect(() => skillManifestSchema.parse(SKILL_WITH_CONFIRM)).not.toThrow();
  });

  it("rejects invalid confirmation mode", () => {
    const invalid = JSON.parse(JSON.stringify(SKILL_WITH_CONFIRM));
    invalid.steps.verification.confirmationPolicyAddon.mode = "invalid-mode";
    expect(() => skillManifestSchema.parse(invalid)).toThrow();
  });

  it("rejects confidenceFloor out of range", () => {
    const invalid = JSON.parse(JSON.stringify(SKILL_WITH_CONFIRM));
    invalid.steps.verification.confirmationPolicyAddon.confidenceFloor = 2;
    expect(() => skillManifestSchema.parse(invalid)).toThrow();
  });

  it("accepts confirmationPolicyAddon with only reason", () => {
    const minimal = {
      ...VALID_SKILL,
      steps: {
        module_mapping: {
          instructionAddon: "x",
          confirmationPolicyAddon: { reason: "just a note" },
        },
      },
    };
    expect(() => skillManifestSchema.parse(minimal)).not.toThrow();
  });
});
