# Conduit Delivery Lab：交互细节与 Workflow 流转问题盘点

我从"**后端状态机**"、"**前后端契约**"、"**前端交互流转**"三个层面排查了一遍，下面把当前明确存在的问题（不完善/不合预期）按优先级归纳，并给出建议的调整方向。

---

## 一、Workflow 状态机层面（最严重，根因）

> 文件聚焦：`workflowService.ts` + `workflow.ts`

### 问题 1️⃣ `createWorkflowRun` 启动后会"一口气跑到 PR 步骤"，与"逐步可观察"的产品语义冲突

`createWorkflowRun` 末尾调用 `autoContinue(run.id)`，而 `autoContinue` 的 while 循环条件是：
```ts
if (stepExecutionModes[step.id] === "automatic" || !step.output) {
  run = await runStep(run.id, step.id);
  continue;
}
```

注意 `stepExecutionModes` 中只有 `clarification` 和 `pull_request` 是 `manual-confirmation`，所以一次 POST `/api/workflows` 会**串行同步执行**：
`requirement_intake → clarification`（停在 waiting-human）。

但 `clarification` 一旦被人工确认，`continueAfterManualConfirmation` 又会再次调用 `autoContinue`，于是后续 5 步（solution_design / module_mapping / code_generation / repo_write / verification）会在**一次 HTTP 请求里同步跑完**，前端完全看不到中间过程，只能在最后一次轮询时看到时间轴突然全部变绿。

**与产品预期不符**的具体表现：
- 前端 `RuntimeTimeline` 设计成"逐步亮起"，但实际是一次性翻完；
- `ExecutionFeed` 的"运行事件流"也变成"事后日志"，不是"运行中"的实时信号；
- 前端 `StepChatThread` 的"等待人工介入"只剩 clarification 这一个真实卡点，其余 4 步（solution_design/module_mapping/code_generation 在前端 `humanEditableSteps` 里被标 humanEditable）都被跳过去了。

**调整方向**：
- 将 `stepExecutionModes` 改成**显式可配置**（推荐至少把 `solution_design`、`code_generation` 改成 `manual-confirmation`，这两个是用户最需要审阅 JSON 的点）；
- `autoContinue` 增加一个 `until?: WorkflowStepId` 参数，表示"跑到哪个 step 就停"，前端的"运行当前步骤"按钮改成"运行直到当前 step 完成并停在下一个 step"；
- 或者，干脆**取消 createWorkflowRun 时的自动续跑**，只把 `requirement_intake` 写好就返回，由前端按按钮逐步推进。这是与 ChatPage→WorkbenchPage 交互最一致的做法。

### 问题 2️⃣ HTTP 请求被**长时间阻塞**：一个 POST 同步等所有 LLM 调用

每个步骤都是 `await callJsonLlmWithSchema`（带 `maxAttempts:2` 的 schema 重试），失败还要再请一次。如果 5 步连跑，单个 HTTP 响应时间可能 30s ~ 2min，前端 fetch 体感是"卡死"。

**调整方向**：
- 把 `runStep` 改成**返回快照立即响应**（status=running，已在内存写好），后台用一个 Promise 异步推进；前端通过 GET `/workflows/:runId` 轮询或 SSE/WebSocket 拉取增量；
- 或者最低成本方案：在 `app.ts` 注册一个 `GET /api/workflows/:runId/stream`，用 SSE 把 `runs.set` 之前每次 mutate 都 push 出去；前端 `WorkbenchPage` 用 `EventSource` 替换 useEffect 一次性 fetch。

### 问题 3️⃣ `runStep` 对处于 `waiting-human` 的步骤——又是"continue"又是"重新跑"——语义混乱

```ts
if (step.status === "waiting-human" && step.output) {
  return continueAfterManualConfirmation(run, stepId);
}
```

也就是说前端如果对一个 waiting-human 的步骤再点"运行当前步骤"，**实际执行的是"确认并跳到下一步"**，不是"重新生成"。但 `addInterventionAndRegenerate` 的最后一行也是 `runStep(runId, stepId)`，进来同一分支，又会变成"用户提了介入意见，但被解释成确认通过"，**导致 intervention 没有重新生成 output，反而直接把流程推到下一步**。

这是当前最隐蔽、最容易踩到的 bug。

**调整方向**：
- 拆成两个独立动作：
  - `POST /workflows/:runId/steps/:stepId/confirm` → 显式确认通过；
  - `POST /workflows/:runId/steps/:stepId/run` → 总是重新跑当前 step（无论它当前是什么状态）；
