import { Card, Statistic } from "antd";

const borderColorMap: Record<string, string | undefined> = {
  good: "rgba(82, 196, 26, 0.45)",
  warn: "rgba(250, 173, 20, 0.55)",
};

export function MetricCard({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "warn" }) {
  const borderColor = borderColorMap[tone];
  return (
    <Card size="small" style={borderColor ? { borderColor } : undefined}>
      <Statistic title={label} value={value} />
    </Card>
  );
}
