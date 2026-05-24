import type { VerificationResult } from "../../features/workflow/types";
import "./TestResultPanel.css";

export function TestResultPanel({ result }: { result?: VerificationResult }) {
  return (
    <section className="test-result-panel">
      <header>
        <span>Quality Gate</span>
        <h3>Lint / Unit Test</h3>
      </header>
      {result ? (
        <>
          <div className="test-result-panel__summary">
            <b>Lint: {result.lint}</b>
            <b>Unit: {result.unitTests}</b>
            <b>Coverage: {result.coverage}%</b>
          </div>
          {result.testSuites.map((suite) => (
            <article key={suite.name}>
              <strong>{suite.name}</strong>
              <small>{suite.status} · {suite.durationMs}ms</small>
            </article>
          ))}
        </>
      ) : (
        <p>等待验证 Step 运行后展示质量门结果。</p>
      )}
    </section>
  );
}