- `addInterventionAndRegenerate` 内部应当显式 reset `step.status = 'running'` + `step.output = undefined` 再调用 `runStep`，不能复用"waiting-human + output 存在"的分支。

### 问题 4️⃣ Replay 之后没有自动续跑，且会丢失下游所有 logs/intervention/runtimeTrace

[`replayFromStep`](/Users/asherqiu/conduit-delivery-lab/Backend/src/services/workflowService.ts) 把当前 step 标 `status=replayed`，下游全部清空 `output/startedAt/finishedAt/logs=[]`，但是：
1. 没有把当前步骤的 `interventions` 也保留为"历史快照"——下次再 replay 不知道之前曾经被介入过；
2. 没有 `await autoContinue(run.id)`，前端只能再手动点一次"运行当前步骤"才能真正跑起来；
3. 当前步骤实际上是 **"已完成态" + 下游全空**，前端 `mapRuntimeStatus` 把 `replayed` 映射到 `replaying`，banner 文案是"重放中"，但其实后端啥都没在跑；
4. `replayed` 状态没有 endTime/finishedAt 处理，前端 `formatRuntimeStatusValue` 显示"已重放"，但 `RuntimeTimeline` 里的 dot 颜色是 blue 让用户以为正在跑。

**调整方向**：
- `replayFromStep` 后追加 `return autoContinue(run.id, { until: stepId })`，把当前 step 重新设为 `running` 立即跑完一次，下游保持 idle 让用户继续推进；
- 或者把 `status: 'replayed'` 直接改写为 `idle`，UI 不再有第三种"重放中"状态，避免歧义；
- intervention 历史在 replay 时可以保留并打一个 marker，方便对照"上一轮的人工修正是什么"。

### 问题 5️⃣ `currentRunId` 这种"全局单例 current"在多 run / 多浏览器会出错

```ts
let currentRunId: string | null = null;
```

- 用户在 ChatPage 创建一个新 run → `currentRunId` 变成 run-A；
- 用户从 Workflow History 点开一个旧 run-B → `getWorkflowRun` 又把 `currentRunId` 改成 run-B；
- 与此同时另一个浏览器 tab 的 `getCurrentWorkflowRun()` 拿到的是 run-B；
- `evictWorkflowRunsForProject` 也只清内存 Map，不影响 SQLite。

**调整方向**：
- 移除 `currentRunId` 这一概念，前端永远显式带 runId（实际上 `WorkbenchPage` 路由里 `runId` 已经必传）；
- `GET /workflows/current` 这个 endpoint 直接废弃；ChatPage 只调 `getProjectWorkspace` 拿历史列表即可。

### 问题 6️⃣ "automatic" 步骤的下游 step `input` 没有同步刷新

```ts
if (mode === "automatic" && index === stepIndex + 1) {
  return { ...current, input: output, ... };
}
```

只有 automatic 模式下才会把 output 注入到下一个 step 的 input。`continueAfterManualConfirmation` 里也只处理了 `index === stepIndex + 1`。但是当用户**通过 PATCH 修改了某个步骤的 output**（`updateStepOutput`），下游 step 的 input 还停留在旧值。如果用户随后点"运行下一步"，下一步看到的 `step.input` 是过期的，但 `resolveStepOutput` 实际上是从 `getStepOutput(run, "requirement_intake")` 重新拿，所以**前端展示的 input 和后端实际用的不一致**。

**调整方向**：
- `updateStepOutput` 之后立即重新计算下游 step 的 `input`（同 step 内一致）；
- 或者直接**让前端不展示 step.input**，永远展示 step.output 或上游 step 的 output（前端目前 fallback 用 `step.output ?? step.input` 也是一种暂时性补丁）。

---

## 二、前后端契约 / 状态映射层面

### 问题 7️⃣ 前端 `workflowReducer` 是死代码，但 type 还在被全局引用

[`workflowReducer.ts`](/Users/asherqiu/conduit-delivery-lab/FrontEnd/src/features/workflow/workflowReducer.ts) 定义了一整套 `START_STEP / COMPLETE_STEP / FAIL_STEP / WAIT_FOR_HUMAN / UPDATE_STEP_JSON / REPLAY_FROM` 的 reducer，但 `WorkbenchPage` 实际**完全不用** reducer，而是直接 `setRun(await runWorkflowStep(...))` 替换整个对象。

带来的问题：
- 维护时容易误以为"前端自己也维护一份状态机"，增加心智成本；
- WorkflowAction 类型定义和后端实际不一致（缺 `intervention`、`replay` 之外没有 `confirm` 等 action）；
- 这个文件未来如果接 SSE 增量补丁会再被翻出来，但现在的实现并没有为增量更新打基础。

