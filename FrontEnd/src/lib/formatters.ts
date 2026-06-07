export function formatDuration(ms: number) {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) {
    return `${safeMs}ms`;
  }

  if (safeMs < 60_000) {
    const seconds = safeMs / 1000;
    return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
  }

  const totalSeconds = Math.round(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} s`);

  return parts.join(" ");
}

export function formatTokenCount(tokens: number) {
  const safeTokens = Math.max(0, Math.round(tokens));
  const units = [
    { suffix: "M", value: 1024 * 1024 },
    { suffix: "K", value: 1024 },
  ];
  const unit = units.find((item) => safeTokens >= item.value);

  if (!unit) return `${safeTokens}`;

  const scaled = safeTokens / unit.value;
  const display = scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
  return `${display.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1")}${unit.suffix}`;
}

export function formatCurrency(value: number) {
  return `$${value.toFixed(4)}`;
}
