import { Breadcrumb } from "antd";
import { Link } from "react-router-dom";
import "./AppBreadcrumb.css";

export interface AppBreadcrumbProps {
  project?: {
    id: string;
    name?: string;
  };
  workflow?: {
    id: string;
    title?: string;
  };
}

export function AppBreadcrumb({ project, workflow }: AppBreadcrumbProps) {
  const items = [
    {
      title: project ? <Link to="/dashboard">工作台</Link> : "工作台",
    },
  ];

  if (project) {
    const projectTitle = `项目：${project.name || "正在加载项目..."}`;
    items.push({
      title: workflow ? <Link to={`/project/${project.id}`}>{projectTitle}</Link> : projectTitle,
    });
  }

  if (project && workflow) {
    items.push({
      title: `工作流：${workflow.title || "正在加载工作流..."}`,
    });
  }

  return <Breadcrumb className="app-breadcrumb" items={items} />;
}