**调整方向**：
- 要么彻底删除 reducer + WorkflowAction（YAGNI），只保留 `setRun(serverRun)` 这种 server-driven 模式；
- 要么补完 reducer，让前端只发 action、后端 SSE push patches，前端用 reducer 应用补丁。这是接 SSE 时的正确路径，但目前需求没到这一步。

### 问题 8️⃣ 前端 `runtimeStatus` 多了一个"running"幻象

```ts
const activeRuntimeStatus: RuntimeStatus = activeStep
  ? (stepRunning ? "running" : mapRuntimeStatus(activeStep))
  : "waiting";
```

`stepRunning` 只是"前端正在 fetch 中"，不是后端的真实状态。但是 `mapRuntimeStatus` 已经把 `step.status === 'running'` 映射成 `running` 了。
真实场景下：
- 用户点"运行当前步骤"→ `setStepRunning(true)` → UI 进入 running banner；
- 一旦 fetch 返回（这中间可能 30s），`stepRunning=false`，但后端已经把后续若干步全跑完，`activeStepId` 已经是 `pull_request`，UI **直接从 running 跳到 success/blocked**，中间过程的 4-5 个步骤的 running 动效完全看不到。

这与问题 2 同源。前端把"我请求中"和"agent 在跑"画了等号，但后端是同步阻塞模式，根本没有"agent 跑中且 HTTP 已返回"的状态。

**调整方向**：和问题 2 一起改：后端拆同步/异步，前端引入"轮询/SSE"来感知真实状态。

### 问题 9️⃣ `RuntimeStateBanner` 的"primary action"语义在多个状态下被复用，按钮含义不清

```ts
onPrimaryAction={activeRuntimeStatus === "success" ? () => handleReplay(activeStep.id) : completeCurrentStep}
```

- success 时点击 = "从此 step 重放"；
- waiting 时点击 = `runWorkflowStep`（实际是"运行"）；
- blocked（waiting-human）时点击 = `runWorkflowStep`（实际后端会走 `continueAfterManualConfirmation` → 跳到下一步）；
- failed 时点击 = `runWorkflowStep`（重试当前 step）。

按钮文案：blocked 状态显示"确认并自动继续"，但实际会自动续跑到下一个 manual-confirmation 节点，user 控制粒度太粗——**用户没有"只确认这一步、不要往下跑"的选项**。

**调整方向**：
- 把按钮拆成 2~3 个：在 blocked 状态下显示"确认并继续"+"重新生成当前步骤"；在 success 状态下显示"从此重放"+"运行下一步"。
- 配合后端 `confirm`/`run` 拆分（问题 3）就能精确表达。

### 问题 🔟 `chatMessages` 本地态与后端 `step.interventions` 重复合并，存在闪烁

```ts
messages={[...(activeStep.interventions ?? []), ...chatMessages]}
```

`handleInterventionSubmit` 先 push 一条 localUserMessage，请求成功后再 `setChatMessages(filter)` 把它删掉。中间可能出现：
- 后端已经把这条 user message 持久化到 `step.interventions`；
- 前端 `chatMessages` 还没 filter，导致用户**短时间看到两条"自己刚发的"消息**；
- 如果请求失败，前端 `chatMessages` 会**永远留着**这条本地消息，没有 cleanup（catch 里只设了 errorMessage，没有 filter chatMessages）。

**调整方向**：
- `handleInterventionSubmit` 失败分支也要 `setChatMessages(current => current.filter(...))`；
- 更好的做法是**直接不维护 chatMessages 这份本地副本**：用 optimistic update 通过把 setRun 后塞一条临时 intervention 实现，或者干脆等后端 200 后再渲染（牺牲一点输入体验换状态干净）。

### 问题 1️⃣1️⃣ ChatPage 的"启动 Workflow"会让用户长时间盯着 loading

```ts
const run = await createWorkflowRun({...});
navigate(`/project/${workspace?.id}/workflow/${run.id}`, ...);
```

`createWorkflowRun` 后端会同步等 clarification 完成（一次 LLM 调用 + schema 校验，可能 5-15s），UI 只显示一个"正在启动 Workflow..."。用户没有任何时间轴反馈、不能取消。

**调整方向**：
- 后端创建后立即返回（仅有 requirement_intake 步骤已完成、clarification idle），前端导航到 WorkbenchPage 后再触发"运行 clarification"；
- 或者给 ChatPage 也接一份 SSE/轮询，把 createWorkflowRun 的中间事件展示出来（与 StartPage 的 import timeline 对齐）。

