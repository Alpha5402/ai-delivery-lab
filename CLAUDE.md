# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Conduit Delivery Lab — an AI-driven workflow workbench that orchestrates multi-step software delivery: requirement intake → clarification → solution design → module mapping → code generation → repo write → verification → PR creation. Each step is backed by an LLM agent, with configurable execution modes (automatic vs. manual-confirmation).

## Repository Layout

```
Backend/          Node.js + Express API server (TypeScript, ESM)
FrontEnd/         React 18 + Vite SPA (TypeScript)
workspace/        Cloned repositories and runtime workspace data (gitignored)
docker-compose.yml  Production deployment (Nginx + Node)
```

## Commands

### Backend (`cd Backend`)

```bash
npm run dev          # Start dev server (tsx watch) on http://localhost:3001
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled server
npm test             # Run all vitest tests
npm run typecheck    # TypeScript check without emit (tsc --noEmit)
npm run verify:api   # Smoke-test API endpoints (requires running server)
```

### Frontend (`cd FrontEnd`)

```bash
npm run dev          # Start Vite dev server on http://localhost:5173 (proxies /api → :3001)
npm run build        # TypeScript build + Vite production build
npm test             # Run all vitest tests (jsdom environment)
npm run test:watch   # Run tests in watch mode
npm run preview      # Preview production build
npx tsc --noEmit     # TypeScript type-check
```

### Docker

```bash
docker compose up -d              # Start both services (backend :3001, frontend :80)
docker compose down               # Stop services
docker compose up -d --build      # Rebuild and restart
```

### Full-stack verification

```bash
cd Backend && npm test && npm run typecheck && npm run build
cd FrontEnd && npm test && npx tsc --noEmit
```

## Architecture

### Backend Layers

```
src/
├── server.ts              # Entry point: creates Express app, starts listening
├── app.ts                 # Express app factory: CORS, JSON, route mounting
├── config/env.ts          # Zod-validated env config (ARK_API_KEY, ARK_MODEL, etc.)
├── domain/workflow.ts     # Core domain types, Zod schemas, step definitions
├── domain/workspace.ts    # Workspace context types
├── routes/                # Express Router handlers (thin — delegate to services)
│   ├── workflowRoutes.ts  # CRUD + SSE stream + step actions (run/confirm/replay/restore)
│   ├── workspaceRoutes.ts # Import repo, create quick project, list/delete
│   ├── repositoryRoutes.ts
│   └── metricsRoutes.ts
├── services/              # Business logic
│   ├── workflowService.ts     # Core state machine: create, run, confirm, replay, auto-advance
│   ├── workflowEvents.ts      # Node EventEmitter — SSE broadcast on run mutation
│   ├── workflowSettingsService.ts  # Per-step execution mode config (automatic/manual)
│   ├── stepVerifiers.ts       # Post-LLM factual verification layer (deterministic checks per step)
│   ├── stepVerifiers.test.ts  # Tests for all verifier functions
│   ├── stepRouter.ts          # Scope-based routing: adjusts instructions & verification commands per step
│   ├── workspaceService.ts    # Git clone, local scan, quick-project creation
│   ├── workspaceStore.ts      # SQLite persistence for workspaces and workflow runs
│   ├── llmClient.ts           # Volcengine Ark Chat Completions API wrapper with Zod validation retry
│   ├── repositoryService.ts
│   ├── metricsService.ts
│   └── workspaceLogger.ts
├── agents/                    # Per-step agent implementations
│   ├── clarifierAgent.ts      # Steps 1→2 specialization
│   ├── plannerAgent.ts        # Steps 2→3 specialization
│   ├── workflowStepAgent.ts   # Generic agent for steps 4-8 (module_mapping through pull_request)
│   └── repositoryContextAgent.ts  # Generates readme-for-agent.md from scanned context
└── agentRuntime/              # Simple Claude Code-like agent runtime
    ├── simpleAgentRuntime.ts  # Assembles tool observations + LLM call for steps 4-8
    ├── toolRegistry.ts        # Runtime tools: list_files, read_file, git_status, read_agent_guide, detect_test_commands
    └── types.ts
```

### Post-LLM Verification Layer (`stepVerifiers.ts`)

After Zod schema validation, every step output passes through `runStepVerifier()` which applies deterministic factual checks:

- **clarification**: confidence ≥ 0.7, no unanswered high-risk questions (repairable: auto-retry once)
- **solution_design**: acceptanceCriteria ≥ 2 items, dataContract non-empty, userStory non-placeholder
- **module_mapping**: every referenced file exists in `repositoryScan.fileTree` or is explicitly declared as new
- **code_generation**: no empty task files, no path traversal in file paths, warns if no tasks require tests
- **repo_write**: `planned` mode → immediate `need-human` gate; `applied` mode → verifies files actually exist on disk
- **verification**: requires real command execution trace (not LLM self-declaration); failed commands → `need-human`

