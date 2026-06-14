import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Card, Segmented, Typography } from "antd";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getDailyMetrics,
  type DailyMetric,
} from "../../api/client";
import { formatTokenCount } from "../../lib/formatters";
import "./BoardPage.css";

const { Text, Title } = Typography;

type AxisMode = "tokens" | "calls";

const axisMeta: Record<AxisMode, { label: string; getValue: (item: DailyMetric) => number; format: (value: number) => string; color: string }> = {
  tokens: {
    label: "Token",
    getValue: (item) => item.totalTokens,
    format: formatTokenCount,
    color: "#0f766e",
  },
  calls: {
    label: "调用次数",
    getValue: (item) => item.calls,
    format: (value) => String(Math.round(value)),
    color: "#7c3aed",
  },
};

export function BoardPage() {
  const [dailyMetrics, setDailyMetrics] = useState<DailyMetric[]>([]);
  const [axisMode, setAxisMode] = useState<AxisMode>("tokens");
  const [errorText, setErrorText] = useState<string | null>(null);

  async function refresh() {
    try {
      const metrics = await getDailyMetrics();
      setDailyMetrics(metrics);
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "看板加载失败");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const chartRows = useMemo(() => {
    const rows = dailyMetrics.slice(-14);
    return rows.map((item) => {
      const value = axisMeta[axisMode].getValue(item);
      return { date: item.date, label: item.date.slice(5), value };
    });
  }, [axisMode, dailyMetrics]);
  const activeAxis = axisMeta[axisMode];

  return (
    <div className="board-page">
      <div className="board-page__header">
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>LLM 调用看板</Title>
          <Text type="secondary">按日期观察 Token 消耗和 API 调用次数。</Text>
        </div>
        <Link className="board-page__back" to="/settings">前往公共配置 →</Link>
      </div>

      {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

      <section className="board-grid">
        <Card className="board-chart-card" bordered={false}>
          <div className="board-card-title">
            <span>按日调用统计</span>
            <Segmented
              value={axisMode}
              onChange={(value) => setAxisMode(value as AxisMode)}
              options={[
                { label: "Token 消耗", value: "tokens" },
                { label: "API 调用次数", value: "calls" },
              ]}
            />
          </div>
          {chartRows.length === 0 ? (
            <div className="board-empty">暂无调用数据。运行一次工作流后会在这里显示按日统计。</div>
          ) : (
            <div className="board-chart" role="img" aria-label={`按日 LLM ${activeAxis.label}柱状图`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows} margin={{ top: 16, right: 18, bottom: 6, left: 6 }}>
                  <CartesianGrid stroke="#eef2f7" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#667085", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "#e5e7eb" }}
                  />
                  <YAxis
                    allowDecimals={axisMode !== "calls"}
                    tick={{ fill: "#667085", fontSize: 11 }}
                    tickFormatter={activeAxis.format}
                    tickLine={false}
                    axisLine={false}
                    width={70}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(15, 23, 42, 0.04)" }}
                    formatter={(value) => [activeAxis.format(Number(value)), activeAxis.label]}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ""}
                  />
                  <Bar dataKey="value" fill={activeAxis.color} radius={[6, 6, 0, 0]} maxBarSize={42} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
