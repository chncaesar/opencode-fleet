# Slave 节点安全架构设计

## 背景与问题

### 原始场景

fleet MCP Server 指挥 slave opencode 节点执行测试任务时，slave 以 server 模式运行。当 master 下发包含 `rm -f` 的 bash 命令时，opencode 弹出 approval 请求，但 server 模式下没有交互终端，approval 永久挂起，导致 session 进入假死状态（status 持续 busy，新消息排队无法执行）。

### 根本缺陷

原有架构是哑管道：

```
master AI → fleet MCP → slave opencode
               ↑
          只是透明转发
          无语义、无边界、无策略
```

所有安全知识外包给 AGENTS.md，而 AGENTS.md 是用户自己写的，不属于工具本身。用户拿到 MCP Server 就是拿到一根没有绝缘层的电线。

---

## 设计目标

构建一个**完整自包含**的 fleet 安全方案：

1. 策略随工具携带，不依赖外部 AGENTS.md
2. 硬性边界由 OS 或运行时强制，不依赖 AI 自律
3. 错误有语义，master 能自动修正
4. 单一真相来源，用户只维护一个地方

---

## 方案一：opencode permission 系统作为策略源

### 原理

opencode 自身的 `permission` 配置就是所需要的 capability manifest：

- 已有经过测试的规则引擎（glob pattern matching）
- `deny` 是硬拦截，不是 AI 软约束
- 配合 `--auto` 启动：`deny` 直接报错返回，不再弹 approval 挂起，彻底消除假死
- 规则随 `opencode.jsonc` 文件走，天然自包含

### opencode 配置合并机制（源码确认）

opencode 使用 `remeda.mergeDeep` 对所有配置层做**深合并**（`packages/opencode/src/config/config.ts`），不是替换。

加载顺序（后者覆盖前者，冲突 key 后者优先，非冲突 key 全部保留）：

1. Remote config（`.well-known/opencode`）
2. Global config（`~/.config/opencode/opencode.jsonc`）
3. `OPENCODE_CONFIG` 环境变量
4. Project config（cwd 向上查找到 git root 的 `opencode.jsonc`）
5. `.opencode/` 目录配置
6. `OPENCODE_CONFIG_CONTENT` 环境变量
7. **Managed config**（Linux: `/etc/opencode/`，macOS: `/Library/Application Support/opencode/`，Windows: `%ProgramData%\opencode`）← 最高优先级，用户不可覆盖
8. `OPENCODE_PERMISSION` 环境变量（仅覆盖 permission 字段，适合 CI/CD）

深合并效果示例：

```
全局配置:   { "permission": { "bash": { "*": "ask", "git *": "allow" } } }
项目配置:   { "permission": { "bash": { "rm /tmp/*": "allow" } } }
合并结果:   { "permission": { "bash": { "*": "ask", "git *": "allow", "rm /tmp/*": "allow" } } }
```

三条规则全部保留，项目配置叠加到全局，不覆盖。

### 配置分层策略

利用 managed config 作为不可覆盖的全局 deny 层：

```
managed config（/etc/opencode/ 等）  ← 管理员部署，最高优先级，用户不可覆盖
~/.config/opencode/opencode.jsonc   ← 用户全局配置（provider、plugin、mcp）
项目级 opencode.jsonc               ← 项目特定规则，深合并叠加
```

无论 slave opencode 在哪个项目目录下启动，managed config 的 deny 规则始终生效。这是真正的"部署一次全局有效"方案。

### 启动方式

slave 以 `--auto` 模式启动：`allow` 自动通过，`deny` 直接报错返回（不弹 approval），`ask` 自动 approve。

具体启动命令见 [deployment.md](./deployment.md)。

---

## 方案二：OS 级隔离

### 原理

在 OS 内核层限制 slave opencode 进程的文件系统访问，任何工具调用都无法绕过。这是比 opencode permission 更底层的硬隔离。

各平台方案：

- **Linux**：`systemd-run --user --scope -p ReadWritePaths=...`，利用 cgroup 和 namespace
- **macOS**：`sandbox-exec -f profile.sb`，利用 macOS Sandbox kernel extension
- **Windows**：无等价单命令方案。选项：WSL2 内用 systemd-run；或 `icacls /deny` 对敏感目录设置 blocklist deny ACL；或 Windows Sandbox（需 Pro/Enterprise）

> 这是可选的部署加固措施，不是 fleet 产品自身的功能。需要记录在部署文档中，由运维人员根据安全需求决定是否启用。

具体命令见 [deployment.md](./deployment.md)。

---

## 推荐组合方案

```
managed config deny 规则（应用层全局强制）
       +
--auto 启动（消除 approval 阻塞）
       +
OS 层隔离（可选，部署加固）
```

三层防护互补：

- managed config：用户不可覆盖，任何项目下启动的 slave 都强制受约束
- `--auto`：消除假死；`deny` 规则直接报错，错误信息对 AI 有语义
- OS 层隔离：物理隔离，即使 opencode 被绕过也无效；可选加固

---

## fleet MCP 架构升级

### 当前架构（哑管道）

```
master → fleet MCP → slave opencode
```

### 目标架构（能力感知）