Each verifier returns `StepCheck[]` + `QualityGateResult` with one of four decisions: `auto-continue`, `need-human`, `repair` (retry), or `block`.

### Step Router (`stepRouter.ts`)

Dynamically adjusts agent instructions based on `RequirementDraft.pattern` and `SolutionDsl.scope`:

- **module_mapping**: Appends scope-specific hints (frontend-only → skip backend files, etc.)
- **verification**: Selects required vs. optional command sets per scope (e.g., frontend → typecheck+lint+test required, build optional)
- **clarification**: Triggers follow-up questions when confidence < 0.6

### Workflow State Machine

The core logic is in `workflowService.ts`. Key design patterns:

- **Auto-continue**: After each automatic step completes, the engine advances through subsequent automatic steps until it hits a `manual-confirmation` step or `failed` status. Managed by `advanceWorkflow()` with a reentry guard (`advancing` Set).
- **Commit-then-broadcast**: Every mutation goes through `commitRun()` which updates memory + SQLite + EventEmitter in one call, ensuring consistency.
- **SSE streaming**: `GET /workflows/:runId/stream` subscribes to the EventBus and pushes `update` (full run snapshot) and `step` (phase events) to the client via SSE with 15s heartbeats.
- **Snapshot history**: Every replay/regeneration snapshots the previous output before overwriting; users can browse and restore past versions via `/history` and `/restore` endpoints.
- **Confirm vs. Regenerate**: Explicit split — `POST /confirm` accepts the current output and advances, `POST /run` regenerates from scratch.
- **Quality gate integration**: After LLM output is produced, `stepVerifiers.runStepVerifier()` runs deterministic checks; the quality gate decision (`auto-continue` / `need-human` / `repair` / `block`) determines the next state machine transition.

### Agent Runtime for Steps 4-8

Steps 4–8 (module_mapping through pull_request) use `simpleAgentRuntime.ts`. It:
1. Reads the workspace's `readme-for-agent.md` (generated by `repositoryContextAgent`)
2. Runs runtime tools (`list_files`, `read_file` for priority files, `detect_test_commands`, `git_status`)
3. Sends the tool observations + workflow JSON to the LLM with a Zod schema
4. Steps 1-3 (requirement_intake, clarification, solution_design) have dedicated agent implementations

### Frontend Architecture

```
src/
├── App.tsx                # React Router 6 route definitions, wrapped in ErrorBoundary
├── main.tsx               # Entry point
├── api/client.ts          # Fetch wrapper for backend API
├── features/              # Feature modules (types, selectors, storage)
│   ├── workflow/          # Re-exports backend types via @backend/* alias
│   ├── workspace/
│   ├── repository/
│   └── observability/
├── components/            # Reusable UI components
│   ├── ErrorBoundary/     # React error boundary with Ant Design Result fallback
│   ├── PageSkeleton/      # Loading skeleton placeholder
│   ├── StepTimeline/      # 8-step pipeline visualization
│   ├── JsonPanel/         # JSON editor/viewer for step outputs
│   ├── ReplayControls/    # History browsing and snapshot restore
│   ├── RequirementComposer/  # PM input form with pattern selection
│   ├── AgentCard/         # Agent info display card
│   ├── StatusBadge/       # Step status indicator
│   ├── MetricCard/        # Token usage and cost metrics
│   ├── TestResultPanel/   # Verification command results display
│   └── RepositoryChanges/ # File diff summary
├── routes/                # Page components
│   ├── StartPage/         # Dashboard — create workflow or import repo
│   ├── WorkbenchPage/     # Main workflow view — steps, SSE subscription, interventions
│   ├── SettingsPage/      # Per-step execution mode configuration
│   ├── ChatPage/          # Chat interface
│   └── NotFoundPage/
├── lib/                   # Pure utilities (cost calculation, JSON validation, formatters, reading stats)
├── hooks/                 # Custom React hooks
└── styles/                # Global CSS + design tokens (tokens.css)
```

**Type sharing**: Frontend imports types from backend source via `@backend/*` path alias (configured in both `tsconfig.json` paths and `vite.config.ts` resolve alias). Only `import type` is used — Zod schemas are never bundled into the frontend.

**SSE-driven state**: `WorkbenchPage` subscribes to `GET /workflows/:runId/stream`. The server pushes full `WorkflowRun` snapshots on every state change — the frontend replaces its entire run state rather than maintaining a local state machine.

## Key Design Decisions

