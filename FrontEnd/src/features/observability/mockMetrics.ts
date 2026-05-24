import type { AgentMetric } from "./types";

export const mockMetrics: AgentMetric[] = [
  { agent: "Clarifier Agent", calls: 2, inputTokens: 1240, outputTokens: 680, latencyMs: 1900, estimatedCost: 0.0062 },
  { agent: "Planner Agent", calls: 1, inputTokens: 1660, outputTokens: 940, latencyMs: 2300, estimatedCost: 0.0081 },
  { agent: "Context Locator", calls: 3, inputTokens: 3120, outputTokens: 730, latencyMs: 3100, estimatedCost: 0.0129 },
  { agent: "Verifier", calls: 1, inputTokens: 850, outputTokens: 420, latencyMs: 1200, estimatedCost: 0.0039 },
];

export function summarizeMetrics(metrics: AgentMetric[]) {
  return metrics.reduce(
    (summary, metric) => ({
      calls: summary.calls + metric.calls,
      inputTokens: summary.inputTokens + metric.inputTokens,
      outputTokens: summary.outputTokens + metric.outputTokens,
      latencyMs: summary.latencyMs + metric.latencyMs,
      estimatedCost: summary.estimatedCost + metric.estimatedCost,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, estimatedCost: 0 },
  );
}
