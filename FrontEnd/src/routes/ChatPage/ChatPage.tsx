import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Card, Collapse, Drawer, Input, Modal, Segmented, Select, Space, Switch, Tabs, Tag, Typography, message } from "antd";
import {
  createWorkflowRun,
  deleteRequirementCase,
  deleteWorkflowRun,
  fetchProjectSettings,
  favoriteWorkflowRunCase,
  getCurrentWorkspace,
  getProjectWorkspace,
  listLlmModels,
  listRequirementCases,
  listSkills,
  openWorkspace,
  updateProjectSettings,
  type LlmModel,
  type ProjectSettings,
  type ProjectSettingsPatch,
  type ProjectSkillSetting,
  type SkillManifest,
  type SkillSummary,
  type VerificationCommandSetting,
  type WorkflowStepExecutionMode,
} from "../../api/client";
import { AppBreadcrumb } from "../../components/AppBreadcrumb/AppBreadcrumb";
import { useDefaultWorkflowTemplate } from "../../features/workflow/workflowTemplate";
import { SkillEditorModal } from "../SettingsPage/SkillEditorModal";
import type { RequirementPattern, WorkflowStepId } from "../../features/workflow/types";
import type { ProjectWorkspace, RequirementCase, WorkflowRunSummary, WorkspaceContext } from "../../features/workspace/types";
import { loadWorkspace, saveWorkspace } from "../../features/workspace/workspaceStorage";
import "./ChatPage.css";

const { Paragraph, Text, Title } = Typography;
const { TextArea } = Input;

const modeOptions: { label: string; value: WorkflowStepExecutionMode }[] = [
  { label: "自动续跑", value: "automatic" },
  { label: "需审核", value: "manual-confirmation" },
];

const modeDescription: Partial<Record<WorkflowStepId, string>> = {
  requirement_intake: "接收用户需求，通常无需干预。",
  clarification: "确认关键需求与约束，建议人工确认。",
  solution_design: "生成交付方案，是后续修改的基础，建议人工确认。",
  code_generation: "生成并写入代码变更，必须人工确认后再验证。",
  code_review: "审查生成的代码变更，建议人工确认。",
  verification: "验证结果会执行当前项目启用的门禁命令。",
  pull_request: "提交 PR 涉及外部副作用，建议人工确认。",
};

const suggestedTasks = [
  {
    title: "增加文章字数统计",
    description: "在文章详情页基于 Article.body 计算并展示字数。",
    prompt: "文章详情页新增字数统计，前端根据 Article.body 计算，并在合适位置展示。",
  },
  {
    title: "评论点赞能力",
    description: "为评论增加点赞接口和前端交互，后端需要保证幂等。",
    prompt: "评论支持点赞，要求后端幂等，前端展示点赞状态和数量，并补充纯逻辑测试。",
  },
  {
    title: "登录状态迁移",
    description: "将散落的登录状态收敛到统一 Context，减少重复判断。",
    prompt: "将登录状态迁移到统一的 React Context，梳理调用点，保持现有页面行为不变。",
  },
  {
    title: "文章列表加阅读量字段",
    description: "在首页文章卡片上增加阅读量 icon + 数字展示（前端假数据即可，不改后端）",
    prompt: "在首页文章卡片上增加阅读量 icon + 数字展示（前端假数据即可，不改后端）"
  },
  {
    title: "Popular Tags 侧边栏前 5 个打标",
    description: "为接口返回的前 5 个标签增加视觉标识（纯前端取前 5，不引入排序语义）",
    prompt: "为接口返回的前 5 个标签增加视觉标识（纯前端取前 5，不引入排序语义）"
  },
  {
    title: "个人主页新增 About Me Tab",
    description: "在 Profile 页面现有 My Articles / Favorited Articles 之外新增一个 About Me Tab，展示 User.bio",
    prompt: "在 Profile 页面现有 My Articles / Favorited Articles 之外新增一个 About Me Tab，展示 User.bio"
  },
  {
    title: "文章加封面图字段",
    description: "Article 模型加 coverImage 字段，新建/编辑文章表单支持输入 URL，列表卡片和详情页展示封面图",
    prompt: "Article 模型加 coverImage 字段，新建/编辑文章表单支持输入 URL，列表卡片和详情页展示封面图"
  },
  {
    title: "评论支持点赞（含幂等）",
    description: "Comment 增加 likeCount，并设计幂等点赞机制",
    prompt: "Comment 增加 likeCount，并设计幂等点赞机制"
  },
  {
    title: "文章草稿功能",
    description: "Article 增加 status 枚举（draft/published），编辑器新增“保存草稿”，列表默认过滤 draft，个人主页增加 Drafts Tab",
    prompt: "Article 增加 status 枚举（draft/published），编辑器新增“保存草稿”，列表默认过滤 draft，个人主页增加 Drafts Tab"
  }, 
  {
    title: "文章最后编辑时间展示",
    description: "利用 updatedAt 在文章详情页展示“最后编辑于 X 小时前”，同时后端保证 update 会刷新该字段",
    prompt: "利用 updatedAt 在文章详情页展示“最后编辑于 X 小时前”，同时后端保证 update 会刷新该字段"
  }
];

