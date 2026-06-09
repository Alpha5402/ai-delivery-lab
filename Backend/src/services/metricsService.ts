import type { AgentMetric } from "../domain/workflow.js";

const metrics: AgentMetric[] = [];

/** 返回浅拷贝，避免外部引用修改 */
export function listMetrics(): AgentMetric[] {
  return metrics.map((m) => ({ ...m }));
}

export function recordMetric(metric: AgentMetric) {
  const existing = metrics.find((item) => item.agent === metric.agent);

  if (!existing) {
    metrics.push(metric);
  } else {
    existing.calls += metric.calls;
    existing.inputTokens += metric.inputTokens;
    existing.outputTokens += metric.outputTokens;
    existing.latencyMs += metric.latencyMs;
    existing.estimatedCost += metric.estimatedCost;
  }

  // 广播最新 metrics 到 SSE 订阅者（lazy import 避免循环依赖）
  import("./workflowEvents.js").then(({ workflowEventBus }) => {
    workflowEventBus.emitMetricsChanged(listMetrics());
  }).catch(() => undefined);
}
