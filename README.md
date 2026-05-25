# Conduit Delivery Lab

An AI-driven workflow workbench that orchestrates multi-step software delivery — from requirement intake through clarification, solution design, code generation, verification, and PR creation.

## Architecture

```
conduit-delivery-lab/
├── Backend/          # Node.js + Express API server
├── FrontEnd/         # React + Vite SPA
└── Optimize_TODO.md  # Workflow optimization tracker
```

### Backend

- **Runtime**: Node.js + TypeScript (ESM)
- **Framework**: Express 4
- **Validation**: Zod schemas for request payloads and LLM outputs
- **Persistence**: SQLite via `node:sqlite` (workflow runs, workspace context)
- **LLM**: Volcengine Ark Chat Completions API
- **Real-time**: Server-Sent Events (SSE) for workflow state streaming

### Frontend

- **Framework**: React 18 + TypeScript
- **Build**: Vite
- **UI Library**: Ant Design
- **State**: Server-driven via SSE (`EventSource`) — no client-side state machine
- **Type Sharing**: `@backend/*` path alias imports types directly from backend source

## Quick Start

```bash
# 1. Backend
cd Backend
npm install
cp .env.example .env   # Fill ARK_API_KEY, ARK_MODEL, CONDUIT_REPO_PATH
npm run dev            # http://localhost:3001

# 2. Frontend
cd FrontEnd
npm install
npm run dev            # http://localhost:5173 (proxies /api → :3001)
```

## API Overview

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/workflows` | Create workflow run |
| `GET` | `/api/workflows/:runId` | Get run details |
| `DELETE` | `/api/workflows/:runId` | Delete run |
| `GET` | `/api/workflows/:runId/stream` | SSE real-time updates |
| `POST` | `/api/workflows/:runId/steps/:stepId/run` | Run/regenerate step |
| `POST` | `/api/workflows/:runId/steps/:stepId/confirm` | Confirm waiting step |
| `POST` | `/api/workflows/:runId/steps/:stepId/interventions` | User intervention |
| `PATCH` | `/api/workflows/:runId/steps/:stepId` | Edit step output |
| `POST` | `/api/workflows/:runId/replay` | Replay from step |
| `GET` | `/api/workflows/:runId/steps/:stepId/history` | Step replay history |
| `POST` | `/api/workflows/:runId/steps/:stepId/restore` | Restore snapshot |
| `GET/PATCH` | `/api/workflows/settings` | Execution mode config |
| `GET` | `/api/repository` | Repository snapshot |
| `GET` | `/api/metrics` | Agent call metrics |
| `GET/POST/DELETE` | `/api/workspaces/*` | Workspace management |

## Workflow Steps

| # | Step | Agent | Default Mode |
|---|------|-------|-------------|
| 1 | Requirement Intake | Requirement Composer | automatic |
| 2 | Clarification | Clarifier Agent | manual-confirmation |
| 3 | Solution Design | Planner Agent | manual-confirmation |
| 4 | Module Mapping | Context Locator | automatic |
| 5 | Code Generation | Codegen Skill | manual-confirmation |
| 6 | Repo Write | Conduit Writer | automatic |
| 7 | Verification | Verifier | automatic |
| 8 | Pull Request | PR Assistant | manual-confirmation |

Execution modes are configurable via the Settings page (`/settings`).

## Key Features

- **SSE Real-time Updates**: WorkbenchPage subscribes to `GET /workflows/:runId/stream` for live state changes
- **Configurable Execution Modes**: Each step can be set to `automatic` or `manual-confirmation`
- **Confirm / Run Split**: Explicit actions — "Confirm & continue" vs "Regenerate"
- **Replay History**: Every replay/regeneration snapshots the previous output; users can browse and restore past versions
- **Optimistic Updates**: Intervention messages appear immediately with rollback on failure
- **Type Sharing**: Frontend imports types from backend via `@backend/*` path alias (single source of truth)

## Development

```bash
# Backend tests
cd Backend && npm test

# Type checking
cd Backend && npm run typecheck
cd FrontEnd && npx tsc --noEmit
```
