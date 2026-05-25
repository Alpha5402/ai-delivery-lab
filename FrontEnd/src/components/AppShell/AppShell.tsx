import type { ReactNode } from "react";
import { NavLink, Link } from "react-router-dom";
import "./AppShell.css";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-shell__nav">
        <Link to="/dashboard" className="app-shell__brand">
          Conduit Delivery Lab
        </Link>
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
  );
}
