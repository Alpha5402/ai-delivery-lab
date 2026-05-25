import { describe, expect, it } from "vitest";
import type { RepositoryScanResult } from "../domain/workspace.js";
import { buildRepositoryContextMessages } from "./repositoryContextAgent.js";

describe("buildRepositoryContextMessages", () => {
  it("asks the model to write Chinese architecture-first repository context", () => {
    const scan: RepositoryScanResult = {
      repoName: "conduit-realworld-example-app",
      scannedAt: "2026-05-24T00:00:00.000Z",
      source: "cloned",
      filesInspected: 4,
      fileTree: [
        "backend/controllers/articles.js",
        "backend/models/article.js",
        "frontend/src/App.jsx",
        "frontend/src/services/api.js",
      ],
      directories: ["backend", "frontend"],
      packageManagers: ["npm"],
      scripts: { root: ["dev", "test"] },
      stack: ["React", "Express", "Sequelize"],
      testEntrypoints: ["root: npm run test"],
      notes: ["README.md exists and should be read before code generation."],
      keyFiles: {
        "backend/controllers/articles.js": "exports.listArticles = async () => {};",
        "frontend/src/App.jsx": "export default function App() { return null; }",
      },
    };

    const messages = buildRepositoryContextMessages("conduit-realworld-example-app", scan);
    const systemPrompt = messages[0].content;
    const userPayload = JSON.parse(messages[1].content) as {
      scan: RepositoryScanResult;
      outputLanguage: string;
      focus: string[];
      avoidOverFocusingOn: string[];
    };

    expect(systemPrompt).toContain("你必须使用中文输出");
    expect(systemPrompt).toContain("目录结构、模块边界、核心运行原理");
    expect(systemPrompt).toContain("不要把 readme-for-agent.md 写成启动手册");
    expect(systemPrompt).toContain("sections 必须是 object，不是 array");
    expect(userPayload.outputLanguage).toBe("zh-CN");
    expect(userPayload.focus).toEqual(expect.arrayContaining(["目录结构", "模块边界", "核心运行原理"]));
    expect(userPayload.avoidOverFocusingOn).toEqual(expect.arrayContaining(["启动命令"]));
    expect(userPayload.scan.fileTree).toEqual(scan.fileTree);
    expect(userPayload.scan.keyFiles).toEqual(scan.keyFiles);
  });
});
