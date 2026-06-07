import type { AgentMetric } from "../../features/observability/types";
import { formatCurrency, formatDuration, formatTokenCount } from "../../lib/formatters";
import "./AgentCard.css";

export function AgentCard({ metric }: { metric: AgentMetric }) {
  return (
    <article className="agent-card">
      <div>
        <strong>{metric.agent}</strong>
        <span>{metric.calls} calls</span>
      </div>
      <dl>
        <div><dt>Tokens</dt><dd>{formatTokenCount(metric.inputTokens + metric.outputTokens)}</dd></div>
        <div><dt>Latency</dt><dd>{formatDuration(metric.latencyMs)}</dd></div>
        <div><dt>Cost</dt><dd>{formatCurrency(metric.estimatedCost)}</dd></div>
      </dl>
    </article>
  );
}
