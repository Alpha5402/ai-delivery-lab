import { describe, expect, it } from "vitest";
import { globToRegex, matchFileGlobs, matchRouteHints } from "./globMatcher.js";

describe("globToRegex", () => {
  it("matches exact file", () => {
    const re = globToRegex("src/App.tsx");
    expect(re.test("src/App.tsx")).toBe(true);
    expect(re.test("src/Other.tsx")).toBe(false);
  });

  it("* matches single segment", () => {
    const re = globToRegex("src/**/*.tsx");
    expect(re.test("src/routes/PostPage/PostPage.tsx")).toBe(true);
    expect(re.test("src/components/Button.tsx")).toBe(true);
  });

  it("** matches across directories", () => {
    const re = globToRegex("**/package.json");
    expect(re.test("Backend/package.json")).toBe(true);
    expect(re.test("package.json")).toBe(true);
    expect(re.test("src/package.json")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    const re = globToRegex("src/**/*.tsx");
    expect(re.test("tests/foo.test.ts")).toBe(false);
    expect(re.test("README.md")).toBe(false);
  });

  it("handles multiple **", () => {
    const re = globToRegex("**/routes/**");
    expect(re.test("src/routes/api/users.ts")).toBe(true);
    expect(re.test("routes/index.ts")).toBe(true);
  });
});

describe("matchFileGlobs", () => {
  it("returns matching patterns", () => {
    const hits = matchFileGlobs("src/routes/PostPage.tsx", ["src/**/*.tsx", "**/routes/**"]);
    expect(hits).toHaveLength(2);
  });

  it("returns empty for no match", () => {
    const hits = matchFileGlobs("README.md", ["src/**/*.tsx"]);
    expect(hits).toHaveLength(0);
  });
});

describe("matchRouteHints", () => {
  it("finds hints in fileTree paths", () => {
    const hits = matchRouteHints(["Article", "page"], {
      fileTree: ["src/pages/ArticlePage.tsx", "src/pages/HomePage.tsx"],
    });
    expect(hits).toContain("Article");
    expect(hits).toContain("page");
  });

  it("finds hints in textCorpus", () => {
    const hits = matchRouteHints(["markdown"], {
      textCorpus: "renders markdown content in article body",
    });
    expect(hits).toContain("markdown");
  });

  it("finds hints in keyFileNames", () => {
    const hits = matchRouteHints(["GET"], {
      keyFileNames: ["routes.ts", "controllers.ts"],
      textCorpus: "GET /api/articles",
    });
    expect(hits).toContain("GET");
  });
});
