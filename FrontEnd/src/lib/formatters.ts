export function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCurrency(value: number) {
  return `$${value.toFixed(4)}`;
}