const workflowPreview = [
  { name: "确认需求", description: "先确认边界和关键决策。" },
  { name: "生成方案", description: "形成可执行的修改计划。" },
  { name: "生成代码", description: "定位文件、生成变更并补充必要测试。" },
  { name: "代码审查", description: "复核生成结果并按意见修复。" },
  { name: "验证结果", description: "运行校验并汇总交付风险。" },
];

const deliveryPhases = workflowPreview.map((step) => step.name);

function inferPattern(requirement: string): RequirementPattern {
  if (/后端|数据库|接口|幂等|模型|schema/i.test(requirement)) {
    return "cross-stack";
  }

  if (/点击|交互|弹窗|拖拽|点赞/i.test(requirement)) {
    return "interaction";
  }

  if (/前端|展示|页面|列表|详情/i.test(requirement)) {
    return "frontend-only";
  }

  return "unclear";
}

function getWorkspaceDirectory(workspace: WorkspaceContext) {
  return workspace.workspaceDir ?? workspace.repositoryScan?.repoPath ?? "未记录";
}

function getStack(workspace: WorkspaceContext) {
  return workspace.repositoryScan?.stack.length ? workspace.repositoryScan.stack : workspace.agentReadme.sections.stack;
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "recently";
  const diffMs = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 2 * day) return "yesterday";
  return `${Math.floor(diffMs / day)}d ago`;
}

function getRunStatusColor(status: WorkflowRunSummary["status"]) {
  if (status === "running") return "processing";
  if (status === "success") return "success";
  if (status === "failed") return "error";
  return "warning";
}

function getRunStatusLabel(status: WorkflowRunSummary["status"]) {
  if (status === "running") return "运行中";
  if (status === "success") return "已完成";
  if (status === "failed") return "失败";
  return "需要确认";
}

