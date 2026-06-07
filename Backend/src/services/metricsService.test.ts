import { describe, expect, it } from "vitest";
import { listMetrics, recordMetric } from "./metricsService.js";

describe("metricsService", () => {
  it("starts without demo metrics and records real calls", () => {
    expect(listMetrics()).toEqual([]);

    recordMetric({
      agent: "确认需求",
      calls: 1,
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 30,
      estimatedCost: 0,
    });

    expect(listMetrics()).toEqual([expect.objectContaining({ agent: "确认需求", calls: 1 })]);
  });
});
