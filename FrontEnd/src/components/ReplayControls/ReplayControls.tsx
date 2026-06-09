import { Button, Card, Space, Typography } from "antd";
import type { StepRun } from "../../features/workflow/types";

const { Text } = Typography;

function formatStepLabel(value: string) {
  const labelMap: Record<string, string> = {
    "PM 输入": "接收需求",
    "澄清 Agent": "确认需求",
    "方案 DSL": "生成方案",
    "模块定位": "定位代码",
    "代码计划": "生成代码",
    "写入仓库": "生成代码",
    "Lint / 单测": "验证结果",
    "提交 PR": "提交 PR",
  };
  return labelMap[value] ?? value;
}

export function ReplayControls({ step, onReplay, onRunNext }: { step: StepRun; onReplay: () => void; onRunNext: () => void }) {
  return (
    <Card size="small">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
            确认决策
          </Text>
          <Text strong>{formatStepLabel(step.label)} 可确认后继续，也可以从这里重放后续阶段。</Text>
        </div>
        <Space>
          <Button onClick={onReplay}>从此重放</Button>
          <Button type="primary" onClick={onRunNext}>确认并继续</Button>
        </Space>
      </div>
    </Card>
  );
}
