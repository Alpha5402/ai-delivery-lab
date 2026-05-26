import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Card, Input, Modal, Skeleton, Space, Spin, Timeline, Typography, message } from "antd";
import { deleteProjectWorkspace, importWorkspace, listRecentProjects, openWorkspace } from "../../api/client";
import type { ProjectWorkspace } from "../../features/workspace/types";
import { saveWorkspace } from "../../features/workspace/workspaceStorage";
import "./StartPage.css";

const { Paragraph, Text, Title } = Typography;

const defaultRepoUrl = "https://github.com/TonyMckes/conduit-realworld-example-app.git";

type StartFlowType = "local" | "git";
type StepStatus = "wait" | "loading" | "finish" | "error";
type StartFlowStepKey = "open-local" | "clone-repo" | "check-agent-readme" | "generate-agent-readme" | "enter-workspace";

type StartFlowStep = {
  key: StartFlowStepKey;
  title: string;
  description?: string;
  status: StepStatus;
};

function getErrorMessage(error: unknown, defaultError: string) {
  return error instanceof Error ? error.message : defaultError;
}

function createInitialSteps(type: StartFlowType): StartFlowStep[] {
  if (type === "git") {
    return [
      { key: "clone-repo", title: "克隆 Git 仓库", description: "正在获取远程仓库代码。", status: "wait" },
      { key: "check-agent-readme", title: "检查智能体上下文", description: "检查仓库内是否存在 readme-for-agent.md。", status: "wait" },
      { key: "generate-agent-readme", title: "生成智能体上下文", description: "调用仓库上下文智能体生成项目说明。", status: "wait" },
      { key: "enter-workspace", title: "进入工作区", description: "保存工作区并进入交付工作台。", status: "wait" },
    ];
  }

  return [
    { key: "open-local", title: "打开项目目录", description: "读取本地项目路径。", status: "wait" },
    { key: "check-agent-readme", title: "检查智能体上下文", description: "检查目录内是否存在 readme-for-agent.md。", status: "wait" },
    { key: "generate-agent-readme", title: "生成智能体上下文", description: "调用仓库上下文智能体生成项目说明。", status: "wait" },
    { key: "enter-workspace", title: "进入工作区", description: "保存工作区并进入交付工作台。", status: "wait" },
  ];
}

function updateStepStatus(steps: StartFlowStep[], key: StartFlowStepKey, status: StepStatus): StartFlowStep[] {
  return steps.map((step) => (step.key === key ? { ...step, status } : step));
}

function finishSteps(steps: StartFlowStep[]): StartFlowStep[] {
  return steps.map((step) => ({ ...step, status: "finish" }));
}

function markRunningStepError(steps: StartFlowStep[]): StartFlowStep[] {
  const loadingStep = steps.find((step) => step.status === "loading");
  if (loadingStep) {
    return updateStepStatus(steps, loadingStep.key, "error");
  }

  const waitingStep = steps.find((step) => step.status === "wait");
  return waitingStep ? updateStepStatus(steps, waitingStep.key, "error") : steps;
}

function getTimelineColor(status: StepStatus) {
  if (status === "finish") return "green";
  if (status === "error") return "red";
  if (status === "loading") return "blue";
  return "gray";
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "最近";
  }

  const diffMs = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;
  if (diffMs < 2 * day) return "昨天";
  return `${Math.floor(diffMs / day)} 天前`;
}

function getRecentWorkspaceActivity(project: ProjectWorkspace) {
  const latestRun = [...project.workflowRuns].sort((left, right) => {
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  })[0];

  if (!latestRun) {
    return "尚未启动工作流";
  }

  return latestRun.currentStep ? `最近运行：${latestRun.currentStep}` : latestRun.title;
}

