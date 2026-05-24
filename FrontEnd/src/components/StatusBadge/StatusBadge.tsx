import type { StepStatus } from "../../features/workflow/types";
import "./StatusBadge.css";

const labels: Record<StepStatus, string> = {
  idle: "待执行",
  running: "执行中",
  "waiting-human": "待确认",
  success: "已完成",
  failed: "失败",
  replayed: "已重放",
};

export function StatusBadge({ status }: { status: StepStatus }) {
  return <span className={`status-badge status-badge--${status}`}>{labels[status]}</span>;
}
