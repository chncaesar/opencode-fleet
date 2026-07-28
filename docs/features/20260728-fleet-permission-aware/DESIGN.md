# DESIGN: fleet-permission-aware

Feature: 20260728-fleet-permission-aware  
Branch: feature/fleet-permission-aware  
Date: 2026-07-28

---

## 1. 背景与目标

### 问题

Slave 节点在 serve 模式下运行时，若遇到未预先授权的工具调用（bash 命令、文件写入等），opencode 会通过 SSE 发出 `permission.asked` 事件并等待用户批准。由于 fleet 的 master agent 只订阅 `session.status` 和 `session.idle` 事件，它对 `permission.asked` 事件一无所知，导致：

- `fleet_get_session_status` 始终返回 `busy`，master 误以为 slave 正在正常执行
- Session 永久阻塞，fleet 任务无法推进
- 用户看不到任何诊断信息，不知道应该怎么解锁

### 目标

1. master 调用 `fleet_get_session_status` 时，若 slave session 正在等待 permission 审批，返回结果中包含 `pendingPermissions` 列表（含 id、permission、patterns 字段），使 master 能向用户呈现决策信息。
2. 新增 `fleet_reply_permission` 工具，允许 master 代表用户批准（once）或拒绝（reject）某条 permission 请求，解锁 slave session。

### 本次不做

- `always`（持久化规则）不暴露给 master，reply 只支持 `once` / `reject`
- 自动 approve 策略
- Permission 规则配置 UI

---

## 2. 架构设计

### 2.1 模块边界

本功能横跨两个文件：

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src/node.ts` | 扩展 `StatusStream` | 订阅并缓存 `permission.asked` 事件；新增 `replyPermission()` HTTP 方法 |
| `src/tools.ts` | 扩展工具 + 新增工具 | `fleet_get_session_status` 返回 `pendingPermissions`；新增 `fleet_reply_permission` |

`src/session.ts` 不需要改动——permission 操作不经过 SessionManager，直接调用 node 上的方法。

### 2.2 数据模型

#### PendingPermission（新增类型，定义于 node.ts）

| 字段 | 类型 | 来源 | 含义 |
|------|------|------|------|
| `id` | string | SSE event properties.id | Permission 请求的唯一 ID，用于 reply API |
| `permission` | string | SSE event properties.permission | 工具名称（如 "bash"、"write"） |
| `patterns` | string[] | SSE event properties.patterns | 需要授权的资源/命令模式列表 |

#### permissionCache（新增字段，位于 StatusStream 内）

类型：`Map<sessionID, PendingPermission[]>`

维护每个 session 当前积压的 permission 请求列表。与 `statusCache` 并列，由 `applyEvent()` 独立写入。

### 2.3 数据流

#### permission.asked 事件处理

SSE 流中收到 `permission.asked` 事件时，`applyEvent()` 执行以下操作：

1. 从 `properties`（或 `data`）中提取 `sessionID`、`id`、`permission`、`patterns`
2. 读取 `permissionCache.get(sessionID)` 当前列表（若不存在则初始化为空数组）
3. 将新的 `PendingPermission` 对象追加到列表末尾
4. 写回 `permissionCache.set(sessionID, 更新后的列表)`
5. **不修改** `statusCache`——session 在 permission 等待期间依然显示为 `busy`（这是正确行为）

#### permission 清理

当 `session.status: idle` 或 `session.idle` 事件到达时，`applyEvent()` 额外执行：

- `permissionCache.delete(sessionID)`

理由：idle 意味着 session 已结束或已被外部操作（中断、直接 reject 等）解锁，所有 pending permission 均已失效。若 session 之后再次变 busy，新的 `permission.asked` 事件会重建列表。

#### replyPermission 调用路径

`fleet_reply_permission` handler → `node.replyPermission(sessionId, requestId, reply)` → `POST /api/session/:sessionId/permission/:requestId/reply`

Reply 成功（HTTP 204）后，handler 需从 `permissionCache` 中移除已 reply 的那条记录（通过 node 上的新方法 `removePendingPermission(sessionId, requestId)`），然后将结果返回给 master。

### 2.4 StatusStream 公共 API 变更

在 `StatusStream`（内部类）新增两个方法，通过 `OpenCodeNode` 向外暴露：

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `getPendingPermissions(sessionId)` | sessionId: string | PendingPermission[] | 返回当前积压的 permission 请求列表，不存在则返回空数组 |
| `removePendingPermission(sessionId, requestId)` | sessionId: string, requestId: string | void | 从 permissionCache 中移除已处理的单条记录 |

`OpenCodeNode` 同样暴露这两个方法，作为对 `StatusStream` 的透传委托。

新增 HTTP 方法：

| 方法 | 签名 | 说明 |
|------|------|------|
| `replyPermission(sessionId, requestId, reply, message?)` | string, string, "once"\|"reject", string? | POST /api/session/:sessionId/permission/:requestId/reply，body: { reply, message? } |

### 2.5 fleet_get_session_status 返回结构变更（向后兼容）

当前 handler 把 `status.type` 输出为纯文本，master agent 通过文本解析状态。本次变更只在 **文本输出**层面追加信息，不改变结构——这确保现有 master 的 poll 逻辑（检查文本中是否含 `Status: idle`）不受影响。

当 session 为 `busy` 且 `pendingPermissions` 非空时，在已有输出之后追加一个新段落：

```
Permission approval required — session is blocked waiting for user decision.
Pending permissions (N item(s)):
  [1] id=per_xxx  tool=bash  patterns=["rm -rf /tmp/build"]
  [2] id=per_yyy  tool=write  patterns=["/etc/hosts"]
