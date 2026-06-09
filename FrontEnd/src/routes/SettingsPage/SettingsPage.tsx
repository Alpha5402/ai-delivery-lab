import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Card, Input, Segmented, Skeleton, Space, Switch, Tag, Typography, message } from "antd";
import {
  deleteJsonSkill,
  fetchWorkflowSettings,
  getSkill,
  listSkills,
  updateWorkflowSettings,
  type SkillManifest,
  type SkillSummary,
  type WorkflowSettings,
  type WorkflowStepExecutionMode,
} from "../../api/client";
import { useDefaultWorkflowTemplate } from "../../features/workflow/workflowTemplate";
import type { WorkflowStepId } from "../../features/workflow/types";
import { SkillEditorModal } from "./SkillEditorModal";
import "./SettingsPage.css";

const { Title, Paragraph, Text } = Typography;

const modeOptions: { label: string; value: WorkflowStepExecutionMode }[] = [
  { label: "自动续跑", value: "automatic" },
  { label: "待审核", value: "manual-confirmation" },
];

const modeDescription: Record<WorkflowStepId, string> = {
  requirement_intake: "接收用户需求，通常无需干预。",
  clarification: "确认关键需求与约束，建议人工确认。",
  solution_design: "生成交付方案，是后续修改的基础，建议人工确认。",
  module_mapping: "定位相关代码与模块，可自动续跑。",
  code_generation: "生成并写入代码变更，必须人工确认后再验证。",
  code_review: "审查生成的代码变更，建议人工确认。",
  repo_write: "旧版生成代码子阶段，仅用于历史运行兼容。",
  verification: "验证结果可自动续跑。",
  pull_request: "提交 PR 涉及外部副作用，建议人工确认。",
};

