import { Skeleton, Space } from "antd";

/**
 * 页面级 loading skeleton，在页面数据加载时展示。
 * variant: "default" 适用于一般页面, "workbench" 适用于三栏布局页面
 */
export function PageSkeleton({ variant = "default" }: { variant?: "default" | "workbench" }) {
  if (variant === "workbench") {
    return (
      <div style={{ display: "grid", gap: 16, maxWidth: 1600, width: "100%" }}>
        <Skeleton.Input active style={{ width: "100%", height: 72 }} />
        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 280px", gap: 16 }}>
          <Space direction="vertical" style={{ width: "100%" }}>
            <Skeleton.Input active style={{ width: "100%", height: 48 }} />
            <Skeleton.Input active style={{ width: "100%", height: 48 }} />
            <Skeleton.Input active style={{ width: "100%", height: 48 }} />
            <Skeleton.Input active style={{ width: "100%", height: 48 }} />
          </Space>
          <Skeleton active paragraph={{ rows: 8 }} />
          <Space direction="vertical" style={{ width: "100%" }}>
            <Skeleton active paragraph={{ rows: 4 }} />
            <Skeleton active paragraph={{ rows: 3 }} />
          </Space>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1180, width: "100%", margin: "0 auto" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Skeleton.Input active style={{ width: 320, height: 36 }} />
        <Skeleton active paragraph={{ rows: 2 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20 }}>
          <Skeleton active paragraph={{ rows: 6 }} />
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      </Space>
    </div>
  );
}
