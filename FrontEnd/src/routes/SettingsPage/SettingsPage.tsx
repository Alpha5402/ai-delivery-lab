import { useEffect, useMemo, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Card, Input, Modal, Skeleton, Space, Switch, Tag, Typography, message } from "antd";
import {
  createLlmModel,
  deleteJsonSkill,
  deleteLlmModel,
  fetchWorkflowSettings,
  getSkill,
  listLlmModels,
  listSkills,
  resetBuiltinSkill,
  setDefaultLlmModel,
  updateLlmModel,
  updateWorkflowSettings,
  type LlmModel,
  type LlmModelInput,
  type SkillManifest,
  type SkillSummary,
  type WorkflowSettings,
} from "../../api/client";
import { SkillEditorModal } from "./SkillEditorModal";
import "./SettingsPage.css";

const { Title, Paragraph, Text } = Typography;

type LlmDraft = LlmModelInput & { editingId?: string; clearApiKey?: boolean; apiKeyMasked?: string };

function createEmptyLlmDraft(): LlmDraft {
  return {
    displayName: "",
    baseUrl: "",
    modelName: "",
    apiKey: "",
    isDefault: false,
  };
}

function modelToDraft(model: LlmModel): LlmDraft {
  return {
    editingId: model.id,
    displayName: model.displayName,
    baseUrl: model.baseUrl,
    modelName: model.modelName ?? "",
    apiKey: "",
    apiKeyMasked: model.apiKeyMasked,
    isDefault: model.isDefault,
  };
}

