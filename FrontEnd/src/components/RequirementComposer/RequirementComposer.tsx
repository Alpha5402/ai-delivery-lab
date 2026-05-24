import type { RequirementDraft } from "../../features/workflow/types";
import "./RequirementComposer.css";

export function RequirementComposer({ requirement }: { requirement: RequirementDraft }) {
  return (
    <section className="requirement-composer">
      <div>
        <span>PM Requirement</span>
        <h2>{requirement.title}</h2>
      </div>
      <p>{requirement.rawText}</p>
      <div className="requirement-composer__chips">
        <b>{requirement.pattern}</b>
        <b>{requirement.targetRepo}</b>
        <b>L1 演示链路</b>
      </div>
    </section>
  );
}
