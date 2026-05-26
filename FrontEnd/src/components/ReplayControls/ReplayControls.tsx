import { Button, Card, Space, Typography } from "antd";
import type { StepRun } from "../../features/workflow/types";

const { Text } = Typography;

export function ReplayControls({ step, onReplay, onRunNext }: { step: StepRun; onReplay: () => void; onRunNext: () => void }) {
  return (
    <Card size="small">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
            Human-in-the-loop
          </Text>
          <Text strong>{step.label} 可人工确认后继续，也可以从这里重放下游。</Text>
        </div>
        <Space>
          <Button onClick={onReplay}>从此重放</Button>
          <Button type="primary" onClick={onRunNext}>确认并继续</Button>
        </Space>
      </div>
    </Card>
  );
}