```
managed config（单一真相来源）
       ↓
fleet MCP 读取并暴露给 master（fleet_describe_node）
       ↓
master 在生成命令前知道边界
       ↓
slave 执行时 deny 规则硬拦截
```

### 新增工具：fleet_describe_node

fleet MCP 新增 `fleet_describe_node` 工具，在 master 首次使用节点前调用，返回节点能力的自然语言描述。master 建立正确心智模型后，生成越界命令的概率大幅降低。

**已实现方案**：向 slave 发一条一次性 prompt（`opencode debug config`），fleet MCP 解析返回的 JSON，提取 `permission` 字段，格式化为 Permission Policy 表格 + Capability Summary。

实现细节：
- 使用一次性 session（`createSession` → `sendPromptAsync` → `waitForIdle` → `getMessages` → `deleteSession`），节点已有的 session binding 完全不受影响，任何时候调用都安全
- JSON 提取使用括号嵌套深度计数（`findJsonEnd`），不受 JSON 后续文本或字符串值内 `}` 的干扰
- Capability Summary 覆盖 bash / write / edit 及任意其他工具，报告五种情形（allow-all / deny-all / ask-all / 混合 / 无规则）
- 超时时返回结构化的三步升级指引，明确提示需要人工检查

备选方案（未采用）：
- 通过 SSH 直接读取 slave 节点的 managed config 文件 — 不需要创建 session，但需要额外的 SSH 凭证配置
- 向 opencode 上游提 feature request，加只读的 permission 查询端点（opencode 目前无此 API）

### 结构化错误响应

> **[未实现 — 架构上无法在 fleet MCP 层实现]**

原始设计：slave 的 `deny` 发生时，返回带 `policy_violation` + `safe_alternative` 的结构化 JSON，让 master 能自动修正。

**为什么无法实现：**

opencode 的 `deny` 是 opencode 自身的 permission 引擎触发的，错误格式由 opencode 决定，fleet MCP 无法控制。实际链路是：

```
master 下发命令
  → slave opencode 执行 bash
  → opencode permission 引擎 deny
  → opencode 把错误写入 session 消息（opencode 自己的格式）
  → slave agent 读到错误，写一条 assistant 文字回复
  → fleet MCP 拉取消息，把文字透传给 master
```

要生成 `policy_violation` 结构化 JSON，只有两条路：

1. **改 opencode 本身**的 deny 错误格式 — 需要向上游提 PR，不在 fleet MCP 控制范围内
2. **在 slave AGENTS.md 里指示 slave agent**遇到 deny 时输出特定 JSON — 又回到"依赖 AGENTS.md"的问题，与本方案的设计目标矛盾

因此这个功能在当前架构下没有实现路径，暂不实现。

### fleet_send_message 超时行为

**设计初心：timeout 不是失败，slave 还在工作，master 应该等待而不是打断或 reset。**

超时时返回结构化状态，把"下一步应该等待"写进返回值：

- `status: "timeout_still_busy"` + `hint: "Do NOT reset"` → 引导等待
- `status: "completed"` + 空 reply + `warning` → agent mid-step，查消息历史
- `status: "queued"` + `warning` → slave 正忙，消息已排队

详见 [fleet-send-message-refactor.md](./fleet-send-message-refactor.md)。

### 人工介入触发条件

工具返回值附加 `escalate_hint: true`，触发条件：

1. slave 连续 2 次返回同类错误且 master 无法自动修正（如 permission deny 但无合法替代路径）
2. slave 返回边界错误且 master 无法在允许路径内完成等价操作

> 注：触发条件 1 目前依赖 master AI 的判断，没有 `policy_violation` 结构化信号辅助（原因见上节）。`escalate_hint: true` 字段在 fleet_describe_node 超时路径中已实现（文字层面），fleet_send_message 的结构化状态字段见 [fleet-send-message-refactor.md](./fleet-send-message-refactor.md)。

### AGENTS.md 内容迁移分析

凡是"检查 X 之后才能做 Y"的顺序约束，以及"返回值 Z 意味着什么"的语义解释，都内化进工具返回值，而不是靠 AGENTS.md 告诫 AI：

- 超时决策树 → 移入工具返回值
- timeout 引导等待（非 reset）→ 移入 hint 字段
- Queued messages warning → 移入 queued 状态
- Empty reply ≠ failure → 移入 warning 字段
- Escalate to human → 保留在 AGENTS.md + 工具 escalate_hint 字段辅助
- 心智模型描述、API quirks → 保留在 AGENTS.md

---

## 方案对比

| 维度 | AGENTS.md | opencode permission + --auto | + managed config | + OS 隔离 |
|------|-----------|------------------------------|-----------------|-----------|
| 用户需要写规则 | 是 | 是 | 管理员一次性 | 管理员一次性 |
| 规则随工具携带 | 否 | 是 | 是 | 是 |
| 用户可绕过 | 是 | 是（项目级可覆盖） | 否 | 否 |
| 硬性隔离 | 否 | 否（应用层） | 否（应用层） | 是（kernel 层） |
| 错误有语义 | 否 | 是（deny 报错友好） | 是 | 否（EPERM） |
| server 模式假死 | 会发生 | 不会（--auto） | 不会 | 不会 |
| 开箱即用 | 需读文档 | 配置后可用 | 部署一次全局 | 需额外部署 |
