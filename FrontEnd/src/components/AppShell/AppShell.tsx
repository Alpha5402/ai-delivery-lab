import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Breadcrumb } from "antd";
import type { BreadcrumbProps } from "antd";
import { NavLink, Link } from "react-router-dom";
import "./AppShell.css";

export type AppShellBreadcrumbItem = NonNullable<BreadcrumbProps["items"]>[number];

interface AppShellBreadcrumbContextValue {
  setBreadcrumbItems: (items: AppShellBreadcrumbItem[]) => void;
}

const AppShellBreadcrumbContext = createContext<AppShellBreadcrumbContextValue | null>(null);

export function useAppShellBreadcrumb() {
  const context = useContext(AppShellBreadcrumbContext);
  if (!context) {
    throw new Error("useAppShellBreadcrumb must be used inside AppShell");
  }
  return context;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [breadcrumbItems, setBreadcrumbItems] = useState<AppShellBreadcrumbItem[]>([]);
  const breadcrumbContext = useMemo(() => ({ setBreadcrumbItems }), []);
  const navBreadcrumbItems = [
    {
      key: "home",
      title: (
        <Link to="/dashboard" className="app-shell__brand">
          AI Delivery Workspace
        </Link>
      ),
    },
    ...breadcrumbItems,
  ];

  return (
    <AppShellBreadcrumbContext.Provider value={breadcrumbContext}>
      <div className="app-shell">
        <header className="app-shell__nav">
          <Breadcrumb className="app-shell__breadcrumb" items={navBreadcrumbItems} />
          <nav className="app-shell__links">
            <NavLink
              to="/dashboard"
              end
              className={({ isActive }) =>
                isActive ? "app-shell__link app-shell__link--active" : "app-shell__link"
              }
            >
              项目
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                isActive ? "app-shell__link app-shell__link--active" : "app-shell__link"
              }
            >
              设置
            </NavLink>
          </nav>
        </header>
        <main className="app-shell__main">{children}</main>
      </div>
    </AppShellBreadcrumbContext.Provider>
  );
}
