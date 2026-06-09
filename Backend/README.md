# Super Individual Backend

Node.js backend for the Conduit delivery workbench. It exposes workflow, repository, metrics, and Agent orchestration APIs for the frontend.

## Tech Stack

- Node.js + TypeScript
- Express 4
- Zod for request and LLM output validation
- Vitest for unit tests
- Volcengine Ark Chat Completions-compatible API for LLM calls

## Setup

```bash
cd Backend
npm install
cp .env.example .env
```

Fill `.env` with local configuration:

```bash
PORT=3001
NODE_ENV=development

ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=

CONDUIT_REPO_PATH=
CORS_ORIGIN=http://localhost:5173
```

Do not commit `.env`. The real API key should stay local.

## Scripts

```bash
npm run dev          # start TypeScript dev server
npm run build        # compile to dist/
npm start            # run compiled server
npm test             # run unit tests
npm run typecheck    # TypeScript check without emit
npm run verify:api   # smoke-test API endpoints against a running server
```

For `verify:api`, start the server first:

```bash
npm run build
npm start
npm run verify:api
```

## API

Base URL defaults to `http://localhost:3001/api`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Service health check |
| `GET` | `/workflows/current` | Return the current workflow run, or 404 when none exists |
| `GET` | `/workflows/:runId` | Return one workflow run |
| `POST` | `/workflows` | Create a workflow from PM input |
| `POST` | `/workflows/:runId/steps/:stepId/run` | Execute one workflow step |
| `PATCH` | `/workflows/:runId/steps/:stepId` | Save human-edited step JSON |
| `POST` | `/workflows/:runId/replay` | Replay downstream steps from a given step |
| `GET` | `/repository` | Return Conduit repository snapshot |
| `GET` | `/metrics` | Return Agent call metrics |

## Workflow Model

The backend mirrors the frontend contract:

1. `requirement_intake`
2. `clarification`
3. `solution_design`
4. `module_mapping`
5. `code_generation`
6. `verification`
7. `pull_request`

Current persistence is in-memory, which is enough for local frontend integration. The next natural upgrade is event-sourced persistence for pause, edit, and replay history.

## LLM Behavior

Workflow steps and repository context generation call the Ark Chat Completions-compatible API when `ARK_API_KEY` and `ARK_MODEL` are configured.

Missing credentials or LLM failures are surfaced as errors. Runtime paths do not fall back to deterministic local Agent outputs.

## Repository Snapshot

If `CONDUIT_REPO_PATH` is set, `/api/repository` reads:

- current branch
- short commit hash
- dirty/clean status

If it is not set, the service returns a `checking` snapshot named `repository-not-configured` rather than a fake repository.

## Validation

Recommended local verification:

```bash
cd Backend
npm test
npm run typecheck
npm run build
npm start
npm run verify:api
```

Frontend integration expects:

```bash
VITE_API_BASE_URL=http://localhost:3001/api
```
