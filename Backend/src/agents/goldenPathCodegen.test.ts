import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "../domain/workflow.js";
import { tryGoldenPathCodegen } from "./goldenPathCodegen.js";

function makeRun(rawText: string): WorkflowRun {
  return {
    id: "run-test",
    title: rawText,
    createdAt: "",
    updatedAt: "",
    activeStepId: "code_generation",
    steps: [
      {
        id: "requirement_intake",
        label: "PM",
        agent: "X",
        status: "success",
        input: {} as unknown,
        output: { title: rawText, rawText, pattern: "frontend-only" as const, targetRepo: "conduit" as const },
        logs: [],
        replayCount: 0,
        history: [],
      },
    ],
  };
}

describe("tryGoldenPathCodegen", () => {
  it("returns patches for word count + reading time demand", () => {
    const plan = tryGoldenPathCodegen(makeRun("在文章详情页正文下方展示字数统计和预计阅读时间"));
    expect(plan).not.toBeNull();
    expect(plan!.patches).toBeDefined();
    expect(plan!.patches!.length).toBeGreaterThanOrEqual(1);
    expect(plan!.patches![0].path).toBe("frontend/src/routes/Article/Article.jsx");
    expect(plan!.patches![0].changeType).toBe("modified");
    expect(plan!.patches![0].content).toContain("countWords");
    expect(plan!.patches![0].content).toContain("estimateReadingTime");
  });

  it("returns null when target file not in workspace", () => {
    const plan = tryGoldenPathCodegen(
      makeRun("文章详情页字数统计"),
      { repositoryScan: { fileTree: ["src/App.tsx", "src/Other.jsx"] } },
    );
    expect(plan).toBeNull();
  });

  it("returns patches when target file exists in workspace", () => {
    const plan = tryGoldenPathCodegen(
      makeRun("文章详情页字数统计"),
      { repositoryScan: { fileTree: ["frontend/src/routes/Article/Article.jsx"] } },
    );
    expect(plan).not.toBeNull();
  });

  it("returns null for unrelated demand", () => {
    const plan = tryGoldenPathCodegen(makeRun("添加用户登录功能"));
    expect(plan).toBeNull();
  });

  it("patches have no absolute paths or .. traversal", () => {
    const plan = tryGoldenPathCodegen(makeRun("文章详情页展示字数统计"));
    expect(plan).not.toBeNull();
    for (const p of plan!.patches!) {
      expect(p.path).not.toContain("..");
      expect(p.path).not.toMatch(/^[A-Z]:[\\/]/); // no absolute Windows
      expect(p.path).not.toMatch(/^\//); // no absolute Unix
    }
  });
});