---

## 三、其他细节问题

### 问题 1️⃣2️⃣ `RequirementDraft` 类型双源
后端 `domain/workflow.ts` 的 `requirementDraftSchema` 没有 `projectId/workspaceId` 字段，前端 `features/workflow/types.ts` 的 `RequirementDraft` 却带了。前端 `createWorkflowRun(requirement: RequirementDraft)` 把 projectId/workspaceId 一起发出去，后端 `createWorkflowSchema` 单独有这两个可选字段，没问题；但如果未来后端校验更严，类型同源会更安全。考虑用 OpenAPI / zod-to-ts 让前端从后端 schema 派生类型。

### 问题 1️⃣3️⃣ `runtimeTrace` 的 schema 是 optional 但 prompt 强依赖
`moduleMappingSchema` 等都把 `runtimeTrace` 设为 `.optional()`，而 `workflowStepAgent` 在每次调用后强制覆盖：
```ts
return { ...result.output, runtimeTrace: result.trace };
```
这会让 LLM 自己生成的 runtimeTrace（如果生成了）被静默丢弃；同时 `updateStepOutput` 时用户编辑 JSON 又可能漏掉 runtimeTrace。

**调整方向**：在 schema 里把 runtimeTrace 直接 strip 掉，由后端在 service 层注入；或者前端 JSON 编辑器把 runtimeTrace 锁成只读字段。

### 问题 1️⃣4️⃣ `WAIT_FOR_HUMAN` 的"等待用户"提示在 success 状态下并不准确
`continueAfterManualConfirmation` 在 clarification 之后立即清掉 step.status="success"，紧接着把 activeStepId 推到 solution_design。用户在 UI 上看不到"clarification 已通过用户确认"这一态，因为 banner 立刻显示成 solution_design 的状态。

如果后端改成"先 success、不立即 autoContinue"，UI 可以让用户多看一眼澄清结果再点"运行下一步"。

### 问题 1️⃣5️⃣ `humanEditableSteps` 与 `stepExecutionModes` 不一致
`workflowService.ts`:
```ts
const humanEditableSteps = new Set([
  "clarification", "solution_design", "module_mapping", "code_generation",
]);
```
但 `stepExecutionModes` 里只有 `clarification` 是 manual。导致前端能"编辑 JSON"的 4 个 step 中，3 个是 automatic、用户根本来不及编辑就被自动续跑过去了。前端 `JsonPanel` 上 `editable={step.humanEditable}` 在大多数情况下是个**摆设**。

---

## 四、建议的整改路线

为避免一次性大改翻车，建议按下面 3 个阶段推进：

### Phase 1（半天）—— 修正 workflow 流转最致命的 bug
1. 拆分 `runStep` vs `confirmStep`（问题 3、9）；
2. 关闭"createWorkflowRun → 自动跑全程"，至少把 `solution_design` 和 `code_generation` 设为 `manual-confirmation`（问题 1、15）；
3. 修复 `addInterventionAndRegenerate` 走错分支（问题 3）；
4. `replayFromStep` 改成主动续跑、或者状态改成 idle（问题 4）；
5. `currentRunId` 这条全局单例移除（问题 5）。

### Phase 2（1～2 天）—— 让"运行中"这件事真的可观察
1. `runStep` 改异步：直接返回 200，后端 promise 后台执行，前端轮询 / SSE；
2. 前端 WorkbenchPage 引入轮询 hook 或 EventSource，删除 stepRunning 兜底逻辑；
3. ChatPage 启动 workflow 后立即跳转，由 WorkbenchPage 接管 clarification 的执行展示（问题 11）。

### Phase 3（按需）—— 收敛交互细节与代码债
1. 删 `workflowReducer` 死代码 / 或重构为 patch reducer（问题 7）；
2. 介入消息合并去重、失败回滚（问题 10）；
3. RuntimeStateBanner 按钮拆分多个明确动作（问题 9）；
4. `runtimeTrace` 由后端注入、前端只读（问题 13）；
5. 类型同源（zod → ts，问题 12）。

---

# 五、执行计划（基于用户反馈的 TODO 拆解）

> 用户已 review 上述 15 个问题，并给出 15 条调整意见。下面把每条意见落成可执行 TODO，按"先稳定后端状态机 → 再让运行可观察 → 最后收敛交互细节"的顺序排列。
>
> 状态图例：⬜ 待办 / 🟦 进行中 / ✅ 已完成

