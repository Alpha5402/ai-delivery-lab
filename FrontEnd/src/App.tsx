import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import { BoardPage } from "./routes/BoardPage/BoardPage";
import { ChatPage } from "./routes/ChatPage/ChatPage";
import { NotFoundPage } from "./routes/NotFoundPage/NotFoundPage";
import { SettingsPage } from "./routes/SettingsPage/SettingsPage";
import { StartPage } from "./routes/StartPage/StartPage";
import { WorkbenchPage } from "./routes/WorkbenchPage/WorkbenchPage";
import "./styles/global.css";

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<StartPage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/start" element={<StartPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/project/:projectId" element={<ChatPage />} />
            <Route path="/project/:projectId/workflow/:runId" element={<WorkbenchPage />} />
            <Route path="/project/:projectId/run/:runId" element={<WorkbenchPage />} />
            <Route path="/workbench/:runId" element={<WorkbenchPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </ErrorBoundary>
      </AppShell>
    </ErrorBoundary>
  );
}