Next step: call fleet_reply_permission with the request id to approve (once) or reject.
```

当 `pendingPermissions` 为空时，输出与现在完全相同（不追加任何内容）。

### 2.6 fleet_reply_permission 接口契约

**工具名**: `fleet_reply_permission`

**描述**: Reply to a pending permission request on a slave node. Use "once" to approve this single invocation, or "reject" to deny it. The slave session will unblock and continue (once) or receive an error (reject).

**输入参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `node` | string | 是 | 目标节点名称 |
| `session_id` | string | 否 | 目标 session ID；省略则使用节点当前绑定的 session |
| `request_id` | string | 是 | Permission 请求 ID（从 fleet_get_session_status 的 pendingPermissions 中获取） |
| `reply` | string | 是 | 仅允许 "once" 或 "reject" |
| `message` | string | 否 | 可选的附加说明，透传给 slave |

**正常返回**:

```
Permission request per_xxx on node "node-a" (session ses_yyy): replied "once".
Session is now unblocked. Use fleet_get_session_status to monitor progress.
```

**错误场景**:

- `reply` 不是 "once" 或 "reject"：返回 isError=true，提示合法值
- 节点不存在：返回 isError=true
- session 无 binding 且未传 session_id：返回 isError=true
- HTTP 调用返回非 204：返回 isError=true，附带 HTTP 状态码

### 2.7 安全边界

- `reply` 参数在 handler 层做枚举校验，拒绝 "always"——即使 opencode REST API 支持 "always"，fleet 层不暴露该选项。
- `request_id` 和 `session_id` 直接作为 URL 路径参数拼接，需确保不含路径遍历字符（`/`、`..`）；在 `replyPermission()` 中对两者做 `encodeURIComponent` 编码。
- Permission reply 操作无幂等性保证——同一 `requestId` 若已 reply，opencode 可能返回 4xx；handler 应将此类错误透明返回给 master，不做静默忽略。

### 2.8 兼容性

- 不修改任何现有工具的 inputSchema 或返回结构（仅在 `fleet_get_session_status` 的文本输出末尾追加内容）
- `permissionCache` 与 `statusCache` 完全独立，不影响现有 idle waiters 逻辑
- `injectStatusForTesting()` 保持不变；测试可通过 `injectPermissionForTesting(sessionId, permissions)` 注入 pending permissions（新增，测试专用）

---

## 3. 用户体验设计

本功能无前端，此节省略。

---

## 4. E2E 场景

### 场景 1（Happy Path）：master 感知 permission 并 approve once，slave 继续执行

**Given**:
- slave 节点 session `ses_abc` 正在执行，遇到一个 bash 命令需要授权
- slave 通过 SSE 发出 `permission.asked` 事件，properties 包含 id=`per_001`、permission=`bash`、patterns=`["rm -rf /tmp/build"]`、sessionID=`ses_abc`
- fleet StatusStream 已接收到该事件并写入 `permissionCache`

**When**:
- master 调用 `fleet_get_session_status(node="slave-a", session_id="ses_abc")`

**Then**:
- 返回文本中包含 `Status: busy`
- 返回文本中包含 `pendingPermissions` 非空段落，列出 id=`per_001`、tool=`bash`、patterns=`["rm -rf /tmp/build"]`
- 返回文本中提示调用 `fleet_reply_permission`

**When**:
- master 调用 `fleet_reply_permission(node="slave-a", session_id="ses_abc", request_id="per_001", reply="once")`

**Then**:
- fleet 向 slave 发送 `POST /api/session/ses_abc/permission/per_001/reply`，body `{ "reply": "once" }`
- slave 返回 HTTP 204
- `permissionCache` 中 `per_001` 被移除
- 返回文本包含 `replied "once"` 和"session is now unblocked"
- slave session 继续执行，最终发出 `session.status: idle`

---

### 场景 2（Error Path）：master reject permission，slave 收到错误

**Given**:
- slave session `ses_xyz` 等待授权，permission id=`per_002`，permission=`write`，patterns=`["/etc/hosts"]`

**When**:
- master 调用 `fleet_reply_permission(node="slave-a", session_id="ses_xyz", request_id="per_002", reply="reject")`

**Then**:
- fleet 向 slave 发送 `POST /api/session/ses_xyz/permission/per_002/reply`，body `{ "reply": "reject" }`
- slave 返回 HTTP 204
- `permissionCache` 中 `per_002` 被移除
- 返回文本包含 `replied "reject"`
- slave session 恢复执行，工具调用收到拒绝错误，slave agent 按自身逻辑处理（可能报错、回退或继续其他步骤）

---

### 场景 3（Error Path）：reply 参数非法

**Given**:
- master 调用 `fleet_reply_permission(node="slave-a", request_id="per_003", reply="always")`

**Then**:
- handler 在枚举校验阶段拒绝
- 返回 isError=true，文本提示 `reply must be "once" or "reject"`
- 不发起任何 HTTP 请求

---

### 场景 4（Happy Path）：session 变 idle 时 permissionCache 自动清理

**Given**:
- session `ses_abc` 有两条 pending permissions：`per_001`、`per_002`
- 外部操作（如用户直接在 slave 终端 reject）导致 slave 发出 `session.status: idle` 事件

**When**:
- SSE 流接收到 `session.status: idle` for `ses_abc`

**Then**:
- `statusCache` 更新为 `{ type: "idle" }`
- `permissionCache` 删除 `ses_abc` 的所有记录
- idle waiters 被触发（现有行为保持）
- 后续 `fleet_get_session_status` 返回 `Status: idle`，不含 pendingPermissions 段落

---

## 5. 测试策略

### 单元测试（tests/node.test.ts）

- `applyEvent` 收到 `permission.asked` 时，`getPendingPermissions()` 返回包含正确 id/permission/patterns 的列表
- 同一 session 连续两个 `permission.asked` 事件，列表追加而非覆盖
- `applyEvent` 收到 `session.status: idle` 时，`permissionCache` 被清理，`getPendingPermissions()` 返回空数组
- `removePendingPermission` 只移除指定 requestId，其他记录保留
- 不存在的 session 调用 `getPendingPermissions()` 返回空数组

### 单元测试（tests/tools.test.ts）

- `fleet_get_session_status`：session busy 且有 pending permissions，返回文本包含 permission 详情段落
- `fleet_get_session_status`：session busy 但 pendingPermissions 为空，输出与原来完全相同（回归）
- `fleet_reply_permission`：reply="once"，正确调用 `node.replyPermission`，返回成功文本
- `fleet_reply_permission`：reply="reject"，正确调用 `node.replyPermission`，返回成功文本
- `fleet_reply_permission`：reply="always"，返回 isError=true，不调用 replyPermission
- `fleet_reply_permission`：缺少 request_id，返回 isError=true

### E2E 测试（tests/e2e/tools.e2e.ts）

由于 E2E 环境无法可靠触发真实的 `permission.asked` 事件，E2E 测试通过 `injectPermissionForTesting` 注入状态：

- 注入 pending permissions 后调用 `fleet_get_session_status`，验证输出包含 permission 段落
- 注入后调用 `fleet_reply_permission` 成功（mock HTTP 204），验证 permissionCache 被清理

真实 permission reply 流程（需 live slave 且配置 ask 规则）：在 `.env.e2e.example` 中标注为可选场景，skipIf 没有配置对应环境变量。

---

## Recommendation

建议级别: Normal-Light  
理由: 仅涉及后端纯逻辑变更（node.ts + tools.ts，共 2 个文件），无 DB migration，无前端，无跨层变更；但涉及业务逻辑（SSE 事件处理、新 HTTP 端点封装、工具扩展），超出 Trivial 标准。
