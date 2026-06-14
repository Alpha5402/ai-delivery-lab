import { Card, Space, Tag, Typography } from "antd";
import type { RequirementDraft } from "../../features/workflow/types";

const { Text, Title } = Typography;

export function RequirementComposer({ requirement }: { requirement: RequirementDraft }) {
  return (
    <Card
      style={{ borderRadius: "var(--radius-md)" }}
    >
      <div>
        <Text type="secondary" style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          PM Requirement
        </Text>
        <Title level={4} style={{ margin: "8px 0 12px", maxWidth: 720 }}>{requirement.title}</Title>
      </div>
      <Text style={{ fontSize: 16, lineHeight: 1.7, maxWidth: 820, display: "block" }}>{requirement.rawText}</Text>
      <Space wrap style={{ marginTop: 18 }}>
        <Tag color="blue" variant="filled">{requirement.pattern}</Tag>
        <Tag color="default" variant="filled">{requirement.targetRepo}</Tag>
        <Tag color="purple" variant="filled">L1 演示链路</Tag>
      </Space>
    </Card>
  );
}
