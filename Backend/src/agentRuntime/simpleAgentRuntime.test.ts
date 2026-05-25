import { describe, expect, it } from "vitest";
import { selectInitialReadFiles } from "./simpleAgentRuntime.js";

describe("selectInitialReadFiles", () => {
  it("prioritizes repository guide, entrypoints, routes, controllers, and models", () => {
    expect(selectInitialReadFiles([
      "frontend/src/styles.css",
      "backend/models/user.js",
      "frontend/src/App.jsx",
      "README.md",
      "backend/controllers/articles.js",
      "backend/routes/index.js",
      "backend/helper/jwt.js",
      "package.json",
    ])).toEqual([
      "README.md",
      "package.json",
      "frontend/src/App.jsx",
      "backend/routes/index.js",
      "backend/controllers/articles.js",
      "backend/models/user.js",
    ]);
  });

  it("limits initial file reads", () => {
    expect(selectInitialReadFiles([
      "README.md",
      "package.json",
      "src/App.tsx",
      "src/main.tsx",
      "src/routes/index.ts",
      "src/services/api.ts",
      "src/extra.ts",
    ])).toHaveLength(6);
  });
});