export function SettingsPage() {
  const [settings, setSettings] = useState<WorkflowSettings | null>(null);
  const [draft, setDraft] = useState<WorkflowSettings | null>(null);
  const [llmModels, setLlmModels] = useState<LlmModel[]>([]);
  const [llmDraft, setLlmDraft] = useState<LlmDraft>(createEmptyLlmDraft);
  const [llmEditorOpen, setLlmEditorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillManifest | null>(null);
  const [skillActionId, setSkillActionId] = useState<string | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");

  const gitDirty = useMemo(() => Boolean(settings && draft && JSON.stringify(settings.git) !== JSON.stringify(draft.git)), [settings, draft]);

  async function refreshSkills() {
    const updated = await listSkills();
    setSkills(updated);
  }

  async function refreshLlmModels() {
    setLlmModels(await listLlmModels());
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchWorkflowSettings(),
      listSkills().catch(() => [] as SkillSummary[]),
      listLlmModels().catch(() => [] as LlmModel[]),
    ])
      .then(([data, skillList, models]) => {
        if (cancelled) return;
        setSettings(data);
        setDraft(data);
        setGithubTokenDraft("");
        setSkills(skillList);
        setLlmModels(models);
        setErrorText(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorText(error instanceof Error ? error.message : "无法加载公共配置");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleGitChange = (key: "userName" | "userEmail" | "githubOwner" | "githubRepo" | "githubBaseBranch" | "githubRemote", value: string) => {
    setDraft((current) => current ? ({
      ...current,
      git: { ...current.git, [key]: value },
    }) : current);
  };

  const handleSaveGit = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await updateWorkflowSettings({
        git: {
          userName: draft.git.userName ?? "",
          userEmail: draft.git.userEmail ?? "",
          githubOwner: draft.git.githubOwner ?? "",
          githubRepo: draft.git.githubRepo ?? "",
          githubBaseBranch: draft.git.githubBaseBranch ?? "",
          githubRemote: draft.git.githubRemote ?? "",
        },
      });
      setSettings(next);
      setDraft(next);
      message.success("Git/GitHub 配置已更新");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const syncGithubToken = async () => {
    const token = githubTokenDraft.trim();
    if (!token) return;
    setSaving(true);
    try {
      const next = await updateWorkflowSettings({ git: { githubToken: token } });
      setSettings(next);
      setDraft(next);
      setGithubTokenDraft("");
      message.success("GitHub Token 已同步");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "GitHub Token 同步失败");
    } finally {
      setSaving(false);
    }
  };

  const clearGithubTokenSetting = async () => {
    setSaving(true);
    try {
      const next = await updateWorkflowSettings({ git: { clearGithubToken: true } });
      setSettings(next);
      setDraft(next);
      setGithubTokenDraft("");
      message.success("已切换为环境变量 Token");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "GitHub Token 清除失败");
    } finally {
      setSaving(false);
    }
  };

  function handleGithubTokenKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Backspace") {
      event.preventDefault();
      setGithubTokenDraft((value) => value.slice(0, -1));
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      setGithubTokenDraft("");
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      setGithubTokenDraft((value) => `${value}${event.key}`);
    }
  }

  function handleGithubTokenPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    setGithubTokenDraft(event.clipboardData.getData("text"));
  }

  function handleLlmTokenKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Backspace") {
      event.preventDefault();
      setLlmDraft((current) => ({ ...current, apiKey: (current.apiKey ?? "").slice(0, -1) }));
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      setLlmDraft((current) => ({ ...current, apiKey: "" }));
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      setLlmDraft((current) => ({ ...current, apiKey: `${current.apiKey ?? ""}${event.key}` }));
    }
  }

  function handleLlmTokenPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    setLlmDraft((current) => ({ ...current, apiKey: event.clipboardData.getData("text") }));
  }

  const handleSaveLlmModel = async () => {
    const payload = {
      displayName: llmDraft.displayName.trim(),
      baseUrl: llmDraft.baseUrl.trim(),
      modelName: llmDraft.modelName.trim(),
      apiKey: llmDraft.apiKey?.trim() || undefined,
      isDefault: llmDraft.isDefault,
      clearApiKey: llmDraft.clearApiKey,
    };
    if (!payload.displayName || !payload.baseUrl || !payload.modelName) {
      message.warning("请填写 Display Name、URL 和 Model Name");
      return;
    }
    setSaving(true);
    try {
      if (llmDraft.editingId) {
        await updateLlmModel(llmDraft.editingId, payload);
      } else {
        await createLlmModel(payload);
      }
      await refreshLlmModels();
      setLlmDraft(createEmptyLlmDraft());
      setLlmEditorOpen(false);
      message.success("LLM 模型已保存");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "LLM 模型保存失败");
    } finally {
      setSaving(false);
    }
  };

  const openCreateLlmModel = () => {
    setLlmDraft(createEmptyLlmDraft());
    setLlmEditorOpen(true);
  };

  const openEditLlmModel = (model: LlmModel) => {
    if (model.readOnly) return;
    setLlmDraft(modelToDraft(model));
    setLlmEditorOpen(true);
  };

  const closeLlmEditor = () => {
    setLlmEditorOpen(false);
    setLlmDraft(createEmptyLlmDraft());
  };

  const handleDeleteLlmModel = (model: LlmModel) => {
    if (model.readOnly) return;
    Modal.confirm({
      title: "删除该 LLM 模型？",
      content: <p><strong>{model.displayName}</strong> 将不再可被项目选择。</p>,
      okText: "删除",
      okButtonProps: { className: "settings-page__skill-button settings-page__skill-button--danger", danger: true },
      cancelText: "取消",
      async onOk() {
        await deleteLlmModel(model.id);
        await refreshLlmModels();
        message.success("LLM 模型已删除");
      },
    });
  };

  const handleSetDefaultLlmModel = async (model: LlmModel) => {
    setSaving(true);
    try {
      await setDefaultLlmModel(model.id);
      await refreshLlmModels();
      message.success(`${model.displayName} 已设为默认模型`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "默认模型设置失败");
    } finally {
      setSaving(false);
    }
  };

  const handleEditSkill = async (skill: SkillSummary) => {
    setSkillActionId(skill.id);
    try {
      const full = await getSkill(skill.id);
      setEditingSkill(full);
      setEditorOpen(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载 Skill 失败");
    } finally {
      setSkillActionId(null);
    }
  };

  const handleDeleteSkill = (skill: SkillSummary) => {
    if (skill.source === "builtin") return;
    Modal.confirm({
      title: "删除该 Skill？",
      content: <p>删除后，<strong>{skill.name}</strong> 不会再参与后续 Workflow 匹配和提示词注入。</p>,
      okText: "删除",
      okButtonProps: { className: "settings-page__skill-button settings-page__skill-button--danger", danger: true },
      cancelText: "取消",
      async onOk() {
        setSkillActionId(skill.id);
        try {
          await deleteJsonSkill(skill.id);
          await refreshSkills();
          message.success("Skill 已删除");
        } finally {
          setSkillActionId(null);
        }
      },
    });
  };

  const handleResetSkill = (skill: SkillSummary) => {
    Modal.confirm({
      title: "重置内置 Skill？",
      content: <p>重置后会删除 <strong>{skill.name}</strong> 的本地覆盖配置，并恢复系统内置版本。</p>,
      okText: "重置",
      cancelText: "取消",
      async onOk() {
        setSkillActionId(skill.id);
        try {
          await resetBuiltinSkill(skill.id);
          await refreshSkills();
          message.success("Skill 已恢复为内置版本");
        } finally {
          setSkillActionId(null);
        }
      },
    });
  };

  return (
    <div className="settings-page">
      <div className="settings-page__header">
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>公共配置</Title>
          <Text type="secondary">管理跨项目共享的 Git/GitHub、公共 Skill 和全局 LLM 模型。</Text>
        </div>
        <Link className="settings-page__back" to="/dashboard">← 返回项目列表</Link>
      </div>

      {errorText && <Alert type="error" showIcon message="加载失败" description={errorText} style={{ marginBottom: 16 }} />}

      {loading || !draft ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Card className="settings-page__git-card" title="Git 与 GitHub" size="small">
            <div className="settings-page__git-grid">
              <label><span>Git 用户名</span><Input value={draft.git.userName ?? ""} onChange={(event) => handleGitChange("userName", event.target.value)} /></label>
              <label><span>Git 邮箱</span><Input value={draft.git.userEmail ?? ""} onChange={(event) => handleGitChange("userEmail", event.target.value)} /></label>
              <label><span>GitHub Owner</span><Input value={draft.git.githubOwner ?? ""} onChange={(event) => handleGitChange("githubOwner", event.target.value)} /></label>
              <label><span>GitHub Repo</span><Input value={draft.git.githubRepo ?? ""} onChange={(event) => handleGitChange("githubRepo", event.target.value)} /></label>
              <label><span>Base Branch</span><Input value={draft.git.githubBaseBranch ?? "main"} onChange={(event) => handleGitChange("githubBaseBranch", event.target.value)} /></label>
              <label><span>Remote</span><Input value={draft.git.githubRemote ?? "origin"} onChange={(event) => handleGitChange("githubRemote", event.target.value)} /></label>
            </div>
            <div className="settings-page__token-row">
              <label>
                <span>GitHub Token</span>
                <Input
                  value={githubTokenDraft ? "*".repeat(githubTokenDraft.length) : draft.git.githubTokenMasked}
                  onBlur={() => void syncGithubToken()}
                  onChange={() => undefined}
                  onKeyDown={handleGithubTokenKeyDown}
                  onPaste={handleGithubTokenPaste}
                  placeholder={draft.git.githubTokenConfigured ? "已配置" : "粘贴 GitHub token"}
                />
                <div className="settings-page__token-status">
                  <Tag className="settings-page__token-chip" color={draft.git.githubTokenConfigured ? "green" : "default"} variant="filled">
                    {draft.git.githubTokenConfigured ? `已配置 · ${draft.git.githubTokenSource === "settings" ? "设置" : "环境变量"}` : "未配置"}
                  </Tag>
                  <Button className="settings-page__skill-button settings-page__skill-button--danger" danger loading={saving} size="small" disabled={!draft.git.githubTokenConfigured || draft.git.githubTokenSource !== "settings" || Boolean(githubTokenDraft.trim())} onClick={() => void clearGithubTokenSetting()}>
                    重置
                  </Button>
                  {githubTokenDraft ? <Text type="secondary">失焦后自动同步：{githubTokenDraft.length} 位 Token</Text> : null}
                </div>
              </label>
            </div>
            <Paragraph className="settings-page__security-note">Token 只会发送到后端并以加密形式保存；前端不会回显明文。</Paragraph>
            <div className="settings-page__card-actions">
              <Button className="settings-page__skill-button" onClick={() => { setDraft(settings); setGithubTokenDraft(""); }} disabled={!gitDirty || saving}>撤销</Button>
              <Button className="settings-page__skill-button settings-page__skill-button--primary" onClick={() => void handleSaveGit()} loading={saving} disabled={!gitDirty}>保存 Git 配置</Button>
            </div>
          </Card>

          <Card
            className="settings-page__git-card"
            title="全局 LLM 模型"
            size="small"
            extra={<Button size="small" className="settings-page__skill-button settings-page__skill-button--primary" onClick={openCreateLlmModel}>新增</Button>}
          >
            <div className="settings-page__llm-list">
              {llmModels.length === 0 ? <Text type="secondary">暂无已注册模型。未配置时后端会使用 ARK_* 环境变量作为运行时兜底。</Text> : null}
              {llmModels.map((model) => (
                <article className="settings-page__llm-item" key={model.id}>
                  <div>
                    <strong>{model.displayName}</strong>
                    <Text type="secondary">{model.modelName} · {model.baseUrl}</Text>
                  </div>
                  <Space wrap>
                    {model.isDefault ? <Tag color="green" variant="filled">默认</Tag> : null}
                    {model.readOnly ? <Tag color="default" variant="filled">Runtime fallback</Tag> : null}
                    <Tag color={model.apiKeyConfigured ? "green" : "default"} variant="filled">{model.apiKeyConfigured ? `Token · ${model.apiKeySource}` : "未配置 Token"}</Tag>
                    <Button className="settings-page__skill-button" size="small" disabled={model.readOnly} onClick={() => openEditLlmModel(model)}>编辑</Button>
                    <Button size="small" className="settings-page__skill-button" disabled={model.isDefault || saving} onClick={() => void handleSetDefaultLlmModel(model)}>设为默认</Button>
                    <Button size="small" className="settings-page__skill-button settings-page__skill-button--danger" danger disabled={model.readOnly} onClick={() => handleDeleteLlmModel(model)}>删除</Button>
                  </Space>
                </article>
              ))}
            </div>
          </Card>
        </>
      )}

      <Card title="公共 Skill" size="small" className="settings-page__skill-card" extra={<Button size="small" className="settings-page__skill-button settings-page__skill-button--primary" onClick={() => { setEditingSkill(null); setEditorOpen(true); }}>新增</Button>}>
        {skills.length === 0 ? (
          <Text type="secondary">暂无已注册的 Skill。后端启动时自动注册 builtin/ 下的 Skill 文件。</Text>
        ) : (
          <div className="settings-page__skill-list">
            {skills.map((skill) => (
              <article key={skill.id} className="settings-page__skill-item">
                <div className="settings-page__skill-head">
                  <strong>{skill.name}</strong>
                  <Tag color="purple" variant="filled">{skill.id}</Tag>
                  <Tag color="default" variant="filled">v{skill.version}</Tag>
                  <Tag color={skill.source === "builtin" ? "default" : "orange"} variant="filled">{skill.source}</Tag>
                  {skill.builtin ? <Tag color={skill.overridden ? "gold" : "default"} variant="filled">{skill.overridden ? "已覆盖内置" : "内置"}</Tag> : null}
                </div>
                <div className="settings-page__skill-tags">
                  {skill.requirementPatterns.map((p) => <Tag key={p} color="blue" variant="filled">{p}</Tag>)}
                  {skill.scopes.map((s) => <Tag key={s} color="green" variant="filled">{s}</Tag>)}
                </div>
                <div className="settings-page__skill-meta">
                  <Text type="secondary">影响 Step: {skill.stepIds.join(", ")}{skill.matchKeywords?.length ? ` · 关键词: ${skill.matchKeywords.slice(0, 8).join(", ")}` : ""}</Text>
                </div>
                <div className="settings-page__skill-actions">
                  <Button size="small" className="settings-page__skill-button" disabled={skillActionId === skill.id} onClick={() => handleEditSkill(skill)}>编辑</Button>
                  {skill.builtin ? (
                    <Button size="small" className="settings-page__skill-button" disabled={skillActionId === skill.id} onClick={() => handleResetSkill(skill)}>重置</Button>
                  ) : (
                    <Button size="small" danger className="settings-page__skill-button settings-page__skill-button--danger" disabled={skillActionId === skill.id} onClick={() => handleDeleteSkill(skill)}>删除</Button>
                  )}
                </div>
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
          if (saved) await refreshSkills();
          setEditingSkill(null);
        }}
      />

      <Modal
        open={llmEditorOpen}
        title={llmDraft.editingId ? `编辑 ${llmDraft.displayName || llmDraft.editingId}` : "新增 LLM 模型"}
        width={640}
        onCancel={closeLlmEditor}
        footer={null}
        destroyOnClose
      >
        <div className="settings-page__llm-modal-form">
          <label>
            <span>Display Name</span>
            <Input value={llmDraft.displayName} onChange={(event) => setLlmDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="例如 Ark Pro" />
          </label>
          <label>
            <span>URL</span>
            <Input value={llmDraft.baseUrl} onChange={(event) => setLlmDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://..." />
          </label>
          <label>
            <span>Model Name</span>
            <Input value={llmDraft.modelName} onChange={(event) => setLlmDraft((current) => ({ ...current, modelName: event.target.value }))} placeholder="模型名称" />
          </label>
          <label>
            <span>Token</span>
            <Input
              value={llmDraft.apiKey ? "*".repeat(llmDraft.apiKey.length) : llmDraft.apiKeyMasked ?? ""}
              onChange={() => undefined}
              onKeyDown={handleLlmTokenKeyDown}
              onPaste={handleLlmTokenPaste}
              placeholder={llmDraft.editingId ? "已配置则显示等长星号，输入后覆盖" : "API Token"}
            />
          </label>
          <div className="settings-page__llm-controls">
            <Switch checked={Boolean(llmDraft.isDefault)} onChange={(checked) => setLlmDraft((current) => ({ ...current, isDefault: checked }))} /> 设为默认模型
          </div>
          <Space>
            <Button className="settings-page__skill-button settings-page__skill-button--primary" loading={saving} onClick={() => void handleSaveLlmModel()}>{llmDraft.editingId ? "保存" : "创建"}</Button>
            <Button className="settings-page__skill-button" onClick={closeLlmEditor}>取消</Button>
          </Space>
        </div>
      </Modal>
    </div>
  );
}