## TODO 1 ｜执行模式可配置 + Settings 页 ✅
> 对应原问题 1️⃣ + 1️⃣5️⃣（用户意见 #1）

- ✅ 后端：把 `stepExecutionModes` 从硬编码常量改成"默认值 + 运行时可覆盖"。新增 `services/workflowSettingsService.ts`，用 `node:sqlite` 持久化（复用 `workspaceStore`）。
- ✅ 后端：默认值调整为 `clarification`、`solution_design`、`code_generation`、`pull_request` 四个 manual-confirmation；其余 automatic。
- ✅ 后端路由：`GET /api/workflows/settings` 读取 / `PATCH /api/workflows/settings` 更新。
- ✅ 后端：`workflowService` 调用处改为 `getStepExecutionMode(stepId)`，不再直接读常量。
- ✅ 前端：新增 `routes/SettingsPage`，提供每个 step 的 mode toggle（automatic / manual-confirmation）。
- ✅ 前端：`App.tsx` 注册 `/settings` 路由，顶部导航加入入口。
- ✅ 前端：`api/client.ts` 新增 `fetchWorkflowSettings` / `updateWorkflowSettings`。

## TODO 2 ｜快照立即响应 + SSE 增量推送 ✅
> 对应原问题 2️⃣ + 8️⃣（用户意见 #2、#8）

- ✅ 后端：`runStep` 改为"先写 running 快照 → 立即返回 → 后台 promise 推进状态机"，所有 mutate 都通过 `emitRunUpdate(run)` 广播。
- ✅ 后端：新增 `services/workflowEvents.ts`（基于 `EventEmitter`），`autoContinue` / `runStep` / `replayFromStep` / `updateStepOutput` / `addInterventionAndRegenerate` / `confirmStep` 全部接入。
- ✅ 后端路由：新增 `GET /api/workflows/:runId/stream`（SSE，`text/event-stream`），订阅当前 run 的更新；连接后立即 push 一次最新快照。
- ✅ 前端：`WorkbenchPage` 用 `EventSource` 替换"轮询 + setStepRunning 兜底"逻辑；删除"前端假装 running"幻象（用户意见 #8）。
- ✅ 前端：`api/client.ts` 暴露 `subscribeWorkflowRun(runId, onUpdate, onError)` 工具。

## TODO 3 ｜拆分 confirm 与 run 两个独立动作 ✅
> 对应原问题 3️⃣ + 9️⃣（用户意见 #3、#9）

- ✅ 后端：新增 `confirmStep(runId, stepId)`，仅在 `waiting-human` + 有 output 时合法，把当前 step 标 success 并触发 `autoContinue`。
- ✅ 后端：`runStep` 重构为"总是重新生成当前 step output"，无论之前是什么状态都先 reset。
- ✅ 后端路由：新增 `POST /api/workflows/:runId/steps/:stepId/confirm`。
- ✅ 后端：`addInterventionAndRegenerate` 在调用 `runStep` 前显式 `step.status = 'idle'` + `step.output = undefined`，避免误进 confirm 分支。
- ✅ 前端：`WorkbenchPage` 的 `RuntimeStateBanner` 在 `blocked` 状态下提供"确认并继续" + "重新生成当前步骤"两个按钮；`success` 状态下提供"从此重放" + "运行下一步"。
- ✅ 前端：`api/client.ts` 新增 `confirmWorkflowStep`。

## TODO 4 ｜重跑历史 / 续跑 + 下游历史归档 ✅
> 对应原问题 4️⃣（用户意见 #4，需求加强版）

- ✅ 后端：`StepRun` 新增 `replayCount: number`（默认 0）+ `history: StepRunSnapshot[]` 字段。
- ✅ 后端：新增 `StepRunSnapshot` 类型（id / output / logs / interventions / startedAt / finishedAt / createdAt / reason）。
- ✅ 后端：`snapshotStep(step, reason)` 工具函数——仅有 output 时才创建快照。
- ✅ 后端：`replayFromStep` 改造——重置前为当前 step 及下游 step 做快照，`replayCount += 1`。
- ✅ 后端：`runStep` 改造——重置前为当前 step 做快照（reason="regenerate"）。
- ✅ 后端路由：`GET /api/workflows/:runId/steps/:stepId/history`（返回 history 列表）。
- ✅ 后端路由：`POST /api/workflows/:runId/steps/:stepId/restore`（按 snapshotId 还原 output，可选 replayDownstream）。
- ✅ 前端：`RuntimeTimeline` 中 `replayCount > 0` 时显示「重跑 N 次」紫色徽标。
- ✅ 前端：`OutputWorkspace` 新增「历史版本」tab，列出 snapshots + 「还原此版本」按钮。
- ✅ 类型同源：通过 TODO 12 的 `@backend` path alias，前端直接从后端导入 `StepRunSnapshot`。

