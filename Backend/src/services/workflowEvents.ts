import { EventEmitter } from "node:events";
import type { WorkflowRun, WorkflowStepId } from "../domain/workflow.js";

/**
 * Workflow 运行的事件总线：
 * - "update": run 整体快照变更（任意 step.mutate / status 变化都会广播）；
 * - "step": 某个 step 的局部事件（开始 / 结束 / 失败 / waiting-human），可用于细粒度 UI 提示。
 *
 * 当前以全量 run 快照为主（实现简单、前端 setRun 替换即可），后续若有性能问题再切换为 patch。
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

export type WorkflowEvent = WorkflowUpdateEvent | WorkflowStepEvent;

class WorkflowEventBus extends EventEmitter {
  emitUpdate(run: WorkflowRun) {
    this.emit(`run:${run.id}`, { type: "update", run } satisfies WorkflowUpdateEvent);
  }

  emitStepEvent(event: WorkflowStepEvent) {
    this.emit(`run:${event.runId}`, event);
  }

  subscribe(runId: string, listener: (event: WorkflowEvent) => void) {
    const channel = `run:${runId}`;
    this.on(channel, listener);
    return () => {
      this.off(channel, listener);
    };
  }
}

export const workflowEventBus = new WorkflowEventBus();

// Node 默认 listener 上限是 10，前端有可能多 tab 订阅同一个 run，提高一些。
workflowEventBus.setMaxListeners(64);
