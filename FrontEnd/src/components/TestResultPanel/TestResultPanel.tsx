import type { VerificationResult } from "../../features/workflow/types";
import "./TestResultPanel.css";

function formatStatus(value: string) {
  const statusMap: Record<string, string> = {
    failed: "失败",
    passed: "通过",
    pending: "等待中",
    running: "运行中",
  };
  return statusMap[value] ?? value;
}

export function TestResultPanel({ result }: { result?: VerificationResult }) {
  return (
    <section className="test-result-panel">
      <header>
        <span>质量门</span>
        <h3>Lint / 单测</h3>
      </header>
      {result ? (
        <>
          <div className="test-result-panel__summary">
            <b>Lint：{formatStatus(result.lint)}</b>
            <b>单测：{formatStatus(result.unitTests)}</b>
            <b>覆盖率：{result.coverage}%</b>
          </div>
          {result.testSuites.map((suite) => (
            <article key={suite.name}>
              <strong>{suite.name}</strong>
              <small>{formatStatus(suite.status)} · {suite.durationMs}ms</small>
            </article>
          ))}
        </>
      ) : (
        <p>等待验证步骤运行后展示质量门结果。</p>
      )}
    </section>
  );
}