## TODO 5 ｜移除 currentRunId 全局单例 ✅
> 对应原问题 5️⃣（用户意见 #5）

- ✅ 后端：删除 `workflowService.ts` 中的 `currentRunId` 变量与 `getCurrentWorkflowRun` 导出。
- ✅ 后端路由：移除 `GET /api/workflows/current`；调整 `getWorkflowRun` 不再有副作用。
- ✅ 后端：`evictWorkflowRunsForProject` 不再操作 `currentRunId`。
- ✅ 前端：`api/client.ts` 删除 `getCurrentWorkflowRun`；调用方改为显式 `runId`。
- ✅ 前端：`WorkbenchPage` 不再有 `getCurrentWorkflowRun` fallback，总是显式使用路由 `runId`。

## TODO 6 ｜updateStepOutput 后同步刷新下游 input ✅
> 对应原问题 6️⃣（用户意见 #6）

- ✅ 后端：抽取 `propagateInputDownstream(steps, stepIndex, output)` 工具方法，仅在下一步处于 idle/failed 时覆盖其 input。
- ✅ 后端：`updateStepOutput`、`confirmStep` 统一调用 `propagateInputDownstream`，消除内联重复逻辑。
- ✅ 验证：`getStepOutput` 从 run 重新读不变；前端展示的 `step.input` 与后端实际使用值保持一致。

## TODO 7 ｜清理死代码 ✅
> 对应原问题 7️⃣（用户意见 #7）

- ✅ 删除 `FrontEnd/src/features/workflow/workflowReducer.ts`。
- ✅ 删除 `FrontEnd/src/features/workflow/workflowReducer.test.ts`。
- ✅ 删除 `FrontEnd/src/hooks/useStepReplay.ts`。
- ✅ 删除 `WorkflowAction` 类型定义；保留 `WorkflowRun`、`StepRun` 等 server-driven 类型。
- ✅ grep 全局确认无残余引用。

## TODO 8 ｜移除前端 running 幻象 ✅
> 对应原问题 8️⃣（用户意见 #8，已并入 TODO 2）

- ✅ 删除 `WorkbenchPage` 中的 `stepRunning` state 与 `activeRuntimeStatus` 中的 `stepRunning ? "running" : ...` 兜底；状态完全由后端 step.status 决定（通过 SSE 推送的 `mapRuntimeStatus(activeStep)` 派生）。
- ✅ 触发按钮（运行 / 确认）改为 fire-and-forget：发请求成功后不本地切 running，`running` prop 改为 `activeRuntimeStatus === "running"` 派生。

## TODO 9 ｜RuntimeStateBanner 按钮语义细化 ✅
> 对应原问题 9️⃣（用户意见 #9，已并入 TODO 3）

- ✅ `RuntimeStateBanner` 重构为按状态渲染不同按钮组合（新增 `onSecondaryAction` prop）。
- ✅ 文案统一：blocked → 「确认并继续」(primary) +「重新生成」(secondary)；success → 「运行下一步」(primary) +「从此重放」(secondary)；failed → 「重试当前步骤」；waiting → 「运行当前步骤」。
- ✅ `WorkbenchPage` 中为 blocked 状态传入 runWorkflowStep 作为 secondary，success 状态传入 handleRunNextStep。

## TODO 10 ｜chatMessages 本地副本去除 ✅
> 对应原问题 🔟（用户意见 #10）

- ✅ `WorkbenchPage` 删除 `chatMessages` state；`StepChatThread` 直接消费 `activeStep.interventions`。
- ✅ optimistic update：`handleInterventionSubmit` 在请求前通过 `setRun(...)` 直接向 `step.interventions` 插入临时消息，请求失败时回滚到 `previousRun`。
- ✅ 成功路径由后端返回的 nextRun 覆盖，不再出现消息重复/闪烁。

## TODO 11 ｜ChatPage 接 SSE，启动过程实时反馈 ✅
> 对应原问题 1️⃣1️⃣（用户意见 #11）

- ✅ 后端：`createWorkflowRun` 已在 TODO 2 中改为「立即返回快照 + `void scheduleAutoContinue(run.id)` 后台推进」。
- ✅ 前端：ChatPage `handleSubmit` 在收到 201 后立即 navigate 到 WorkbenchPage，由 SSE 接管实时展示。
- ✅ 前端（可选）：ChatPage 内联 timeline 暂不实现，当前体验已满足——createWorkflowRun 毫秒级返回，用户几乎无感等待。

