import type { StepRun } from "../../features/workflow/types";
import "./ReplayControls.css";

export function ReplayControls({ step, onReplay, onRunNext }: { step: StepRun; onReplay: () => void; onRunNext: () => void }) {
  return (
    <section className="replay-controls">
      <div>
        <span>Human-in-the-loop</span>
        <strong>当前 Step 可人工确认后继续，也可以从这里重放下游。</strong>
      </div>
      <div>
        <button type="button" onClick={onReplay}>从此重放</button>
        <button type="button" className="replay-controls__primary" onClick={onRunNext} disabled={!step.output}>确认并继续</button>
      </div>
    </section>
  );
}
