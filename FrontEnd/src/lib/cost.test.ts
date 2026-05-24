import { describe, expect, it } from "vitest";
import { estimateCallCost } from "./cost";

describe("estimateCallCost", () => {
  it("calculates input and output token cost", () => {
    expect(estimateCallCost(1000, 500, { inputPer1k: 0.002, outputPer1k: 0.006 })).toBe(0.005);
  });

  it("returns zero for empty calls", () => {
    expect(estimateCallCost(0, 0, { inputPer1k: 0.002, outputPer1k: 0.006 })).toBe(0);
  });

  it("guards against negative token values", () => {
    expect(estimateCallCost(-100, 1000, { inputPer1k: 0.002, outputPer1k: 0.006 })).toBe(0.006);
  });
});