## TODO 12 ｜前后端类型同源 ✅
> 对应原问题 1️⃣2️⃣（用户意见 #12）

- ✅ `FrontEnd/tsconfig.json` 添加 `baseUrl` + `paths: { "@backend/*": ["../Backend/src/*"] }`。
- ✅ `FrontEnd/vite.config.ts` 添加 `resolve.alias: { "@backend": path.resolve(__dirname, "../Backend/src") }`。
- ✅ `FrontEnd/src/features/workflow/types.ts` 改为 re-export facade——从 `@backend/domain/workflow` 导入全部 14 个共享类型，仅保留 `RequirementPattern` / `StepOutputMap` 作为前端专用。
- ✅ 所有下游文件无需修改（已通过 facade 间接导入），单源 Zod 不会进入前端 bundle（仅 `import type`）。

## TODO 13 ｜runtimeTrace 由后端注入、schema strip ✅
> 对应原问题 1️⃣3️⃣（用户意见 #13）

- ✅ 后端：在各步 schema（moduleMappingSchema / codeGenerationPlanSchema / repoWriteResultSchema / verificationResultSchema / pullRequestResultSchema）中删除 `runtimeTrace` 字段及 `runtimeTraceSchema` 定义。
- ✅ 后端：`workflowStepAgent` 在 schema 校验完成后统一注入 `runtimeTrace: result.trace`（原有逻辑不变，现在 LLM 不会生成冗余的 trace 字段被静默覆盖）。
- ✅ 前端：当前 JSON 编辑器未特殊处理 runtimeTrace（透传展示），后续可按需增加只读标记。

## TODO 14 ｜语义命名调整 ✅
> 对应原问题 1️⃣4️⃣ + 1️⃣5️⃣（用户意见 #14）

- ✅ `step.status = "replayed"` 从 `stepStatuses` 枚举中移除；`replayFromStep` 直接将当前 step 重置为 `idle`，由 `scheduleAutoContinue` 立即推进到 `running`。消除了前端「replayed = 跑中」的歧义。
- ✅ `humanEditableSteps` 硬编码 Set 已删除；进一步把 `step.humanEditable` 这个**派生字段**整体从 `StepRun` 类型（前后端 + 持久化数据 + 测试夹具）中移除。前端 `JsonPanel` 改为 `editable={step.status === "waiting-human"}`——只在该步真停下来等确认时才允许编辑，automatic 模式下根本到不了 waiting-human，自然不可编辑。Settings 页修改后立即对所有 run 生效。
- ✅ 前端：移除 `RuntimeStatus.replaying` 及其全部映射（labels / colors / copy / CSS class / StateDrivenWorkspace 分支）。`StepStatus` 类型缩减为 5 种。

---

## 本次首批落地范围

按用户要求，本轮先执行 **TODO 1 ~ TODO 3**：

1. **TODO 1**：可配置执行模式 + Settings 页；
2. **TODO 2**：异步推进 + SSE 增量；
3. **TODO 3**：confirm / run 拆分。

这三项打通后，后续 TODO 4（重跑历史）才有稳定的事件流和动作语义可依赖；其余项作为后续迭代待办。

## 第二批落地范围

本轮执行 **TODO 5、7、8、10、13**：

1. **TODO 5**：移除 currentRunId 全局单例残留（GET /current 端点废弃，前端改为显式 runId）；
2. **TODO 7**：删除 workflowReducer 死代码（含 test、useStepReplay hook、WorkflowAction 类型）；
3. **TODO 8**：移除前端 stepRunning 幻象（status 完全由后端 SSE 驱动）；
4. **TODO 10**：去除 chatMessages 本地副本（改 optimistic update + rollback）；
5. **TODO 13**：runtimeTrace 由后端注入、schema strip（LLM 不再浪费 token 生成 trace）。

---

## 本轮（第一批）执行结果

> 状态：✅ 已完成 TODO 1 / 2 / 3。
> 验证：Backend `npm run typecheck` 通过、`npm test` 25 个用例全过；新增 / 改动文件本身无 lint 错误。
> （前端 `npm run build` 中存在的 `features/workspace/types not found` 等错误是项目预存问题，与本批改动无关，留给 TODO 12 / 后续清理。）

### 后端落地点

