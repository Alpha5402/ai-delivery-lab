import { describe, expect, it } from "vitest";
import { formatDuration, formatTokenCount } from "./formatters";

describe("formatTokenCount", () => {
  it("keeps small token counts as raw numbers", () => {
    expect(formatTokenCount(1023)).toBe("1023");
  });

  it("uses binary K and M units", () => {
    expect(formatTokenCount(1024)).toBe("1K");
    expect(formatTokenCount(1536)).toBe("1.5K");
    expect(formatTokenCount(1_048_576)).toBe("1M");
    expect(formatTokenCount(2_621_440)).toBe("2.5M");
  });
});

describe("formatDuration", () => {
  it("keeps sub-second durations in ms", () => {
    expect(formatDuration(301)).toBe("301ms");
  });

  it("formats short durations in seconds", () => {
    expect(formatDuration(17_500)).toBe("17.5 s");
  });

  it("formats minute and hour durations as parts", () => {
    expect(formatDuration(301_000)).toBe("5 min 1 s");
    expect(formatDuration(3_661_000)).toBe("1 h 1 min 1 s");
  });
});
