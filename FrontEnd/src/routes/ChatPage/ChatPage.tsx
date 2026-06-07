import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Card, Drawer, Input, Modal, Space, Tag, Typography, message } from "antd";
import { createWorkflowRun, deleteWorkflowRun, getCurrentWorkspace, getProjectWorkspace, openWorkspace } from "../../api/client";
import { AppBreadcrumb } from "../../components/AppBreadcrumb/AppBreadcrumb";
import type { RequirementPattern } from "../../features/workflow/types";
import type { ProjectWorkspace, WorkflowRunSummary, WorkspaceContext } from "../../features/workspace/types";
import { loadWorkspace, saveWorkspace } from "../../features/workspace/workspaceStorage";
import "./ChatPage.css";

const { Paragraph, Text, Title } = Typography;
const { TextArea } = Input;

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
];

const workflowPreview = [
  { name: "确认需求", description: "先确认边界和关键决策。" },
  { name: "定位代码", description: "找到相关模块、文件和依赖。" },
  { name: "生成方案", description: "形成可执行的修改计划。" },
  { name: "修改代码", description: "写入变更并补充必要测试。" },
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

function formatStepName(value?: string) {
  const map: Record<string, string> = {
    requirement_intake: "接收需求",
    clarification: "确认需求",
    solution_design: "生成方案",
    module_mapping: "定位代码",
    code_generation: "准备修改",
    repo_write: "写入变更",
    verification: "验证结果",
    pull_request: "准备 PR",
    "Requirement Composer": "接收需求",
    "Clarifier Agent": "确认需求",
    "Planner Agent": "生成方案",
    "Context Locator": "定位代码",
    "Codegen Skill": "准备修改",
    Verifier: "验证结果",
    "PR Assistant": "准备 PR",
  };
  if (value && /Writer$/i.test(value)) return "写入变更";
  return value ? (map[value] ?? value) : "接收需求";
}

export function ChatPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [project, setProject] = useState<ProjectWorkspace | null>(null);
  const [requirement, setRequirement] = useState("");
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "creating" | "failed">("idle");
  const [loadError, setLoadError] = useState("");
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

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
        title: trimmedRequirement.slice(0, 28),
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
      okButtonProps: { danger: true, loading: deletingRunId === run.id },
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
        <Alert type="error" showIcon message={loadError} action={<Button onClick={() => navigate("/dashboard")}>返回 Dashboard</Button>} />
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
            AI 已读取当前项目上下文。描述你要交付的改动，系统会先确认关键决策，再定位代码、生成方案并验证结果。
          </Paragraph>
        </div>
        <Link className="requirement-hero__link" to="/dashboard">重新选择项目</Link>
      </section>

      <Card className="repo-summary-card" bordered={false}>
        <div className="repo-summary-card__main">
          <div>
            <Text className="eyebrow">{workspace.hasRepository ? "代码库已连接" : "项目上下文已准备"}</Text>
            <Title level={2}>{workspace.repoName}</Title>
            <Paragraph>{workspace.architectureSummary}</Paragraph>
          </div>
          <Button onClick={() => setIsContextOpen(true)}>查看 AI 上下文</Button>
        </div>

        <div className="repo-summary-card__signals">
          <span>AI 上下文就绪</span>
          <span>{workspace.repositoryScan?.filesInspected ?? 0} Files Indexed</span>
          <span>{workspace.agentReadme.fileName} Generated</span>
          <span>{workspace.repositoryScan?.source ?? workspace.mode}</span>
        </div>

        <Space className="repo-summary-card__stack" size={[8, 8]} wrap>
          {workspaceStack.map((item) => <Tag key={item} color="processing">{item}</Tag>)}
          {workspaceStack.length === 0 ? <Tag>Stack Pending</Tag> : null}
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
              <Tag color={submitStatus === "creating" ? "processing" : "default"}>AI 就绪</Tag>
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
              <Button type="primary" htmlType="submit" loading={submitStatus === "creating"} disabled={!requirement.trim()}>
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
                    <Tag color={getRunStatusColor(run.status)}>{getRunStatusLabel(run.status)}</Tag>
                    <div>
                      <strong>{run.title}</strong>
                      <span>{run.requirement}</span>
                    </div>
                    <small>{formatStepName(run.currentStep)} · {formatRelativeTime(run.updatedAt)}</small>
                  </button>
                  <Button
                    danger
                    type="text"
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
    </main>
  );
}
