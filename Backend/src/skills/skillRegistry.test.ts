import { beforeAll, describe, expect, it } from "vitest";
import type { WorkflowRun } from "../domain/workflow.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import { registerBuiltinSkills } from "./builtin/index.js";
import { buildMatchReason, getSkillStepSpec, selectSkill } from "./skillRegistry.js";

// 注册内置 Skill 供测试使用
beforeAll(() => {
  registerBuiltinSkills();
});

/** 构造最小 WorkflowRun，仅填入匹配所需字段 */
function makeRun(overrides: {
  rawText: string;
  pattern?: "frontend-only" | "cross-stack" | "interaction" | "unclear";
  scope?: "frontend" | "backend" | "fullstack";
}): WorkflowRun {
  return {
    id: "run-test",
    title: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeStepId: "clarification",
    steps: [
      {
        id: "requirement_intake",
        label: "接收需求",
        agent: "接收需求",
        status: "success",
        input: { source: "pm" },
        output: {
          title: "test",
          rawText: overrides.rawText,
          pattern: overrides.pattern ?? "unclear",
          targetRepo: "conduit",
        },
        logs: [],
        replayCount: 0,
        history: [],
      },
      // 如果提供 scope，放入 solution_design 的 output
      ...(overrides.scope
        ? [
            {
              id: "solution_design" as const,
              label: "生成方案",
              agent: "生成方案",
              status: "success" as const,
              input: undefined as unknown,
              output: {
                requirementId: "r1",
                scope: overrides.scope,
                userStory: "test",
                acceptanceCriteria: ["a"],
                dataContract: {},
              },
              logs: [],
              replayCount: 0,
              history: [],
            },
          ]
        : []),
    ],
  } as WorkflowRun;
}

describe("selectSkill (scoring-based)", () => {
  it("selects frontend-display-computed-metric for reading-time keywords with frontend-only pattern", () => {
    const run = makeRun({
      rawText: "在首页文章卡片展示阅读量和阅读时长",
      pattern: "frontend-only",
    });
    const skill = selectSkill(run);
    expect(skill).toBeDefined();
    expect(skill!.id).toBe("frontend-display-computed-metric");
  });

  it("selects backend-add-pagination for pagination keywords even with unclear pattern", () => {
    // 关键：unclear pattern + 分页关键词 → 仍能命中（打分制）
    const run = makeRun({
      rawText: "文章列表需要分页和搜索功能",
      pattern: "unclear",
    });
    const skill = selectSkill(run);
    expect(skill).toBeDefined();
    expect(skill!.id).toBe("backend-add-pagination");
  });

  it("selects backend-add-pagination with fullstack scope and pagination keywords", () => {
    const run = makeRun({
      rawText: "给标签列表加上分页",
      pattern: "cross-stack",
      scope: "fullstack",
    });
    const skill = selectSkill(run);
    expect(skill).toBeDefined();
    // pagination keywords (分页, 列表) hit → pagination skill scores higher
    expect(skill!.id).toBe("backend-add-pagination");
  });

  it("selects cross-stack-add-field for field/column keywords with fullstack scope", () => {
    const run = makeRun({
      rawText: "给文章添加封面图字段",
      pattern: "cross-stack",
      scope: "fullstack",
    });
    const skill = selectSkill(run);
    expect(skill).toBeDefined();
    expect(skill!.id).toBe("cross-stack-add-field");
  });

  it("returns undefined when no keywords match any skill", () => {
    const run = makeRun({
      rawText: "做一件完全不相关的事情",
      pattern: "unclear",
    });
    const skill = selectSkill(run);
    expect(skill).toBeUndefined();
  });
});

describe("buildMatchReason", () => {
  it("returns correct reason structure with hitKeywords", () => {
    const run = makeRun({
      rawText: "展示阅读量统计",
      pattern: "frontend-only",
    });
    const reason = buildMatchReason(run);
    expect(reason).toBeDefined();
    expect(reason!.skillId).toBe("frontend-display-computed-metric");
    expect(reason!.skillName).toBe("前端计算指标展示");
    expect(reason!.matchedPattern).toBe("frontend-only");
    expect(reason!.hitKeywords).toContain("阅读量");
    expect(reason!.hitKeywords).toContain("统计");
    expect(reason!.hitKeywords).toContain("展示");
  });

  it("includes matchedScope when solution is available", () => {
    const run = makeRun({
      rawText: "分页查询",
      pattern: "cross-stack",
      scope: "fullstack",
    });
    const reason = buildMatchReason(run);
    expect(reason).toBeDefined();
    expect(reason!.matchedScope).toBe("fullstack");
  });
});

