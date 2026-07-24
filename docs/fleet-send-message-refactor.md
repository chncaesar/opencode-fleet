# fleet_send_message 重构方案：内建 SSE 等待循环

## 背景与动机

### 现有问题

当前 `fleet_send_message` timeout 后，master 需要手动调用 `fleet_get_session_status`
确认状态，再决定是否等待、中止或 reset。这个决策逻辑写在 AGENTS.md 里，靠文档约束 AI
行为，不可靠且对开箱用户不友好。

设计初心是：**timeout 不是失败，slave 还在工作，master 应该等待而不是打断或 reset**。
但当前工具返回值无法强制这个行为。

### 根本原因

底层 SSE 实现已经很好：
- `StatusStream` 持久连接，`getSessionStatus()` 读本地缓存，O(1) 零网络
- `waitForIdle()` 挂在 SSE 流上等，不轮询
- `sendPromptAsync()` 有乐观写 busy，无竞态

问题在工具层：工具在第一次 timeout 后就把决策权交给了 master，而不是利用已有的 SSE
连接继续等待。

---

## 设计目标

**正常流程 1 个工具搞定**：master 调一次 `fleet_send_message`，工具内部用持久 SSE
连接自动重试等待，直到 slave idle 或达到总时限，返回结构化结果。

master 的决策从**文档驱动**变为**数据驱动**：看返回值的 `status` 字段，不查手册。

---

## 核心改动：session.ts send() 内建等待循环

### 当前行为

```
发送 prompt
  → waitForIdle(timeoutMs=60s)
  → timeout → 立即返回 timedOut=true，让 master 自己处理
```

### 新行为

```
发送 prompt
  → 内建等待循环（复用持久 SSE 连接）
      waitForIdle(sliceMs) → idle → return completed
      timeout → 继续等 → waitForIdle(sliceMs) → idle → return completed
      timeout × N → 超过 maxWaitMs → return timeout_still_busy
```

### 实现要点

```typescript
// session.ts — send() 新逻辑
const MAX_TOTAL_WAIT_MS = options.maxWaitMs ?? 10 * 60 * 1000; // 默认 10 分钟
const SLICE_MS = this.timeoutMs;   // 每片等待时长（CLI --timeout，默认 60s）
const deadline = Date.now() + MAX_TOTAL_WAIT_MS;

let timedOut = false;
let waitSlices = 0;

while (Date.now() < deadline) {
  try {
    await node.waitForIdle(sessionId, Math.min(SLICE_MS, deadline - Date.now()));
    timedOut = false;
    break;
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    waitSlices++;
    timedOut = true;
    // 继续循环 — SSE 连接还在，下次 waitForIdle 直接挂上去，无需重连
  }
}
```

SSE 连接是持久的，每次 `waitForIdle` 调用只是在已有连接上注册一个新的 idle waiter，
没有额外网络开销。

---

## 结构化返回值

`fleet_send_message` 返回值新增 `status` 字段，master 直接查字段决策：

| `status` | 含义 | master 下一步 |
|---|---|---|
| `completed` | slave 完成，reply 可用 | 使用 reply |
| `completed` + 空 reply | agent 正在 mid-step（tool call 中） | 调 `fleet_get_session_messages` 查进度 |
| `timeout_still_busy` | 超过 maxWaitMs，slave 仍在运行 | 等待；`escalate_hint=true` 时叫人 |
| `queued` | slave 正忙，消息已排队 | 等 slave 完成当前任务再发 |
| `error` | slave 返回错误 | 看 reply，决定重试或修复 |

### `escalate_hint` 机制

等待超过 3 个 slice 仍未 idle，返回值附加 `escalate_hint: true`，提示 master 升级给人工：

```typescript
return {
  status: "timeout_still_busy",
  reply,
  hint: "Slave is still working. Do NOT reset. Call fleet_get_session_status to check.",
  escalate_hint: waitSlices >= 3,
  timedOut: true,
  hasError: false,
  messages,
};
```

### busy 时发送的处理

发送前检查 SSE 缓存。slave 正忙时仍然发送（opencode 会排队），但返回 `queued` 状态并附带警告：

```typescript
const currentStatus = await node.getSessionStatus(sessionId);
if (currentStatus.type === "busy") {
  // 发送，让 opencode 排队
  // 返回 status: "queued" + warning
}
```

---

## 工具集职责重定义

工具数量不变（11 个），但职责边界清晰化：

**主流程工具（正常任务只用这一个）**
- `fleet_send_message` — 发送 + 内建 SSE 等待循环 + 结构化返回值

**诊断工具（仅异常时使用）**
- `fleet_get_session_status` — 读 SSE 缓存确认状态（master 重启后缓存丢失，或人工诊断）
- `fleet_get_session_messages` — HTTP 拉取历史，查看详细进度

**控制工具**
- `fleet_interrupt_session` — 发 abort 信号，fire-and-forget，需要提前中止时用
- `fleet_reset_session` — 丢弃 session ID，最后手段，只在 session idle 时有意义

**节点管理**
- `fleet_list_nodes` — 列出节点+健康，初始化时用
- `fleet_node_health` — 单节点 ping，诊断用

**Session 管理（恢复场景）**
- `fleet_list_sessions` — 列出 slave 上所有 session，master 重启后找回 session 用
- `fleet_create_session` — 显式创建并绑定，需要指定 agent/model 时用
- `fleet_switch_session` — 切换绑定，恢复场景用

**配置查询**
- `fleet_list_models` — 列出可用模型，初始化时用

---

## 架构对比

### 当前架构（文档驱动决策）

```
master
  → fleet_send_message(prompt)
      → timeout → 返回 timedOut=true
          → master 查 AGENTS.md 决策
          → master 调 fleet_get_session_status
          → master 等待
          → master 调 fleet_send_message 重试
```

### 新架构（数据驱动决策）

```
master
  → fleet_send_message(prompt, maxWaitMs=600s)
      内部：POST prompt_async
            → optimistic write busy
            → waitForIdle(60s) × N（复用持久 SSE）
            → idle → {status:"completed", reply}
            → 超时 → {status:"timeout_still_busy", escalate_hint, hint}
      master 看 status 字段，不查文档
```

---

## AGENTS.md 对应简化

原有 6 条规则 + 决策树，简化为 2 条：

1. `timeout_still_busy` 时等待，不 reset；`escalate_hint=true` 时叫人
2. 非正常流程才使用诊断/控制工具

---

## 实现步骤

1. `session.ts` — `SendOptions` 增加 `maxWaitMs?: number`
2. `session.ts` — `SendResult` 增加 `status` 字段和 `escalate_hint`
3. `session.ts` — `send()` 改为内建等待循环
4. `tools.ts` — `handleSendMessage` 返回值使用新 `status` 字段
5. `tools.ts` — `fleet_send_message` schema 增加 `max_wait_seconds` 参数
6. `AGENTS.md` — 更新 fleet operation protocol，删除决策树，改为结构化返回值说明