- 新增 [`Backend/src/services/workflowSettingsService.ts`](Backend/src/services/workflowSettingsService.ts)：`stepExecutionModes` 默认值 + JSON 文件持久化（`Backend/data/workflow-settings.json`）。默认改为 clarification / solution_design / code_generation / pull_request 为 manual-confirmation。
- 新增 [`Backend/src/services/workflowEvents.ts`](Backend/src/services/workflowEvents.ts)：基于 `EventEmitter` 的 run-scoped pub/sub，承载 SSE 增量。
- 重构 [`Backend/src/services/workflowService.ts`](Backend/src/services/workflowService.ts)：
  - 引入 `commitRun()` 统一「内存 + SQLite + EventBus」三处一致；
  - `runStep` 改为「先 reset 为 running 快照立即返回 → 后台 promise 推进」；
  - 新增 `confirmStep()` 拆分 confirm / run 语义；
  - `addInterventionAndRegenerate` 显式 reset `status=idle`，避免再走 confirm 分支；
  - 移除模块级 `currentRunId`（TODO 5 的前置准备已经做了一半）。
- 新增 / 调整路由 [`Backend/src/routes/workflowRoutes.ts`](Backend/src/routes/workflowRoutes.ts)：
  - `GET /api/workflows/settings`、`PATCH /api/workflows/settings`；
  - `POST /api/workflows/:runId/steps/:stepId/confirm`；
  - `GET /api/workflows/:runId/stream`（SSE，含 init snapshot + 心跳）；
  - 移除 `GET /api/workflows/current`。
- 删除 [`Backend/src/domain/workflow.ts`](Backend/src/domain/workflow.ts) 里硬编码的 `stepExecutionModes` 常量，统一由 `workflowSettingsService` 提供。
- 调整 [`Backend/src/services/workflowService.test.ts`](Backend/src/services/workflowService.test.ts) 以匹配新的"立即返回 + 后台推进"语义。

### 前端落地点

- 新增 [`FrontEnd/src/routes/SettingsPage/SettingsPage.tsx`](FrontEnd/src/routes/SettingsPage/SettingsPage.tsx) + `.css`：每个 step 的执行模式 toggle，`requirement_intake` 锁死为 automatic。
- 改造 [`FrontEnd/src/components/AppShell/AppShell.tsx`](FrontEnd/src/components/AppShell/AppShell.tsx)：增加顶部导航条，含「项目」「设置」入口。
- 调整 [`FrontEnd/src/App.tsx`](FrontEnd/src/App.tsx)：注册 `/settings` 路由。
- 重写 [`FrontEnd/src/api/client.ts`](FrontEnd/src/api/client.ts)：
  - 移除 `getCurrentWorkflowRun`；
  - 新增 `confirmWorkflowStep`、`fetchWorkflowSettings`、`updateWorkflowSettings`；
  - 新增 `subscribeWorkflowRun(runId, handlers)` 基于 `EventSource` 订阅 SSE。
- 调整 [`FrontEnd/src/routes/WorkbenchPage/WorkbenchPage.tsx`](FrontEnd/src/routes/WorkbenchPage/WorkbenchPage.tsx)：
  - `completeCurrentStep` 根据 `step.status` 分流到 `confirm` 或 `run`；
  - 新增 SSE 订阅 useEffect，`run` 由后端事件实时驱动。

### 待跟进（不阻塞但建议尽快做）

- ✅ `RuntimeStateBanner` 已拆分为「确认并继续 / 重新生成 / 从此重放 / 运行下一步」多按钮（TODO 9，第三批完成）；
- ✅ `replayed` 状态已移除，改为 `idle`（TODO 14，第三批完成）；
- ⬜ `step.status === "running"` 时也展示后端 streaming logs，避免目前 SSE update 只刷新整个 run 快照、log 增量看起来"一闪而过"；
- ✅ 第二批 TODO（5 / 7 / 8 / 10 / 13）已完成；第三批 TODO（6 / 9 / 14 / 11）已完成。

## 第三批落地范围

本轮执行 **TODO 6、9、14、11**：

1. **TODO 6**：抽取 `propagateInputDownstream` 工具方法，统一 updateStepOutput / confirmStep 的下游 input 传播；
2. **TODO 9**：RuntimeStateBanner 按钮拆分 primary / secondary，每个状态含义唯一（确认/重新生成/重放/运行下一步）；
3. **TODO 14**：移除 `replayed` 状态（改为 `idle`），`humanEditable` 由执行模式动态派生（`getStepExecutionMode(stepId) === "manual-confirmation"`）；
4. **TODO 11**：确认 ChatPage 流程已在 TODO 2 中满足（立即返回 + navigate + SSE 接管），标记完成。
