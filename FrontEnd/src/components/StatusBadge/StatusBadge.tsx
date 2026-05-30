import { Tag } from "antd";
import type { StepStatus } from "../../features/workflow/types";

const config: Record<StepStatus, { label: string; color: string }> = {
  idle: { label: "待执行", color: "default" },
  running: { label: "执行中", color: "processing" },
  "waiting-human": { label: "待审核", color: "warning" },
  success: { label: "已完成", color: "success" },
  failed: { label: "失败", color: "error" },
};

export function StatusBadge({ status }: { status: StepStatus }) {
  const { label, color } = config[status];
  return <Tag color={color}>{label}</Tag>;
}
