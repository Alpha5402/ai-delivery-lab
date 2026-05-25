import type { AgentMetric } from "./types";

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
