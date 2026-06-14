import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { env } from "../config/env.js";
import type { AgentMetric } from "../domain/workflow.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type DailyMetric = {
  date: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  estimatedCost: number;
};

type AgentMetricRow = {
  agent: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  estimated_cost: number;
};

type DailyMetricRow = {
  date: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  latency_ms: number;
  estimated_cost: number;
};

const useMemoryStore = env.NODE_ENV === "test";
const memoryMetrics: AgentMetric[] = [];
const memoryDailyMetrics = new Map<string, DailyMetric>();

let metricsDb: InstanceType<typeof DatabaseSync> | null = null;

function getMetricsDb() {
  if (useMemoryStore) return null;
  if (metricsDb) return metricsDb;

  const absolutePath = path.resolve(env.WORKSPACE_DB_PATH);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  metricsDb = new DatabaseSync(absolutePath);
  metricsDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_metrics (
      agent TEXT PRIMARY KEY,
      calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date TEXT PRIMARY KEY,
      calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);
  `);
  return metricsDb;
}

/** 返回浅拷贝，避免外部引用修改 */
export function listMetrics(): AgentMetric[] {
  const db = getMetricsDb();
  if (!db) return memoryMetrics.map((m) => ({ ...m }));

  const rows = db.prepare(`
    SELECT agent, calls, input_tokens, output_tokens, latency_ms, estimated_cost
    FROM agent_metrics
    ORDER BY updated_at DESC, agent ASC
  `).all() as AgentMetricRow[];

  return rows.map((row) => ({
    agent: row.agent,
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    estimatedCost: row.estimated_cost,
  }));
}

export function listDailyMetrics(): DailyMetric[] {
  const db = getMetricsDb();
  if (!db) {
    return [...memoryDailyMetrics.values()]
      .map((item) => ({ ...item }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  const rows = db.prepare(`
    SELECT date, calls, input_tokens, output_tokens, total_tokens, latency_ms, estimated_cost
    FROM daily_metrics
    ORDER BY date ASC
  `).all() as DailyMetricRow[];

  return rows.map((row) => ({
    date: row.date,
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    latencyMs: row.latency_ms,
    estimatedCost: row.estimated_cost,
  }));
}

export function recordMetric(metric: AgentMetric) {
  const normalizedMetric = {
    ...metric,
    calls: Math.max(0, metric.calls),
    inputTokens: Math.max(0, metric.inputTokens),
    outputTokens: Math.max(0, metric.outputTokens),
    latencyMs: Math.max(0, metric.latencyMs),
    estimatedCost: Math.max(0, metric.estimatedCost),
  };

  const db = getMetricsDb();
  if (!db) {
    recordMemoryMetric(normalizedMetric);
  } else {
    recordSqliteMetric(db, normalizedMetric);
  }

  // 广播最新 metrics 到 SSE 订阅者（lazy import 避免循环依赖）
  import("./workflowEvents.js").then(({ workflowEventBus }) => {
    workflowEventBus.emitMetricsChanged(listMetrics());
  }).catch(() => undefined);
}

function recordMemoryMetric(metric: AgentMetric) {
  const existing = memoryMetrics.find((item) => item.agent === metric.agent);

  if (!existing) {
    memoryMetrics.push(metric);
  } else {
    existing.calls += metric.calls;
    existing.inputTokens += metric.inputTokens;
    existing.outputTokens += metric.outputTokens;
    existing.latencyMs += metric.latencyMs;
    existing.estimatedCost += metric.estimatedCost;
  }

  const date = formatLocalDateKey();
  const daily = memoryDailyMetrics.get(date) ?? {
    date,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    estimatedCost: 0,
  };
  daily.calls += metric.calls;
  daily.inputTokens += metric.inputTokens;
  daily.outputTokens += metric.outputTokens;
  daily.totalTokens += metric.inputTokens + metric.outputTokens;
  daily.latencyMs += metric.latencyMs;
  daily.estimatedCost += metric.estimatedCost;
  memoryDailyMetrics.set(date, daily);
}

function recordSqliteMetric(db: InstanceType<typeof DatabaseSync>, metric: AgentMetric) {
  const now = new Date().toISOString();
  const date = formatLocalDateKey();
  const totalTokens = metric.inputTokens + metric.outputTokens;

  db.prepare(`
    INSERT INTO agent_metrics (
      agent, calls, input_tokens, output_tokens, latency_ms, estimated_cost, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent) DO UPDATE SET
      calls = calls + excluded.calls,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      latency_ms = latency_ms + excluded.latency_ms,
      estimated_cost = estimated_cost + excluded.estimated_cost,
      updated_at = excluded.updated_at
  `).run(
    metric.agent,
    metric.calls,
    metric.inputTokens,
    metric.outputTokens,
    metric.latencyMs,
    metric.estimatedCost,
    now,
  );

  db.prepare(`
    INSERT INTO daily_metrics (
      date, calls, input_tokens, output_tokens, total_tokens, latency_ms, estimated_cost, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      calls = calls + excluded.calls,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      total_tokens = total_tokens + excluded.total_tokens,
      latency_ms = latency_ms + excluded.latency_ms,
      estimated_cost = estimated_cost + excluded.estimated_cost,
      updated_at = excluded.updated_at
  `).run(
    date,
    metric.calls,
    metric.inputTokens,
    metric.outputTokens,
    totalTokens,
    metric.latencyMs,
    metric.estimatedCost,
    now,
  );
}

function formatLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
