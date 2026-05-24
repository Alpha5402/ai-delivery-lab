import type { ReactNode } from "react";
import "./AppShell.css";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-shell__topbar">
        <div>
          <span>Conduit Delivery Lab</span>
          <strong>AI 需求交付工作台</strong>
        </div>
        <nav aria-label="工作台模块">
          <a href="#workflow">流程</a>
          <a href="#contract">JSON</a>
          <a href="#observability">观测</a>
        </nav>
      </header>
      {children}
    </div>
  );
}
