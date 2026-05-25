import type { ReactNode } from "react";
import "./AppShell.css";

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-shell">{children}</div>;
}