function createVerificationCommandDraft(): VerificationCommandSetting {
  return {
    id: `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: "新增检查项",
    command: "",
    enabled: true,
  };
}

function formatStepName(value?: string) {
  const map: Record<string, string> = {
    requirement_intake: "接收需求",
    clarification: "确认需求",
    solution_design: "生成方案",
    module_mapping: "生成代码",
    code_generation: "生成代码",
    repo_write: "生成代码",
    verification: "验证结果",
    pull_request: "提交 PR",
    "Requirement Composer": "接收需求",
    "Clarifier Agent": "确认需求",
    "Planner Agent": "生成方案",
    "Context Locator": "生成代码",
    "Codegen Skill": "生成代码",
    Verifier: "验证结果",
    "PR Assistant": "提交 PR",
  };
  if (value && /Writer$/i.test(value)) return "生成代码";
  return value ? (map[value] ?? value) : "接收需求";
}

export function ChatPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const { template } = useDefaultWorkflowTemplate();
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [project, setProject] = useState<ProjectWorkspace | null>(null);
  const [requirement, setRequirement] = useState("");
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [isCaseLibraryOpen, setIsCaseLibraryOpen] = useState(false);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [projectSettings, setProjectSettings] = useState<ProjectSettings | null>(null);
  const [projectSettingsDraft, setProjectSettingsDraft] = useState<ProjectSettings | null>(null);
  const [projectSettingsLoading, setProjectSettingsLoading] = useState(false);
  const [llmModels, setLlmModels] = useState<LlmModel[]>([]);
  const [publicSkills, setPublicSkills] = useState<SkillSummary[]>([]);
  const [isProjectSkillEditorOpen, setIsProjectSkillEditorOpen] = useState(false);
  const [editingProjectSkill, setEditingProjectSkill] = useState<SkillManifest | null>(null);
  const [requirementCases, setRequirementCases] = useState<RequirementCase[]>([]);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "creating" | "failed">("idle");
  const [loadError, setLoadError] = useState("");
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [caseActionId, setCaseActionId] = useState<string | null>(null);
  const projectSettingsAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectSettingsAutosaveSeqRef = useRef(0);

  useEffect(() => {
    let isMounted = true;

    async function hydrateProject() {
      const cachedWorkspace = loadWorkspace();
      let activeProjectId = projectId ?? cachedWorkspace?.id;

      // 如果没有 projectId 且 session 缓存为空，尝试从后端获取当前 workspace
      if (!activeProjectId) {
        try {
          const currentWs = await getCurrentWorkspace();
          if (currentWs?.id) {
            activeProjectId = currentWs.id;
            saveWorkspace(currentWs);
          }
        } catch {
          // 后端无当前 workspace，跳转首页
        }
      }

      if (!activeProjectId) {
        navigate("/dashboard", { replace: true });
        return;
      }

      try {
        const [workspaceContext, projectWorkspace] = await Promise.all([
          openWorkspace(activeProjectId),
          getProjectWorkspace(activeProjectId),
        ]);

        if (!isMounted) return;
        saveWorkspace(workspaceContext);
        setWorkspace(workspaceContext);
        setProject(projectWorkspace);

        if (!projectId) {
          navigate(`/project/${activeProjectId}`, { replace: true });
        }
      } catch {
        if (!isMounted) return;
        if (cachedWorkspace && cachedWorkspace.id === activeProjectId) {
          setWorkspace(cachedWorkspace);
        } else {
          setLoadError("项目工作空间加载失败，请确认 Backend 服务已启动且 SQLite 数据库可访问。");
        }
      }
    }

    void hydrateProject();
    return () => {
      isMounted = false;
    };
  }, [navigate, projectId]);

  const workspaceStack = useMemo(() => (workspace ? getStack(workspace).slice(0, 6) : []), [workspace]);
  const projectSettingsDirty = useMemo(
    () => JSON.stringify(projectSettings) !== JSON.stringify(projectSettingsDraft),
    [projectSettings, projectSettingsDraft],
  );

  function buildProjectSettingsPatch(settings: ProjectSettings): ProjectSettingsPatch {
    return {
      verificationCommands: settings.verificationCommands.filter((command) => command.id.trim() && command.name.trim() && command.command.trim()),
      stepExecutionModes: settings.stepExecutionModes,
      selectedLlmModelId: settings.selectedLlmModelId || null,
      excludedPublicSkillIds: settings.excludedPublicSkillIds ?? [],
      projectSkills: settings.projectSkills.filter((skill) => skill.id.trim()),
    };
  }

  useEffect(() => {
    if (projectSettingsLoading || !workspace?.id || !projectSettingsDraft || !projectSettingsDirty) {
      return;
    }

    if (projectSettingsAutosaveTimerRef.current) {
      clearTimeout(projectSettingsAutosaveTimerRef.current);
    }

    const projectIdForSave = workspace.id;
    const draftSnapshot = projectSettingsDraft;
    const draftSnapshotJson = JSON.stringify(draftSnapshot);
    const seq = projectSettingsAutosaveSeqRef.current + 1;
    projectSettingsAutosaveSeqRef.current = seq;

    projectSettingsAutosaveTimerRef.current = setTimeout(() => {
      void updateProjectSettings(projectIdForSave, buildProjectSettingsPatch(draftSnapshot))
        .then((next) => {
          if (projectSettingsAutosaveSeqRef.current !== seq) return;
          setProjectSettings(next);
          setProjectSettingsDraft((current) => {
            if (!current || JSON.stringify(current) === draftSnapshotJson) return next;
            return current;
          });
        })
        .catch((error: unknown) => {
          if (projectSettingsAutosaveSeqRef.current !== seq) return;
          const errorMessage = error instanceof Error ? error.message : "项目配置自动保存失败";
          message.error(errorMessage);
        });
    }, 600);

    return () => {
      if (projectSettingsAutosaveTimerRef.current) {
        clearTimeout(projectSettingsAutosaveTimerRef.current);
      }
    };
  }, [projectSettingsDirty, projectSettingsDraft, projectSettingsLoading, workspace?.id]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedRequirement = requirement.trim();
    if (!trimmedRequirement) {
      return;
    }

    setSubmitStatus("creating");
    try {
      const run = await createWorkflowRun({
        projectId: workspace?.id,
        workspaceId: workspace?.id,
        rawText: trimmedRequirement,
        pattern: inferPattern(trimmedRequirement),
        targetRepo: "conduit",
      });
      navigate(`/project/${workspace?.id}/workflow/${run.id}`, {
        state: { requirement: trimmedRequirement, workspaceId: workspace?.id },
      });
    } catch {
      setSubmitStatus("failed");
    }
  }

  async function refreshProjectAndCases() {
    if (!workspace?.id) return;
    const [projectWorkspace, cases] = await Promise.all([
      getProjectWorkspace(workspace.id),
      listRequirementCases(workspace.id),
    ]);
    setProject(projectWorkspace);
    setRequirementCases(cases);
  }

  async function openCaseLibrary() {
    if (!workspace?.id) return;
    setIsCaseLibraryOpen(true);
    try {
      setRequirementCases(await listRequirementCases(workspace.id));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "历史案例库加载失败");
    }
  }

  async function openProjectSettings() {
    if (!workspace?.id) return;
    setIsProjectSettingsOpen(true);
    setProjectSettingsLoading(true);
    try {
      const [settings, models, skills] = await Promise.all([
        fetchProjectSettings(workspace.id),
        listLlmModels().catch(() => [] as LlmModel[]),
        listSkills().catch(() => [] as SkillSummary[]),
      ]);
      setProjectSettings(settings);
      setProjectSettingsDraft(settings);
      setLlmModels(models);
      setPublicSkills(skills);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "项目配置加载失败");
    } finally {
      setProjectSettingsLoading(false);
    }
  }

  function updateVerificationCommand(
    id: string,
    key: keyof Pick<VerificationCommandSetting, "name" | "command" | "enabled">,
    value: string | boolean,
  ) {
    setProjectSettingsDraft((current) => current ? ({
      ...current,
      verificationCommands: current.verificationCommands.map((command) =>
        command.id === id ? { ...command, [key]: value } : command,
      ),
    }) : current);
  }

  function updateProjectSkill(
    id: string,
    patch: Partial<ProjectSkillSetting>,
  ) {
    setProjectSettingsDraft((current) => current ? ({
      ...current,
      projectSkills: current.projectSkills.map((skill) =>
        skill.id === id ? { ...skill, ...patch } : skill,
      ),
    }) : current);
  }

  function togglePublicSkillExcluded(skillId: string, excluded: boolean) {
    setProjectSettingsDraft((current) => current ? ({
      ...current,
      excludedPublicSkillIds: excluded
        ? Array.from(new Set([...(current.excludedPublicSkillIds ?? []), skillId]))
        : (current.excludedPublicSkillIds ?? []).filter((id) => id !== skillId),
    }) : current);
  }

  async function addProjectPrivateSkill(manifest: Record<string, unknown>) {
    const skill = manifest as SkillManifest;
    setProjectSettingsDraft((current) => current ? ({
      ...current,
      projectSkills: [
        ...current.projectSkills.filter((item) => item.id !== skill.id),
        {
          id: skill.id,
          enabled: true,
          name: skill.name,
          description: (skill as SkillManifest & { description?: string }).description,
          version: skill.version,
          requirementPatterns: skill.requirementPatterns,
          scopes: skill.scopes,
          match: skill.match,
          steps: skill.steps,
        },
      ],
    }) : current);
  }

  function openCreateProjectSkill() {
    setEditingProjectSkill(null);
    setIsProjectSkillEditorOpen(true);
  }

  function openEditProjectSkill(skill: ProjectSkillSetting) {
    setEditingProjectSkill({
      id: skill.id,
      source: "project",
      name: skill.name ?? skill.id,
      description: skill.description,
      version: skill.version ?? "1.0.0",
      requirementPatterns: skill.requirementPatterns ?? [],
      scopes: skill.scopes ?? [],
      match: skill.match ?? {},
      steps: skill.steps as SkillManifest["steps"],
    });
    setIsProjectSkillEditorOpen(true);
  }

  async function handleFavoriteRun(run: WorkflowRunSummary) {
    setCaseActionId(run.id);
    try {
      await favoriteWorkflowRunCase(run.id);
      await refreshProjectAndCases();
      message.success("需求已收藏到历史案例库");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "收藏需求失败");
    } finally {
      setCaseActionId(null);
    }
  }

  async function handleDeleteCase(item: RequirementCase) {
    if (!workspace?.id) return;
    setCaseActionId(item.id);
    try {
      await deleteRequirementCase(workspace.id, item.id);
      await refreshProjectAndCases();
      message.success("历史案例已移除");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "移除历史案例失败");
    } finally {
      setCaseActionId(null);
    }
  }

  function confirmDeleteRun(run: WorkflowRunSummary) {
    Modal.confirm({
      title: "删除该交付任务？",
      content: (
        <div>
          <p>这将删除阶段进度、运行日志、反馈历史与产出记录。</p>
          <p><strong>{run.title}</strong></p>
          <p className="workflow-delete-warning">该操作不可恢复。</p>
        </div>
      ),
      okText: "删除",
      okButtonProps: { className: "settings-page__skill-button settings-page__skill-button--danger", danger: true, loading: deletingRunId === run.id },
      cancelText: "取消",
      async onOk() {
        setDeletingRunId(run.id);
        try {
          await deleteWorkflowRun(run.id);
          setProject((current) => current ? {
            ...current,
            workflowRuns: current.workflowRuns.filter((item) => item.id !== run.id),
          } : current);
          message.success("交付任务已删除");
        } catch (currentError) {
          message.error(currentError instanceof Error ? currentError.message : "删除交付任务失败");
        } finally {
          setDeletingRunId(null);
        }
      },
    });
  }

  if (loadError) {
    return (
      <main className="requirement-page">
        <AppBreadcrumb project={projectId ? { id: projectId, name: "Loading Project..." } : undefined} />
        <Alert type="error" showIcon message={loadError} action={<Button className="settings-page__skill-button" onClick={() => navigate("/dashboard")}>返回 Dashboard</Button>} />
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="requirement-page">
        <AppBreadcrumb project={projectId ? { id: projectId, name: "Loading Project..." } : undefined} />
      </main>
    );
  }

  const projectBreadcrumb = {
    id: project?.id ?? workspace.id,
    name: project?.name ?? workspace.repoName ?? "Loading Project...",
  };

  return (
    <main className="requirement-page">
      <AppBreadcrumb project={projectBreadcrumb} />
      <section className="requirement-hero">
        <div>
          <Text className="eyebrow">项目任务中心</Text>
          <Title level={1}>{projectBreadcrumb.name}</Title>
          <Paragraph>
            AI 已读取当前项目上下文。描述你要交付的改动，系统会先确认关键决策，再生成方案、生成代码并验证结果。
          </Paragraph>
        </div>
        <Space>
          <Button className="settings-page__skill-button" onClick={openCaseLibrary}>历史案例库</Button>
          <Button className="settings-page__skill-button" onClick={() => setIsContextOpen(true)}>查看 AI 上下文</Button>
          <Button className="settings-page__skill-button settings-page__skill-button--primary" onClick={() => void openProjectSettings()}>项目配置</Button>
        </Space>
      </section>

      <Card className="repo-summary-card" bordered={false}>
        <div className="repo-summary-card__main">
          <div>
            <Text className="eyebrow">{workspace.hasRepository ? "代码库已连接" : "项目上下文已准备"}</Text>
            <Title level={2}>{workspace.repoName}</Title>
            <Paragraph>{workspace.architectureSummary}</Paragraph>
          </div>
        </div>

        <div className="repo-summary-card__signals">
          <span>AI 上下文就绪</span>
          <span>{workspace.repositoryScan?.filesInspected ?? 0} Files Indexed</span>
          <span>{workspace.agentReadme.fileName} Generated</span>
          <span>{workspace.repositoryScan?.source ?? workspace.mode}</span>
        </div>

        <Space className="repo-summary-card__stack" size={[8, 8]} wrap>
          {workspaceStack.map((item) => <Tag key={item} color="processing" variant="filled">{item}</Tag>)}
          {workspaceStack.length === 0 ? <Tag color="default" variant="filled">Stack Pending</Tag> : null}
        </Space>
      </Card>

      <section className="requirement-grid">
        <Card className="composer-card" bordered={false}>
          <form onSubmit={handleSubmit}>
            <div className="composer-card__header">
              <div>
                <Text className="eyebrow">新交付任务</Text>
                <Title level={2}>描述你要交付的改动</Title>
              </div>
              <Tag color={submitStatus === "creating" ? "processing" : "default"} variant="filled">AI 就绪</Tag>
            </div>

            <TextArea
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              autoSize={{ minRows: 8, maxRows: 14 }}
              placeholder="例如：在文章详情页展示正文纯文本字数，保持现有样式，并补充计算逻辑测试。"
            />

            <div className="delivery-phase-strip" aria-label="Delivery phases">
              {deliveryPhases.map((phase) => <span key={phase}>{phase}</span>)}
            </div>

            <div className="suggested-task-chips" aria-label="Suggested tasks">
              {suggestedTasks.map((task) => (
                <button key={task.title} type="button" onClick={() => setRequirement(task.prompt)}>
                  {task.title}
                </button>
              ))}
            </div>

            {submitStatus === "failed" ? (
              <Alert
                showIcon
                type="error"
                message="交付任务创建失败，请确认 Backend 服务已启动且 /api/workflows 可访问。"
              />
            ) : null}

            <div className="composer-card__actions">
              <Text type="secondary">描述目标、约束和验收标准，AI 会先确认关键决策。</Text>
              <Button className="settings-page__skill-button settings-page__skill-button--primary" htmlType="submit" loading={submitStatus === "creating"} disabled={!requirement.trim()}>
                {submitStatus === "creating" ? "正在创建任务..." : "开始交付"}
              </Button>
            </div>
          </form>
        </Card>

        <aside className="workflow-history">
          <div className="workflow-history__header">
            <div>
              <Text className="eyebrow">最近运行</Text>
              <Title level={3}>交付任务</Title>
            </div>
            <Text type="secondary">{project?.workflowRuns.length ?? 0} 个</Text>
          </div>

          {project?.workflowRuns.length ? (
            <div className="workflow-history__list">
              {project.workflowRuns.map((run) => (
                <div className="workflow-run-card" key={run.id}>
                  <button type="button" onClick={() => navigate(`/project/${workspace.id}/workflow/${run.id}`)}>
                    <Tag className="workflow-run-card__status" color={getRunStatusColor(run.status)} variant="filled">{getRunStatusLabel(run.status)}</Tag>
                    <div>
                      <strong>{run.title}</strong>
                      <span className="workflow-run-card__description">{run.requirement}</span>
                    </div>
                    <small>{formatStepName(run.currentStep)} · {formatRelativeTime(run.updatedAt)}</small>
                  </button>
                  {run.status === "success" ? (
                    <Button
                      className="settings-page__skill-button"
                      size="small"
                      disabled={run.caseFavorited || caseActionId === run.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleFavoriteRun(run);
                      }}
                    >
                      {run.caseFavorited ? "已收藏" : "收藏需求"}
                    </Button>
                  ) : null}
                  <Button
                    className="settings-page__skill-button settings-page__skill-button--danger"
                    danger
                    size="small"
                    loading={deletingRunId === run.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      confirmDeleteRun(run);
                    }}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="workflow-history__empty">还没有交付任务。创建第一个任务后，它会保留在当前项目下，之后可以继续、回放或查看结果。</p>
          )}
        </aside>
      </section>

      <Drawer
        title="AI 上下文"
        open={isContextOpen}
        width={720}
        onClose={() => setIsContextOpen(false)}
      >
        <div className="agent-context-drawer">
          <Text className="eyebrow">{workspace.agentReadme.fileName}</Text>
          <Title level={3}>{workspace.repoName}</Title>
          <Paragraph type="secondary">Workspace 目录：{getWorkspaceDirectory(workspace)}</Paragraph>
          {workspace.repoUrl ? <Paragraph><a href={workspace.repoUrl}>{workspace.repoUrl}</a></Paragraph> : null}
          <pre>{workspace.agentReadme.content}</pre>
        </div>
      </Drawer>

      <Drawer
        title="项目配置"
        open={isProjectSettingsOpen}
        width={860}
        onClose={() => setIsProjectSettingsOpen(false)}
      >
        {!projectSettingsDraft || projectSettingsLoading ? (
          <Text type="secondary">正在加载项目配置...</Text>
        ) : (
          <Tabs
            items={[
              {
                key: "verification",
                label: "门禁检查项",
                children: (
                  <div className="project-settings-panel">
                    <div className="project-settings-panel__head">
                      <Text type="secondary">命令会在 workspace 根目录执行，支持 cd 子目录后运行。</Text>
                      <Button
                        className="settings-page__skill-button"
                        size="small"
                        onClick={() => setProjectSettingsDraft((current) => current ? ({
                          ...current,
                          verificationCommands: [...current.verificationCommands, createVerificationCommandDraft()],
                        }) : current)}
                      >
                        新增检查项
                      </Button>
                    </div>
                    {projectSettingsDraft.verificationCommands.length === 0 ? (
                      <Text type="secondary">未配置门禁检查项。验证结果阶段不会执行命令。</Text>
                    ) : (
                      <div className="project-settings-command-list">
                        {projectSettingsDraft.verificationCommands.map((command) => (
                          <article className="project-settings-command" key={command.id}>
                            <Switch
                              checked={command.enabled}
                              checkedChildren="启用"
                              unCheckedChildren="关闭"
                              onChange={(checked) => updateVerificationCommand(command.id, "enabled", checked)}
                            />
                            <Input
                              value={command.name}
                              onChange={(event) => updateVerificationCommand(command.id, "name", event.target.value)}
                              placeholder="例如 Build"
                            />
                            <Input
                              value={command.command}
                              onChange={(event) => updateVerificationCommand(command.id, "command", event.target.value)}
                              placeholder="例如 cd frontend && npm run build"
                            />
                            <Button
                              className="settings-page__skill-button settings-page__skill-button--danger"
                              danger
                              size="small"
                              onClick={() => setProjectSettingsDraft((current) => current ? ({
                                ...current,
                                verificationCommands: current.verificationCommands.filter((item) => item.id !== command.id),
                              }) : current)}
                            >
                              删除
                            </Button>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: "execution",
                label: "执行模式",
                children: (
                  <div className="project-settings-mode-list">
                    {template.steps.map((step) => {
                      const stepId = step.id as WorkflowStepId;
                      return (
                        <article className="project-settings-mode" key={stepId}>
                          <div>
                            <strong>{step.label}</strong>
                            <span>{step.agent} · {modeDescription[stepId] ?? step.outputSchemaId}</span>
                          </div>
                          <Segmented
                            options={modeOptions}
                            value={projectSettingsDraft.stepExecutionModes[stepId] ?? step.defaultExecutionMode}
                            onChange={(value) => setProjectSettingsDraft((current) => current ? ({
                              ...current,
                              stepExecutionModes: { ...current.stepExecutionModes, [stepId]: value as WorkflowStepExecutionMode },
                            }) : current)}
                            disabled={stepId === "requirement_intake"}
                          />
                        </article>
                      );
                    })}
                  </div>
                ),
              },
              {
                key: "skills",
                label: "项目 Skill",
                children: (
                  <div className="project-settings-panel">
                    <div className="project-settings-panel__head">
                      <Text type="secondary">公共 Skill 默认参与当前项目；可按项目排除，也可以新增仅当前项目可用的私有 Skill。</Text>
                      <Button className="settings-page__skill-button" size="small" onClick={openCreateProjectSkill}>新增</Button>
                    </div>
                    <div className="project-settings-skill-section">
                      <strong>公共 Skill</strong>
                      {publicSkills.length === 0 ? (
                        <Text type="secondary">暂无公共 Skill。</Text>
                      ) : (
                        <div className="project-settings-skill-list">
                          {publicSkills.map((skill) => {
                            const excluded = (projectSettingsDraft.excludedPublicSkillIds ?? []).includes(skill.id);
                            return (
                              <article className="project-settings-skill project-settings-skill--compact" key={skill.id}>
                                <div className="project-settings-skill__meta">
                                  <strong>{skill.name}</strong>
                                  <span>{skill.id} · v{skill.version}</span>
                                </div>
                                <Space>
                                  {skill.requirementPatterns.slice(0, 3).map((pattern) => <Tag key={pattern} color="blue" variant="filled">{pattern}</Tag>)}
                                  <Switch
                                    checked={!excluded}
                                    checkedChildren="启用"
                                    unCheckedChildren="排除"
                                    onChange={(checked) => togglePublicSkillExcluded(skill.id, !checked)}
                                  />
                                </Space>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="project-settings-skill-section">
                      <strong>项目私有 Skill</strong>
                      {projectSettingsDraft.projectSkills.length === 0 ? (
                        <Text type="secondary">暂无项目私有 Skill。点击“新增项目 Skill”创建后，只会在当前项目参与匹配。</Text>
                      ) : (
                        <div className="project-settings-skill-list">
                          {projectSettingsDraft.projectSkills.map((skill) => (
                            <article className="project-settings-skill project-settings-skill--compact" key={skill.id}>
                              <div className="project-settings-skill__meta">
                                <strong>{skill.name ?? skill.id}</strong>
                                <span>{skill.id}{skill.version ? ` · v${skill.version}` : ""}</span>
                              </div>
                              <Space>
                                {(skill.requirementPatterns ?? []).slice(0, 3).map((pattern) => <Tag key={pattern} color="blue" variant="filled">{pattern}</Tag>)}
                                <Switch
                                  checked={skill.enabled}
                                  checkedChildren="启用"
                                  unCheckedChildren="关闭"
                                  onChange={(checked) => updateProjectSkill(skill.id, { enabled: checked })}
                                />
                                <Button
                                  className="settings-page__skill-button"
                                  size="small"
                                  onClick={() => openEditProjectSkill(skill)}
                                >
                                  编辑
                                </Button>
                                <Button
                                  className="settings-page__skill-button settings-page__skill-button--danger"
                                  danger
                                  size="small"
                                  onClick={() => setProjectSettingsDraft((current) => current ? ({
                                    ...current,
                                    projectSkills: current.projectSkills.filter((item) => item.id !== skill.id),
                                  }) : current)}
                                >
                                  删除
                                </Button>
                              </Space>
                            </article>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              },
              {
                key: "llm",
                label: "LLM",
                children: (
                  <div className="project-settings-panel">
                    <Text type="secondary">未选择时使用公共配置里的默认模型。</Text>
                    <Select
                      className="project-settings-llm-select"
                      value={projectSettingsDraft.selectedLlmModelId ?? ""}
                      onChange={(value) => setProjectSettingsDraft((current) => current ? ({ ...current, selectedLlmModelId: value || undefined }) : current)}
                      options={[
                        { label: "使用全局默认", value: "" },
                        ...llmModels.map((model) => ({
                          label: `${model.displayName}${model.isDefault ? "（全局默认）" : ""}`,
                          value: model.id,
                        })),
                      ]}
                    />
                  </div>
                ),
              },
            ]}
          />
        )}
      </Drawer>

      <SkillEditorModal
        open={isProjectSkillEditorOpen}
        editingSkill={editingProjectSkill}
        onSaveManifest={async (manifest) => {
          await addProjectPrivateSkill(manifest);
          setIsProjectSkillEditorOpen(false);
          setEditingProjectSkill(null);
        }}
        onClose={(saved) => {
          if (!saved) {
            setIsProjectSkillEditorOpen(false);
            setEditingProjectSkill(null);
          }
        }}
      />

      <Drawer
        title="历史案例库"
        open={isCaseLibraryOpen}
        width={760}
        onClose={() => setIsCaseLibraryOpen(false)}
      >
        {requirementCases.length === 0 ? (
          <p className="workflow-history__empty">暂无历史案例。完成交付任务后点击「收藏需求」，相似新需求会自动召回这些案例。</p>
        ) : (
          <Collapse
            items={requirementCases.map((item) => ({
              key: item.id,
              label: (
                <div className="case-library-row">
                  <strong>{item.title}</strong>
                  <span>{formatRelativeTime(item.updatedAt)}</span>
                </div>
              ),
              children: (
                <article className="case-library-detail">
                  <Paragraph>{item.requirementSummary}</Paragraph>
                  <Paragraph type="secondary">{item.solutionSummary}</Paragraph>
                  <Space size={[6, 6]} wrap>
                    {item.tags.map((tag) => <Tag key={tag} color="default" variant="filled">{tag}</Tag>)}
                    {item.touchedFiles.slice(0, 8).map((file) => <Tag key={file} color="blue" variant="filled">{file}</Tag>)}
                  </Space>
                  {item.acceptedConstraints.length ? (
                    <ul>
                      {item.acceptedConstraints.slice(0, 5).map((constraint) => <li key={constraint}>{constraint}</li>)}
                    </ul>
                  ) : null}
                  <Paragraph type="secondary">{item.verificationSummary}</Paragraph>
                  {item.pullRequestUrl ? <Paragraph><a href={item.pullRequestUrl}>{item.pullRequestUrl}</a></Paragraph> : null}
                  <Button
                    className="settings-page__skill-button settings-page__skill-button--danger"
                    danger
                    size="small"
                    disabled={caseActionId === item.id}
                    onClick={() => void handleDeleteCase(item)}
                  >
                    移除案例
                  </Button>
                </article>
              ),
            }))}
          />
        )}
      </Drawer>
    </main>
  );
}