- **ESM modules** throughout (`"type": "module"` in both package.json files)
- **Zod-first validation**: Request payloads, LLM outputs, and env config are all validated with Zod schemas defined in `domain/workflow.ts`
- **LLM retry harness**: `callJsonLlmWithSchema()` retries up to 2 times on JSON parse failure or Zod validation failure, feeding the error back to the model
- **Deterministic verification after LLM output**: `stepVerifiers.ts` runs factual checks (file existence, confidence thresholds, command trace presence) after Zod schema validation; quality gate decisions (`auto-continue` / `need-human` / `repair` / `block`) gate the workflow state machine
- **Scope-aware routing**: `stepRouter.ts` reads `RequirementDraft.pattern` and `SolutionDsl.scope` to tailor agent instructions and verification command policies per scope (frontend/backend/fullstack)
- **Real verification**: `verification` step executes actual typecheck/lint/test/build commands via `run_command` tool; results come from real command traces, not LLM self-declaration
- **Real PR creation**: `pull_request` step performs git config → create branch → commit → push → GitHub API PR creation when credentials are configured; falls back to `pending://pull-request` without tokens
- **No client-side state machine**: The backend is the sole source of truth; the frontend is purely presentational with SSE-driven updates
- **Eventual consistency for SQLite**: Workflow runs are persisted to SQLite via `workspaceStore.ts` but the in-memory Map is the primary read source during active sessions

## Git / GitHub 配置

真实 PR 创建和 git 操作需要以下环境变量（见 `.env.example`）：

```env
GIT_USER_NAME=            # commit author name
GIT_USER_EMAIL=           # commit author email
GITHUB_TOKEN=             # GitHub fine-grained token (需 contents r/w + pull requests r/w)
# GITHUB_OWNER=           # 无法从 remote 推断时手动指定
# GITHUB_REPO=            # 同上
GITHUB_BASE_BRANCH=main
GITHUB_REMOTE=origin
```

Token 获取: GitHub Settings → Developer settings → Fine-grained tokens → 选择目标仓库 → Contents: Read and Write + Pull requests: Read and Write。不推荐使用密码。所有敏感信息仅从 `.env` 读取，不进入日志、不进入版本控制。

## Skill / Agent / Orchestrator 分层架构

### 概述

Skill 是"新增需求模式不改主干"的核心抽象。每个 Skill 是一个 TypeScript 文件，声明匹配规则和按 step 拆分的 prompt 注入规格。主干 workflow 保持 8 步不变，不引入跳步。

### 目录结构

```
Backend/src/skills/
  skillTypes.ts       # SkillManifest, SkillStepSpec 类型定义
  skillRegistry.ts    # registerSkill / listSkills / selectSkill / getSkillStepSpec
  builtin/
    index.ts          # registerBuiltinSkills() — 启动时注册所有内置 Skill
    frontendDisplayComputedMetric.skill.ts  # 前端计算指标展示
    crossStackAddField.skill.ts             # 跨栈新增字段
```

### 核心抽象

```ts
type SkillManifest = {
  id: string;         // 全局唯一 id
  name: string;
  version: string;
  requirementPatterns: Array<"frontend-only" | "cross-stack" | "interaction" | "unclear">;
  scopes: Array<"frontend" | "backend" | "fullstack">;
  match: { keywords?: string[]; fileGlobs?: string[]; routeHints?: string[] };
  steps: Partial<Record<WorkflowStepId, SkillStepSpec>>;  // 仅填该 Skill 关注的 step
};
```

### 匹配规则

`selectSkill(run)` 基于：
1. `requirement.pattern` 匹配 `requirementPatterns`
2. `solution.scope` 匹配 `scopes`
3. `requirement.rawText` 对 `match.keywords` 做命中计数
4. 取命中关键词最多的 Skill

### Prompt 组装链（三层叠加）

```
base agentSpec (workflowStepAgent.ts agentSpecs)
  → stepRouter addon (scope/pattern 动态追加)
    → Skill addon (instructionAddon + outputContractAddon)
```

每层只做追加，不做替换。最终 instruction 传递给 `simpleAgentRuntime.ts` 组装 system prompt。

### 如何新增一个 Skill

1. 在 `Backend/src/skills/builtin/` 新建 `.skill.ts` 文件
2. 导出 `SkillManifest` 对象
3. 在 `builtin/index.ts` 中 import 并 `registerSkill()`
4. 重启后端，Skill 自动生效

**不需要改** `workflowService.ts`、`workflowStepAgent.ts`（硬编码部分）、`stepRouter.ts` 或 workflow schema。

### Skill 命中可见性

- `runtimeTrace.selectedSkillId` 记录命中的 Skill id
- 前端 WorkbenchPage 右侧面板展示紫色 `SkillBadge` 标签
- `GET /api/skills` 列出所有已注册 Skill 摘要
- `GET /api/skills/:id` 查看完整 manifest

### 设计约束

- P0: TypeScript 文件注册，可测试、可审计
- P1: UI 管理（Skill 编辑器）
- 不允许用户在 UI 中任意输入代码动态执行
- 主干 workflow step 数量保持 8 个，Skill 不引入跳步
