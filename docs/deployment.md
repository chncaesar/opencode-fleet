# Slave 节点部署指南

本文档记录如何在各平台上部署 opencode fleet slave 节点，包括安全配置和启动方式。

设计原理见 [slave-safety-design.md](./slave-safety-design.md)。

---

## 快速启动

在项目目录下以 `--auto` 模式启动 slave server：

```bash
cd /path/to/your/project
OPENCODE_SERVER_PASSWORD=your-password opencode serve --hostname 0.0.0.0 --port 4096 --auto
```

`--auto` 的作用：`allow` 规则自动通过，`deny` 规则直接报错返回（不弹 approval 挂起），`ask` 规则自动 approve。这是消除 server 模式假死的关键。

---

## 安全配置：opencode permission 规则

### managed config（推荐，全局强制）

在以下路径创建配置文件，权限最高（用户不可覆盖），无论 slave 在哪个目录启动都生效：

- **Linux**：`/etc/opencode/opencode.jsonc`（需 root）
- **macOS**：`/Library/Application Support/opencode/opencode.jsonc`（需 admin）
- **Windows**：`%ProgramData%\opencode\opencode.jsonc`（需管理员）

配置示例（根据实际项目路径调整）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "*": "deny",
      "ps *": "allow",
      "ls *": "allow",
      "cat *": "allow",
      "grep *": "allow",
      "git *": "allow",
      "python3 *": "allow",
      "cmake *": "allow",
      "make *": "allow",
      "ninja *": "allow",
      "kill *": "allow",
      "pkill *": "allow",
      "nohup *": "allow",
      "tail *": "allow",
      "head *": "allow",
      "sleep *": "allow",
      "rm /tmp/*": "allow",
      "rm -f /tmp/*": "allow",
      "rm -rf /tmp/*": "allow"
    },
    "edit": {
      "*": "deny",
      "/work/code/**": "allow",
      "/tmp/**": "allow"
    },
    "external_directory": {
      "/work/code/**": "allow",
      "/tmp/**": "allow"
    }
  }
}
```

### 项目级配置（叠加项目特定规则）

在项目目录下创建 `opencode.jsonc`，与全局/managed config 深合并，可添加项目特定白名单：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "VBoxManage *": "allow"
    }
  }
}
```

### 环境变量方式（CI/CD 场景）

无需修改配置文件，通过 `OPENCODE_PERMISSION` 环境变量注入（加载优先级最高之一）：

```bash
export OPENCODE_PERMISSION='{"bash":{"*":"deny","git *":"allow","rm /tmp/*":"allow"}}'
opencode serve --hostname 0.0.0.0 --port 4096 --auto
```

---

## OS 层隔离（可选加固）

在 opencode permission 规则之上，可额外配置 OS 层文件系统隔离。这是硬隔离，任何工具调用都无法绕过。

### Linux（systemd-run）

```bash
cd /work/code/serialplot-master
systemd-run --user --scope \
  -p ReadWritePaths=/work/code \
  -p ReadWritePaths=/tmp \
  -p TemporaryFileSystem=/home:ro \
  -- env OPENCODE_SERVER_PASSWORD=your-password \
  opencode serve --hostname 0.0.0.0 --port 4096 --auto
```

### macOS（sandbox-exec）

创建 profile 文件 `/etc/fleet/opencode-slave.sb`：

```scheme
(version 1)
(deny default)
(allow process-exec*)
(allow file-read*
  (subpath "/usr")
  (subpath "/opt/homebrew")
  (subpath "/work/code")
  (subpath "/tmp"))
(allow file-write*
  (subpath "/work/code")
  (subpath "/tmp"))
(allow network*)
(allow process*)
```

启动：

```bash
cd /work/code/serialplot-master
sandbox-exec -f /etc/fleet/opencode-slave.sb \
  env OPENCODE_SERVER_PASSWORD=your-password \
  opencode serve --hostname 0.0.0.0 --port 4096 --auto
```

### Windows（icacls）

Windows 无等价的 allowlist 隔离机制，使用 `icacls` 对敏感目录设置 deny ACL（blocklist 方式）：

```bat
:: 启动前：锁住敏感目录
icacls "%USERPROFILE%\Documents" /deny %USERNAME%:(W)
icacls "%USERPROFILE%\.ssh" /deny %USERNAME%:(W)
icacls "%USERPROFILE%\Desktop" /deny %USERNAME%:(W)

:: 启动 slave
set OPENCODE_SERVER_PASSWORD=your-password
cd C:\work\code\serialplot-master
opencode serve --hostname 0.0.0.0 --port 4096 --auto

:: slave 停止后：恢复权限
icacls "%USERPROFILE%\Documents" /remove:d %USERNAME%
icacls "%USERPROFILE%\.ssh" /remove:d %USERNAME%
icacls "%USERPROFILE%\Desktop" /remove:d %USERNAME%
```

注意：`icacls` 是 blocklist（拒绝指定目录），不是 allowlist（只允许特定目录）。配合 opencode permission deny 规则可弥补这个差距。

---

## 验证配置

启动 slave 后，用 `opencode debug config` 查看合并后的完整配置，确认 permission 规则生效：

```bash
cd /path/to/your/project
opencode debug config
```

查看输出中的 `permission` 字段，确认 deny 规则已正确加载。