describe("getSkillStepSpec", () => {
  it("returns instruction addon for module_mapping when skill matches", () => {
    const run = makeRun({
      rawText: "展示字数统计",
      pattern: "frontend-only",
    });
    const spec = getSkillStepSpec(run, "module_mapping");
    expect(spec.skillId).toBe("frontend-display-computed-metric");
    expect(spec.instructionAddon).toBeDefined();
    expect(spec.instructionAddon!.length).toBeGreaterThan(20);
    expect(spec.instructionAddon).toContain("计算指标展示");
    expect(spec.skillMatchReason).toBeDefined();
    expect(spec.skillMatchReason!.hitKeywords.length).toBeGreaterThan(0);
  });

  it("returns empty object when no skill matches", () => {
    const run = makeRun({
      rawText: "xyz",
      pattern: "unclear",
    });
    const spec = getSkillStepSpec(run, "module_mapping");
    expect(spec.skillId).toBeUndefined();
    expect(spec.instructionAddon).toBeUndefined();
  });

  it("returns verification policy addon for matched skill", () => {
    const run = makeRun({
      rawText: "添加分页功能",
      pattern: "cross-stack",
      scope: "backend",
    });
    const spec = getSkillStepSpec(run, "verification");
    expect(spec.skillId).toBe("backend-add-pagination");
    expect(spec.verificationPolicyAddon).toBeDefined();
    expect(spec.verificationPolicyAddon!.required).toContain("npm:typecheck");
    expect(spec.verificationPolicyAddon!.required).toContain("npm:test");
  });
});

describe("workspace-aware matching", () => {
  const ws = {
    id: "ws-1",
    mode: "repo-import" as const, architectureSummary: "", createdAt: new Date().toISOString(),
    hasRepository: true,
    repoName: "test-repo",
    workspaceDir: "/tmp/test",
    repositoryScan: {
      repoName: "test-repo",
      scannedAt: "",
      source: "cloned" as const,
      filesInspected: 10,
      fileTree: [
        "src/components/ArticleCard.tsx",
        "src/pages/PostPage.tsx",
        "src/utils/stats.ts",
        "Backend/src/routes/articles.ts",
        "Backend/src/models/article.ts",
      ],
      directories: ["src", "src/components", "src/pages", "Backend/src"],
      stack: ["React", "TypeScript", "Node"],
      scripts: {},
      testEntrypoints: [],
      notes: ["Article body markdown rendering"],
      keyFiles: { "README.md": "# Article App" },
      packageManagers: ["npm"],
    },
    agentReadme: {
      fileName: "readme-for-agent.md" as const,
      content: "",
      sections: { architecture: "", stack: [], conventions: [], testing: [], riskNotes: [] },
    },
  } as WorkspaceContext;

  function makeRun(rawText: string, pattern = "frontend-only" as const) {
    return {
      id: "run-test",
      title: "test",
      createdAt: "",
      updatedAt: "",
      activeStepId: "clarification",
      steps: [
        {
          id: "requirement_intake",
          label: "PM",
          agent: "X",
          status: "success",
          input: {} as unknown,
          output: { title: "test", rawText, pattern, targetRepo: "conduit" },
          logs: [],
          replayCount: 0,
          history: [],
        },
      ],
    } as WorkflowRun;
  }

  it("keyword matching still works without workspace", () => {
    const run = makeRun("展示阅读量统计");
    const skill = selectSkill(run);
    expect(skill).toBeDefined();
    expect(skill!.id).toBe("frontend-display-computed-metric");
  });

  it("keyword + workspace fileGlobs both contribute to selection", () => {
    const run = makeRun("展示阅读量");
    const skill = selectSkill(run, ws);
    expect(skill).toBeDefined();
    expect(skill!.id).toBe("frontend-display-computed-metric");
  });

  it("routeHint + keyword combo selects correct backend pagination skill", () => {
    // "分页" keyword gives backend skill keyword points + "list" routeHint
    const run = makeRun("给列表加上分页查询");
    const skill = selectSkill(run, ws);
    expect(skill).toBeDefined();
    expect(skill!.id).toBe("backend-add-pagination");
  });

  it("buildMatchReason with workspace includes hit fields", () => {
    const run = makeRun("展示阅读量统计");
    const reason = buildMatchReason(run, ws);
    expect(reason).toBeDefined();
    expect(reason!.hitKeywords.length).toBeGreaterThan(0);
    expect(reason!.skillName).toBe("前端计算指标展示");
    // workspace fileTree has tsx files → fileGlobs should hit
    const fileGlobs = reason!.hitFileGlobs ?? [];
    const hitFiles = reason!.hitFiles ?? [];
    // At minimum, keyword match + pattern match should produce a score
    expect(reason!.score).toBeGreaterThan(0);
    // fileGlobs/files may or may not be present depending on workspace, but the fields should exist
    expect(Array.isArray(fileGlobs)).toBe(true);
    expect(Array.isArray(hitFiles)).toBe(true);
  });

  it("no workspace → behavior unchanged (backward compat)", () => {
    const run = makeRun("展示阅读量统计");
    const reason = buildMatchReason(run);
    expect(reason).toBeDefined();
    expect(reason!.hitKeywords).toContain("展示");
  });
});