function WorkspaceImportTimeline({ steps, error }: { steps: StartFlowStep[]; error: string }) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <div className="start-timeline">
      <Timeline
        items={steps.map((step) => ({
          color: getTimelineColor(step.status),
          dot: step.status === "loading" ? <Spin size="small" /> : undefined,
          children: (
            <div className="start-timeline__item">
              <Text strong>{step.title}</Text>
              {step.description ? <Paragraph type="secondary">{step.description}</Paragraph> : null}
              {step.status === "error" && error ? <Text type="danger">{error}</Text> : null}
            </div>
          ),
        }))}
      />
    </div>
  );
}

export function StartPage() {
  const navigate = useNavigate();
  const importSequence = useRef(0);
  const [recentProjects, setRecentProjects] = useState<ProjectWorkspace[]>([]);
  const [recentStatus, setRecentStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<StartFlowType | null>(null);
  const [repoUrl, setRepoUrl] = useState(defaultRepoUrl);
  const [localPath, setLocalPath] = useState("/Users/alpha/Github/ByteDance");
  const [steps, setSteps] = useState<StartFlowStep[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const isRunning = status === "running";
  const inputModalOpen = selectedFlow !== null && status === "idle";
  const progressModalOpen = status === "running" || status === "error";

  useEffect(() => {
    let isMounted = true;
    setRecentStatus("loading");
    listRecentProjects()
      .then((projects) => {
        if (!isMounted) return;
        setRecentProjects(projects);
        setRecentStatus("idle");
      })
      .catch(() => {
        if (!isMounted) return;
        setRecentStatus("failed");
      });

    return () => {
      isMounted = false;
    };
  }, []);

  function openFlowModal(type: StartFlowType) {
    setSelectedFlow(type);
    setStatus("idle");
    setError("");
    setSteps([]);
  }

  function closeFlowModal() {
    setSelectedFlow(null);
    setStatus("idle");
    setError("");
    setSteps([]);
  }

  function cancelImport() {
    importSequence.current += 1;
    closeFlowModal();
  }

  function updateImportSteps(sequence: number, updater: (current: StartFlowStep[]) => StartFlowStep[]) {
    setSteps((current) => (importSequence.current === sequence ? updater(current) : current));
  }

  async function handleOpenRecentProject(projectId: string) {
    setError("");
    try {
      const workspace = await openWorkspace(projectId);
      saveWorkspace(workspace);
      navigate(`/project/${projectId}`);
    } catch (currentError) {
      message.error(getErrorMessage(currentError, "打开最近项目失败，请确认 Backend 服务已启动且 SQLite 数据库可访问。"));
    }
  }

  function confirmDeleteProject(project: ProjectWorkspace) {
    Modal.confirm({
      title: "删除项目记录？",
      content: (
        <div className="delete-project-dialog">
          <p>你可以只删除历史记录，或者同时删除本地项目目录。</p>
          <p><strong>项目：</strong>{project.name}</p>
          <p className="delete-project-dialog__danger">删除项目目录属于危险操作，该操作不可恢复。</p>
        </div>
      ),
      okText: "仅删除记录",
      cancelText: "取消",
      async onOk() {
        await handleDeleteProject(project.id, false);
      },
      footer: (_, { OkBtn, CancelBtn }) => (
        <>
          <CancelBtn />
          <OkBtn />
          <Button danger loading={deletingProjectId === project.id} onClick={() => void handleDeleteProject(project.id, true)}>
            删除记录和项目目录
          </Button>
        </>
      ),
    });
  }

  async function handleDeleteProject(projectId: string, deleteDirectory: boolean) {
    setDeletingProjectId(projectId);
    try {
      await deleteProjectWorkspace(projectId, deleteDirectory);
      setRecentProjects((current) => current.filter((project) => project.id !== projectId));
      message.success(deleteDirectory ? "项目记录和本地目录已删除" : "项目记录已删除");
      Modal.destroyAll();
    } catch (currentError) {
      message.error(getErrorMessage(currentError, "删除项目失败，请确认 Backend 服务可用。"));
    } finally {
      setDeletingProjectId(null);
    }
  }

  async function handleGitImport(event: FormEvent) {
    event.preventDefault();
    const sequence = importSequence.current + 1;
    importSequence.current = sequence;
    setSelectedFlow("git");
    setStatus("running");
    setError("");
    setSteps(createInitialSteps("git"));

    const timers = [
      window.setTimeout(() => {
        updateImportSteps(sequence, (current) => updateStepStatus(updateStepStatus(current, "clone-repo", "finish"), "check-agent-readme", "loading"));
      }, 1200),
      window.setTimeout(() => {
        updateImportSteps(sequence, (current) => updateStepStatus(updateStepStatus(current, "check-agent-readme", "finish"), "generate-agent-readme", "loading"));
      }, 2200),
    ];

    try {
      updateImportSteps(sequence, (current) => updateStepStatus(current, "clone-repo", "loading"));
      const workspace = await importWorkspace(repoUrl);
      timers.forEach((timer) => window.clearTimeout(timer));
      if (importSequence.current !== sequence) return;
      setSteps((current) => finishSteps(current));
      saveWorkspace(workspace);
      setStatus("ready");
      navigate(`/project/${workspace.id}`);
    } catch (currentError) {
      timers.forEach((timer) => window.clearTimeout(timer));
      if (importSequence.current !== sequence) return;
      const message = getErrorMessage(currentError, "仓库导入失败，请确认 Git URL 正确且 Backend 服务可用。");
      setStatus("error");
      setError(message);
      setSteps((current) => markRunningStepError(current));
    }
  }

  async function handleLocalImport(event: FormEvent) {
    event.preventDefault();
    const sequence = importSequence.current + 1;
    importSequence.current = sequence;
    setSelectedFlow("local");
    setStatus("running");
    setError("");
    setSteps(createInitialSteps("local"));

    const timers = [
      window.setTimeout(() => {
        updateImportSteps(sequence, (current) => updateStepStatus(updateStepStatus(current, "check-agent-readme", "finish"), "generate-agent-readme", "loading"));
      }, 1000),
    ];

    try {
      updateImportSteps(sequence, (current) => updateStepStatus(updateStepStatus(current, "open-local", "finish"), "check-agent-readme", "loading"));
      const workspace = await importWorkspace(localPath);
      timers.forEach((timer) => window.clearTimeout(timer));
      if (importSequence.current !== sequence) return;
      setSteps((current) => finishSteps(current));
      saveWorkspace(workspace);
      setStatus("ready");
      navigate(`/project/${workspace.id}`);
    } catch (currentError) {
      timers.forEach((timer) => window.clearTimeout(timer));
      if (importSequence.current !== sequence) return;
      const message = getErrorMessage(currentError, "本地项目解析失败，请确认路径存在且 Backend 具备读取权限。");
      setStatus("error");
      setError(message);
      setSteps((current) => markRunningStepError(current));
    }
  }

  return (
    <main className="start-page">
      <section className="start-page__hero">
        <Text className="start-page__eyebrow">Conduit Runtime</Text>
        <Title level={1}>从端到端，将你的 idea 落地成现实</Title>
        <Paragraph>
          打开一个仓库，描述一次真实开发需求，然后进入可澄清、可规划、可定位上下文、可生成变更、可验证结果的 AI 运行时。
        </Paragraph>
        <Paragraph type="secondary">
          每一次工作流运行都会保留在项目工作区中，后续可以继续恢复、人工介入或从任意节点回放。
        </Paragraph>
      </section>

      <section className="start-page__actions" aria-label="Primary workspace actions">
        <Card
          className={`start-action-card ${selectedFlow === "local" ? "start-action-card--active" : ""}`}
          hoverable
          onClick={() => openFlowModal("local")}
        >
          <Space direction="vertical" size={10}>
            <Text className="start-action-card__kicker">本地工作区</Text>
            <Title level={3}>打开项目</Title>
            <Paragraph>接入已有代码库，让运行时生成可供智能体使用的项目上下文。</Paragraph>
            <Button type="primary">选择本地项目</Button>
          </Space>
        </Card>

        <Card
          className={`start-action-card ${selectedFlow === "git" ? "start-action-card--active" : ""}`}
          hoverable
          onClick={() => openFlowModal("git")}
        >
          <Space direction="vertical" size={10}>
            <Text className="start-action-card__kicker">远程仓库</Text>
            <Title level={3}>从 Git 克隆</Title>
            <Paragraph>克隆远程仓库，解析项目结构，并准备可持续运行的工作流空间。</Paragraph>
            <Button type="primary">输入 Git URL</Button>
          </Space>
        </Card>
      </section>

      <section className="recent-projects">
        <div className="recent-projects__header">
          <div>
            <Text className="start-page__eyebrow">继续工作</Text>
            <Title level={3}>最近工作区</Title>
          </div>
          {recentStatus === "loading" ? <Spin size="small" /> : null}
        </div>

        {recentStatus === "failed" ? (
          <Alert type="warning" showIcon message="最近项目暂时不可用，请确认 Backend 服务已启动。" />
        ) : null}

        {recentProjects.length > 0 ? (
          <div className="recent-projects__list">
            {recentProjects.slice(0, 4).map((project) => (
              <div className="recent-project-card" key={project.id}>
                <button type="button" onClick={() => void handleOpenRecentProject(project.id)}>
                  <span className="recent-project-card__name">{project.name}</span>
                  <span className="recent-project-card__activity">{getRecentWorkspaceActivity(project)}</span>
                  <span className="recent-project-card__meta">上次打开 {formatRelativeTime(project.lastOpenedAt)}</span>
                </button>
                <Button danger type="text" size="small" loading={deletingProjectId === project.id} onClick={() => confirmDeleteProject(project)}>
                  删除
                </Button>
              </div>
            ))}
          </div>
        ) : recentStatus === "loading" ? (
          <div className="recent-projects__list">
            <Skeleton.Input active style={{ width: "100%", height: 42 }} />
            <Skeleton.Input active style={{ width: "100%", height: 42 }} />
            <Skeleton.Input active style={{ width: "100%", height: 42 }} />
          </div>
        ) : recentStatus !== "failed" ? (
          <p className="recent-projects__empty">还没有最近工作区。打开本地项目或克隆仓库后，会在这里保留继续入口。</p>
        ) : null}
      </section>

      <Modal
        cancelText="取消"
        destroyOnHidden
        okText={selectedFlow === "git" ? "克隆并解析" : "解析项目"}
        onCancel={closeFlowModal}
        okButtonProps={{ form: "workspace-import-form", htmlType: "submit" }}
        open={inputModalOpen}
        title={selectedFlow === "git" ? "从 Git 克隆" : "打开本地项目"}
      >
        {selectedFlow === "local" ? (
          <form className="start-flow-form start-flow-form--modal" id="workspace-import-form" onSubmit={handleLocalImport}>
            <label>
              本地项目路径
              <Input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="/Users/alpha/Github/project" disabled={isRunning} />
            </label>
            <Text type="secondary">选择一个已有代码库目录，运行时会检查或生成智能体上下文。</Text>
          </form>
        ) : null}

        {selectedFlow === "git" ? (
          <form className="start-flow-form start-flow-form--modal" id="workspace-import-form" onSubmit={handleGitImport}>
            <label>
              Git 地址
              <Input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/user/repo.git" disabled={isRunning} />
            </label>
            <Text type="secondary">输入可访问的仓库地址。克隆完成后会自动解析项目结构并进入工作区。</Text>
          </form>
        ) : null}
      </Modal>

      <Modal
        cancelText="取消"
        closable={false}
        footer={[
          <Button key="cancel" onClick={cancelImport}>
            取消
          </Button>,
        ]}
        maskClosable={false}
        onCancel={cancelImport}
        open={progressModalOpen}
        title="导入进度"
      >
        <WorkspaceImportTimeline steps={steps} error={error} />
      </Modal>
    </main>
  );
}
