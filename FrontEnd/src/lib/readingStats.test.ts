import { describe, expect, it } from "vitest";
import { calculateReadingStats } from "./readingStats";

describe("calculateReadingStats", () => {
  it("counts Chinese characters", () => {
    expect(calculateReadingStats("这是一个测试")).toEqual({ wordCount: 6, readingMinutes: 1 });
  });

  it("counts English words", () => {
    expect(calculateReadingStats("Hello world from Workspace")).toEqual({ wordCount: 4, readingMinutes: 1 });
  });

  it("counts mixed Chinese and English content", () => {
    expect(calculateReadingStats("Workspace 文章 supports tags")).toEqual({ wordCount: 5, readingMinutes: 1 });
  });

  it("uses at least one minute for empty body", () => {
    expect(calculateReadingStats("   ")).toEqual({ wordCount: 0, readingMinutes: 1 });
  });

  it("rounds reading minutes up", () => {
    const body = Array.from({ length: 301 }, (_, index) => `word${index}`).join(" ");
    expect(calculateReadingStats(body).readingMinutes).toBe(2);
  });
});
