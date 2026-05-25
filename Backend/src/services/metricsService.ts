import type { AgentMetric } from "../domain/workflow.js";

const metrics: AgentMetric[] = [];

export function listMetrics() {
  return metrics;
}

export function recordMetric(metric: AgentMetric) {
  const existing = metrics.find((item) => item.agent === metric.agent);

  if (!existing) {
    metrics.push(metric);
    return metric;
  }

  existing.calls += metric.calls;
  existing.inputTokens += metric.inputTokens;
  existing.outputTokens += metric.outputTokens;
  existing.latencyMs += metric.latencyMs;
  existing.estimatedCost += metric.estimatedCost;
  return existing;
}
