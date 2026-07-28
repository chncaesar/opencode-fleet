# Progress: fleet-permission-aware

## State
stage: S3
running_agent: Coder
branch: feature/fleet-permission-aware
worktree: /work/code/joint-debug/worktrees/fleet-permission-aware
last_action: 用户已确认 DESIGN.md
next_action: Coder 实现中

## Completed
- [x] S0: 创建 worktree + 分支 + docs 目录
- [x] S1: Planner 产出 DESIGN.md（用户已确认）

## Decisions
- reply 仅支持 "once" / "reject"，不暴露 "always"
- permissionCache 与 statusCache 独立，idle 时自动清理
- fleet_get_session_status 文本输出追加 pendingPermissions 段落（向后兼容）
- 新工具 fleet_reply_permission：参数 node, request_id, reply, 可选 session_id, message
