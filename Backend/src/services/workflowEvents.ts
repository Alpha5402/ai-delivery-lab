import { EventEmitter } from "node:events";
import type { AgentMetric, WorkflowRun, WorkflowStepId } from "../domain/workflow.js";

/**
 * Workflow 运行的事件总线：
 * - "update": run 整体快照变更
 * - "step": 某个 step 的局部事件
 * - "settings": 全局 settings 变更
 * - "metrics": 全局 agent metrics 变更（每次 recordMetric 后广播）
 *
 * 当前以全量 run 快照为主，后续若有性能问题再切换为 patch。
 */
export type WorkflowUpdateEvent = {
  type: "update";
  run: WorkflowRun;
};

export type WorkflowStepEvent = {
  type: "step";
  runId: string;
  stepId: WorkflowStepId;
  phase: "started" | "completed" | "failed" | "waiting-human";
  message?: string;
};

export type SettingsChangedEvent = {
  type: "settings";
  settings: unknown;
};

export type MetricsChangedEvent = {
  type: "metrics";
  metrics: AgentMetric[];
};

export type WorkflowEvent = WorkflowUpdateEvent | WorkflowStepEvent | SettingsChangedEvent | MetricsChangedEvent;

class WorkflowEventBus extends EventEmitter {
  emitUpdate(run: WorkflowRun) {
    this.emit(`run:${run.id}`, { type: "update", run } satisfies WorkflowUpdateEvent);
  }

  emitStepEvent(event: WorkflowStepEvent) {
    this.emit(`run:${event.runId}`, event);
  }

  emitSettingsChanged(settings: unknown) {
    this.emit("global:settings", { type: "settings", settings } satisfies SettingsChangedEvent);
  }

  /** 广播全局 metrics 到所有 SSE 订阅者 */
  emitMetricsChanged(metrics: AgentMetric[]) {
    this.emit("global:metrics", { type: "metrics", metrics } satisfies MetricsChangedEvent);
  }

  subscribe(runId: string, listener: (event: WorkflowEvent) => void) {
    const channel = `run:${runId}`;
    this.on(channel, listener);
    this.on("global:settings", listener);
    this.on("global:metrics", listener);
    return () => {
      this.off(channel, listener);
      this.off("global:settings", listener);
      this.off("global:metrics", listener);
    };
  }
}

export const workflowEventBus = new WorkflowEventBus();

// Node 默认 listener 上限是 10，前端有可能多 tab 订阅同一个 run，提高一些。
workflowEventBus.setMaxListeners(64);
