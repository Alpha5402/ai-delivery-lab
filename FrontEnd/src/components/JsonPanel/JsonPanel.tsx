import { Button, Space, Typography } from "antd";
import { useJsonEditor } from "../../hooks/useJsonEditor";
import "./JsonPanel.css";

const { Text } = Typography;

export function JsonPanel({ title, value, editable, onSave }: { title: string; value: unknown; editable: boolean; onSave: (value: unknown) => void }) {
  const editor = useJsonEditor(value);

  return (
    <section className="json-panel">
      <header>
        <div>
          <span>JSON 契约</span>
          <h3>{title}</h3>
        </div>
        <Space>
          <Button className="settings-page__skill-button" size="small" onClick={editor.format}>格式化</Button>
          <Button
            className="settings-page__skill-button settings-page__skill-button--primary"
            size="small"
            disabled={!editable || !editor.parsed.ok}
            onClick={() => editor.parsed.ok && onSave(editor.parsed.value)}
          >
            保存修订
          </Button>
        </Space>
      </header>
      <textarea
        aria-label={`${title} JSON`}
        value={editor.draft}
        onChange={(event) => editor.setDraft(event.target.value)}
        spellCheck={false}
      />
      {!editor.parsed.ok ? (
        <Text type="danger" style={{ display: "block", padding: "12px 18px 16px", margin: 0 }}>JSON 无效：{editor.parsed.message}</Text>
      ) : (
        <Text type="success" style={{ display: "block", padding: "12px 18px 16px", margin: 0 }}>JSON 可用于传递到下一步骤</Text>
      )}
    </section>
  );
}