export function SettingsPage() {
  const [settings, setSettings] = useState<WorkflowSettings | null>(null);
  const [draft, setDraft] = useState<WorkflowSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillManifest | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [clearGithubToken, setClearGithubToken] = useState(false);
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
        setGithubTokenDraft("");
        setClearGithubToken(false);
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
    const modesDirty = template.steps.some((step) =>
      settings.stepExecutionModes[step.id as WorkflowStepId] !== draft.stepExecutionModes[step.id as WorkflowStepId],
    );
    const optionalStepsDirty = JSON.stringify(settings.enabledOptionalSteps) !== JSON.stringify(draft.enabledOptionalSteps);
    return modesDirty || optionalStepsDirty || JSON.stringify(settings.git) !== JSON.stringify(draft.git) || githubTokenDraft.trim() !== "" || clearGithubToken;
  }, [settings, draft, template, githubTokenDraft, clearGithubToken]);

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
    setGithubTokenDraft("");
    setClearGithubToken(false);
  };

  const handleGitChange = (key: "userName" | "userEmail" | "githubOwner" | "githubRepo" | "githubBaseBranch" | "githubRemote", value: string) => {
    setDraft((current) => current ? ({
      ...current,
      git: { ...current.git, [key]: value },
    }) : current);
  };

  const handleOptionalStepChange = (enabled: boolean) => {
    setDraft((current) => current ? ({
      ...current,
      enabledOptionalSteps: { ...current.enabledOptionalSteps, code_review: enabled },
    }) : current);
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await updateWorkflowSettings({
        stepExecutionModes: draft.stepExecutionModes,
        enabledOptionalSteps: draft.enabledOptionalSteps,
        git: {
          userName: draft.git.userName ?? "",
          userEmail: draft.git.userEmail ?? "",
          githubOwner: draft.git.githubOwner ?? "",
          githubRepo: draft.git.githubRepo ?? "",
          githubBaseBranch: draft.git.githubBaseBranch ?? "",
          githubRemote: draft.git.githubRemote ?? "",
          ...(githubTokenDraft.trim() ? { githubToken: githubTokenDraft } : {}),
          ...(clearGithubToken ? { clearGithubToken: true } : {}),
        },
      });
      setSettings(next);
      setDraft(next);
      setGithubTokenDraft("");
      setClearGithubToken(false);
      message.success("设置已更新");
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
        <>
          <div className="settings-page__list">
            {template.steps.map((step) => {
              const stepId = step.id as WorkflowStepId;
              const isCodeReview = stepId === "code_review";
              const codeReviewEnabled = draft.enabledOptionalSteps?.code_review ?? true;
              return (
              <div className="settings-page__row" key={stepId}>
                <div className="settings-page__row-meta">
                  <strong>{step.label}</strong>
                  <span>{step.agent}　·　{modeDescription[stepId] ?? `${step.outputSchemaId} / ${step.defaultExecutionMode === "automatic" ? "默认自动" : "默认待审核"}`}</span>
                </div>
                <div className="settings-page__row-actions">
                  {isCodeReview ? (
                    <Switch
                      checked={codeReviewEnabled}
                      checkedChildren="启用"
                      unCheckedChildren="关闭"
                      onChange={handleOptionalStepChange}
                    />
                  ) : null}
                  {(!isCodeReview || codeReviewEnabled) ? (
                    <Segmented
                      options={modeOptions}
                      value={draft.stepExecutionModes[stepId]}
                      onChange={(value) => handleChange(stepId, value as WorkflowStepExecutionMode)}
                      disabled={stepId === "requirement_intake"}
                    />
                  ) : null}
                </div>
              </div>
            )})}
          </div>

          <Card className="settings-page__git-card" title="Git 与 GitHub" size="small">
            <div className="settings-page__git-grid">
              <label>
                <span>Git 用户名</span>
                <Input value={draft.git.userName ?? ""} onChange={(event) => handleGitChange("userName", event.target.value)} placeholder="用于 git commit user.name" />
              </label>
              <label>
                <span>Git 邮箱</span>
                <Input value={draft.git.userEmail ?? ""} onChange={(event) => handleGitChange("userEmail", event.target.value)} placeholder="用于 git commit user.email" />
              </label>
              <label>
                <span>GitHub Owner</span>
                <Input value={draft.git.githubOwner ?? ""} onChange={(event) => handleGitChange("githubOwner", event.target.value)} placeholder="无法从 remote 推断时使用" />
              </label>
              <label>
                <span>GitHub Repo</span>
                <Input value={draft.git.githubRepo ?? ""} onChange={(event) => handleGitChange("githubRepo", event.target.value)} placeholder="无法从 remote 推断时使用" />
              </label>
              <label>
                <span>Base Branch</span>
                <Input value={draft.git.githubBaseBranch ?? "main"} onChange={(event) => handleGitChange("githubBaseBranch", event.target.value)} placeholder="main" />
              </label>
              <label>
                <span>Remote</span>
                <Input value={draft.git.githubRemote ?? "origin"} onChange={(event) => handleGitChange("githubRemote", event.target.value)} placeholder="origin" />
              </label>
            </div>
            <div className="settings-page__token-row">
              <label>
                <span>GitHub Token</span>
                <Input.Password
                  value={githubTokenDraft}
                  onChange={(event) => {
                    setGithubTokenDraft(event.target.value);
                    if (event.target.value.trim()) setClearGithubToken(false);
                  }}
                  placeholder={draft.git.githubTokenConfigured ? "已配置，留空表示不修改" : "粘贴 GitHub token"}
                />
                <div className="settings-page__token-status">
                  <Tag className="settings-page__token-chip" color={draft.git.githubTokenConfigured ? "green" : "default"}>
                    {draft.git.githubTokenConfigured ? `已配置 · ${draft.git.githubTokenSource === "settings" ? "设置" : "环境变量"}` : "未配置"}
                  </Tag>
                  <Button
                    className="settings-page__token-button"
                    danger
                    size="small"
                    disabled={!draft.git.githubTokenConfigured || draft.git.githubTokenSource !== "settings" || Boolean(githubTokenDraft.trim())}
                    onClick={() => setClearGithubToken(true)}
                  >
                    清除设置中的 Token
                  </Button>
                  {clearGithubToken ? <Text type="warning">保存后会删除设置中加密保存的 Token。</Text> : null}
                </div>
              </label>
            </div>
            <Paragraph className="settings-page__security-note">
              Token 只会发送到后端并以加密形式保存；前端不会回显明文。环境变量中的 Token 仍可作为兜底。
            </Paragraph>
          </Card>
        </>
      )}

      <Card
        title="已注册 Skill"
        size="small"
        className="settings-page__skill-card"
        extra={<Button size="small" className="settings-page__skill-button settings-page__skill-button--primary" onClick={() => { setEditingSkill(null); setEditorOpen(true); }}>+ 新增</Button>}
      >
        {skills.length === 0 ? (
          <Text type="secondary">暂无已注册的 Skill。后端启动时自动注册 builtin/ 下的 Skill 文件。</Text>
        ) : (
          <div className="settings-page__skill-list">
            {skills.map((skill) => (
              <article key={skill.id} className="settings-page__skill-item">
                <div className="settings-page__skill-head">
                  <strong>{skill.name}</strong>
                  <Tag color="purple">{skill.id}</Tag>
                  <Tag variant="outlined">v{skill.version}</Tag>
                  <Tag color={skill.source === "builtin" ? "default" : "orange"}>{skill.source}</Tag>
                </div>
                <div className="settings-page__skill-tags">
                  {skill.requirementPatterns.map((p) => <Tag key={p} color="blue" variant="outlined">{p}</Tag>)}
                  {skill.scopes.map((s) => <Tag key={s} color="green" variant="outlined">{s}</Tag>)}
                </div>
                <div className="settings-page__skill-meta">
                  <Text type="secondary">
                    影响 Step: {skill.stepIds.join(", ")}
                    {skill.matchKeywords?.length ? `　·　关键词: ${skill.matchKeywords.slice(0, 8).join(", ")}${skill.matchKeywords.length > 8 ? "…" : ""}` : ""}
                  </Text>
                </div>
                {skill.source !== "builtin" && (
                  <div className="settings-page__skill-actions">
                    <Button size="small" className="settings-page__skill-button" onClick={async () => {
                      const full = await getSkill(skill.id);
                      setEditingSkill(full);
                      setEditorOpen(true);
                    }}>编辑</Button>
                    <Button size="small" danger className="settings-page__skill-button settings-page__skill-button--danger" onClick={async () => {
                      try {
                        await deleteJsonSkill(skill.id);
                        setSkills((prev) => prev.filter((s) => s.id !== skill.id));
                        message.success("已删除");
                      } catch (e) { message.error(e instanceof Error ? e.message : "删除失败"); }
                    }}>删除</Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </Card>

      <SkillEditorModal
        open={editorOpen}
        editingSkill={editingSkill}
        onClose={async (saved) => {
          setEditorOpen(false);
          if (saved) {
            const updated = await listSkills();
            setSkills(updated);
          }
        }}
      />

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
