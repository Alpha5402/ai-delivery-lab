import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import type { AppShellBreadcrumbItem } from "../AppShell/AppShell";
import { useAppShellBreadcrumb } from "../AppShell/AppShell";

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
  const { setBreadcrumbItems } = useAppShellBreadcrumb();

  const items = useMemo<AppShellBreadcrumbItem[]>(() => {
    const nextItems: AppShellBreadcrumbItem[] = [];

    if (!project) {
      return nextItems;
    }

    const projectTitle = `项目：${project.name || "正在加载项目..."}`;
    nextItems.push({
      key: "project",
      title: workflow ? <Link to={`/project/${project.id}`}>{projectTitle}</Link> : projectTitle,
    });

    if (workflow) {
      nextItems.push({
        key: "workflow",
        title: `工作流：${workflow.title || "正在加载工作流..."}`,
      });
    }

    return nextItems;
  }, [project?.id, project?.name, workflow?.id, workflow?.title]);

  useEffect(() => {
    setBreadcrumbItems(items);
    return () => setBreadcrumbItems([]);
  }, [items, setBreadcrumbItems]);

  return null;
}
