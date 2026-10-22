# ADR-0001：handoff-kit 仓库拆分与 P0 关键决策

<!-- docs-meta: status=frozen; phase=P0; verified=c275312@2026-10-22; tracks=-; supersedes=-; superseded-by=- -->

- 日期：2026-10-22
- 状态：已接受
- 相关：[P0 实施计划](../handoff-kit/design/P0_implementation_plan.md)、[START_PROMPT](../handoff-kit/START_PROMPT.md)

## 背景

“通用交接包生成器”要落成 DSH 插件（`dsh-handoff-kit`）。首版方案把源码放在业务仓库
`D:\repos\stand\plugins\` 下，但用户提出两条要求：

1. **物理/版本解耦**：插件代码、设计文档、验收记录、后续路线不能散落在 stand 业务仓库里；
2. **时间/路线落地**：不能只有 P0，需要 P0→P3 全局路线，每阶段有范围、交付物、验收与门槛。

同时 DSH 有一个硬约束：**文件沙箱边界 = 会话工作区**。插件源码若在 stand 之外，
开发插件必须使用“工作区 = 插件仓库”的会话（workspace-write 下才可编辑）；
stand 会话只做业务。安装走 `install_bundle` 绝对目录链接，与工作区无关。

## 决策

### A. 仓库与文档

1. 新建独立 git 仓库 **`D:\repos\dsh-plugins`**（多插件单仓），本地提交、不 push。
2. 插件源码：`plugins/<包名>/`；跨插件路线：根 `ROADMAP.md`；文档：`docs/<插件>/{design,acceptance}/`。
3. 原 stand 仓库的 3 份 handoff-kit 设计文档**迁移**到 `docs/handoff-kit/design/`
   （迁移时均为未跟踪文件，无 git 历史负担）；stand 不再保留插件文档；
   业务文档（如本体交接样例）留在 stand。
4. 新阶段的设计/验收/ADR/CHANGELOG 一律写本仓库；`ROADMAP.md` 为阶段状态唯一权威。

### B. P0 产品形态

5. host-only bundle：**无 UI、无 Client 半区、无 LLM、无 DB、无自动阈值/compaction 钩子**；
   手动触发。
6. 工具动作命名：**`scan` / `create` / `verify` / `list`**（`generate` 等价 `create`）。
7. 输出目标：**默认用户级** `$DSH_HOME/handoff/<project-key>/<batch-id>/`；
   `target=workspace` 为显式降级（写 `<workspace>/.dsh/handoff`）。
   **不提供 `auto` 静默回退**——行为必须可预测；沙箱拒绝时明确报错并给出两条修法。
8. **P0 即加入会话 `tool/call` 元数据挖掘**：只读当前会话事件，提取文件类工具路径、
   shell 命令（脱敏 + 截断）、调用计数；**不含用户/助手消息正文**，不追加自定义 session event。
9. `copyFiles` 保留，默认 `false`；上限 20 文件 / 单文件 256 KiB / 总计 2 MiB，且复制前脱敏。
10. 语言：工具描述英文；`/handoff` 命令与 `handoff-pack` 技能中文。
11. 包名 `dsh-handoff-kit`，本地 `private: true`（需要发布时再补发布元数据）。
12. goal / task board / job 集成严格后置到 P1。
13. 接受 `handoff_pack` 对全部会话全局可见（约 +400~600 tokens schema）。

### C. 执行与验收

14. 允许按需重启 Desktop（linked bundle 改代码需重启才生效）；单测全绿再安装，减少重启。
15. P0 验收记录写 `docs/handoff-kit/acceptance/P0.md`（命令、输出、证据、已知缺口）。
16. 不改 DSH 官方源码；安装只经 `plugin_manager`；安装前备份 profile 三文件，失败可回滚。

### D. P1 及以后

17. 真实改动证据优先用 **`ctx.workspaceChanges`**，**继续禁子进程**。
18. LLM 叙述增强 **opt-in，默认关**；确定性骨架仍是权威。
19. 自动草稿钩子 **P1 opt-in，默认关**；默认语义永远是手动触发。
20. 全局路线 P0→P3 四阶段，版本映射 P0=0.1.x / P1=0.2.x / P2=0.3.x / P3=1.0；
    每阶段以“验收记录 + 回归绿 + 回滚演练 + 用户确认”为门槛。

## 后果

- stand 仓库不再承载插件源码/文档；仅保留一行 `.dsh/` 忽略规则（opt-in 工作区输出兜底）。
- 插件开发需在工作区为 `D:\repos\dsh-plugins` 的 DSH 会话中进行（推荐 danger-full-access）。
- 用户级输出要求会话为 `danger-full-access`；`workspace-write` / `read-only` 会话生成会
  返回结构化拒绝与修法提示。
- P0 已知证据缺口：无 `git status`、无 mtime（fs 服务无此 API 且禁子进程）⇒
  用 HEAD/reflog/sha256/`tool/call` 元数据构成证据，并在产物与 manifest 中如实标注。
- 安装后 profile 记录 `link:D:\repos\dsh-plugins\plugins\dsh-handoff-kit`。

## 未采纳方案

- 插件源码放 stand/plugins：与解耦诉求相反，文件仍散落业务仓库。
- `target=auto` 按沙箱静默选目录：产物落点不可预测，交接包位置难找。
- P0 引入子进程取 `git status`：违反 P0 硬约束（不联网、不起子进程）。
- P0 默认 LLM 摘要：成本/隐私/可重复性变差，暂停定骨架原则被破坏。
- 单插件独立仓库：后续 UI 伴侣包、自动钩子插件会让路线/文档再次分散。
