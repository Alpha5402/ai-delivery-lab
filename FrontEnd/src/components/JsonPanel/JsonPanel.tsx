import { useJsonEditor } from "../../hooks/useJsonEditor";
import "./JsonPanel.css";

export function JsonPanel({ title, value, editable, onSave }: { title: string; value: unknown; editable: boolean; onSave: (value: unknown) => void }) {
  const editor = useJsonEditor(value);

  return (
    <section className="json-panel">
      <header>
        <div>
          <span>JSON 契约</span>
          <h3>{title}</h3>
        </div>
        <div className="json-panel__actions">
          <button type="button" onClick={editor.format}>格式化</button>
          <button type="button" disabled={!editable || !editor.parsed.ok} onClick={() => editor.parsed.ok && onSave(editor.parsed.value)}>
            保存修订
          </button>
        </div>
      </header>
      <textarea
        aria-label={`${title} JSON`}
        value={editor.draft}
        onChange={(event) => editor.setDraft(event.target.value)}
        spellCheck={false}
      />
      {!editor.parsed.ok ? <p className="json-panel__error">JSON 无效：{editor.parsed.message}</p> : <p className="json-panel__ok">JSON 可用于传递到下一步骤</p>}
    </section>
  );
}
