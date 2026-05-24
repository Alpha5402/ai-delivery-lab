export type AgentMetric = {
  agent: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCost: number;
};
