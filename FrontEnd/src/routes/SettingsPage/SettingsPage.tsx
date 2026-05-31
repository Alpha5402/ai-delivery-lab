import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Card, Segmented, Skeleton, Space, Tag, Typography, message } from "antd";
import {
  fetchWorkflowSettings,
  listSkills,
  updateWorkflowSettings,
  type SkillSummary,
  type WorkflowSettings,
  type WorkflowStepExecutionMode,
} from "../../api/client";
import { useDefaultWorkflowTemplate } from "../../features/workflow/workflowTemplate";
import type { WorkflowStepId } from "../../features/workflow/types";
import "./SettingsPage.css";

const { Title, Paragraph, Text } = Typography;

const modeOptions: { label: string; value: WorkflowStepExecutionMode }[] = [
  { label: "自动续跑", value: "automatic" },
  { label: "待审核", value: "manual-confirmation" },
];

const modeDescription: Record<WorkflowStepId, string> = {
  requirement_intake: "PM 需求入口，通常无需干预。",
  clarification: "澄清 Agent 输出 questions，建议人工确认。",
  solution_design: "方案 DSL 是后续生成的基础，建议人工 review。",
  module_mapping: "模块定位结果，可自动续跑。",
  code_generation: "代码计划影响实际写入，建议人工 review。",
  repo_write: "写入仓库结果，可自动续跑。",
  verification: "Lint / 单测验证，可自动续跑。",
  pull_request: "提交 PR 涉及外部副作用，建议人工确认。",
};

export function SettingsPage() {
  const [settings, setSettings] = useState<WorkflowSettings | null>(null);
  const [draft, setDraft] = useState<WorkflowSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const { template } = useDefaultWorkflowTemplate(); // API-driven, with fallback

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchWorkflowSettings(),
      listSkills().catch(() => [] as SkillSummary[]),
    ])
      .then(([data, skillList]) => {
        if (cancelled) return;
        setSettings(data);
        setDraft(data);
        setSkills(skillList);
        setErrorText(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorText(error instanceof Error ? error.message : "无法加载执行模式配置");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!settings || !draft) return false;
    return template.steps.some((step) =>
      settings.stepExecutionModes[step.id as WorkflowStepId] !== draft.stepExecutionModes[step.id as WorkflowStepId],
    );
  }, [settings, draft, template]);

  const handleChange = (stepId: WorkflowStepId, value: WorkflowStepExecutionMode) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        stepExecutionModes: { ...current.stepExecutionModes, [stepId]: value },
      };
    });
  };

  const handleReset = () => {
    if (!settings) return;
    setDraft(settings);
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await updateWorkflowSettings({ stepExecutionModes: draft.stepExecutionModes });
      setSettings(next);
      setDraft(next);
      message.success("执行模式已更新");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-page__header">
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>Workflow 执行模式</Title>
          <Text type="secondary">配置每个步骤是「自动续跑」还是「待审核」。</Text>
        </div>
        <Link className="settings-page__back" to="/dashboard">← 返回项目列表</Link>
      </div>

      <Paragraph className="settings-page__intro">
        当某步标记为「待审核」时，Workflow 在该步骤完成后会停在 <Text code>waiting-human</Text> 状态，
        直到你在工作台点击「确认并继续」。修改在保存后即时生效，对后续创建 / 推进的 run 都会应用。
      </Paragraph>

      {errorText && (
        <Alert type="error" showIcon message="加载失败" description={errorText} style={{ marginBottom: 16 }} />
      )}

      {loading || !draft ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <div className="settings-page__list">
          {template.steps.map((step) => {
            const stepId = step.id as WorkflowStepId;
            return (
            <div className="settings-page__row" key={stepId}>
              <div className="settings-page__row-meta">
                <strong>{step.label}</strong>
                <span>{step.agent}　·　{modeDescription[stepId] ?? `${step.outputSchemaId} / ${step.defaultExecutionMode === "automatic" ? "默认自动" : "默认待审核"}`}</span>
              </div>
              <Segmented
                options={modeOptions}
                value={draft.stepExecutionModes[stepId]}
                onChange={(value) => handleChange(stepId, value as WorkflowStepExecutionMode)}
                disabled={stepId === "requirement_intake"}
              />
            </div>
          )})}
        </div>
      )}

      <Card title="已注册 Skill" size="small" style={{ marginTop: 24 }}>
        {skills.length === 0 ? (
          <Text type="secondary">暂无已注册的 Skill。后端启动时自动注册 builtin/ 下的 Skill 文件。</Text>
        ) : (
          skills.map((skill) => (
            <div key={skill.id} style={{ marginBottom: 12 }}>
              <Space wrap>
                <strong>{skill.name}</strong>
                <Tag color="purple">{skill.id}</Tag>
                <Tag variant="outlined">v{skill.version}</Tag>
              </Space>
              <div>
                <Space wrap size={4}>
                  {skill.requirementPatterns.map((p) => <Tag key={p} color="blue" variant="outlined">{p}</Tag>)}
                  {skill.scopes.map((s) => <Tag key={s} color="green" variant="outlined">{s}</Tag>)}
                </Space>
              </div>
              <div>
                <Text type="secondary">
                  影响 Step: {skill.stepIds.join(", ")}
                  {skill.matchKeywords?.length ? `　·　关键词: ${skill.matchKeywords.slice(0, 8).join(", ")}${skill.matchKeywords.length > 8 ? "…" : ""}` : ""}
                </Text>
              </div>
            </div>
          ))
        )}
      </Card>

      <div className="settings-page__footer">
        <Space>
          <Button onClick={handleReset} disabled={!dirty || saving}>
            撤销改动
          </Button>
          <Button type="primary" onClick={handleSave} loading={saving} disabled={!dirty}>
            保存
          </Button>
        </Space>
      </div>
    </div>
  );
}
