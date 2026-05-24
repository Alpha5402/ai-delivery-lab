export type ModelPricing = {
  inputPer1k: number;
  outputPer1k: number;
};

export function estimateCallCost(inputTokens: number, outputTokens: number, pricing: ModelPricing) {
  if (inputTokens <= 0 && outputTokens <= 0) {
    return 0;
  }

  return (Math.max(0, inputTokens) / 1000) * pricing.inputPer1k + (Math.max(0, outputTokens) / 1000) * pricing.outputPer1k;
}
