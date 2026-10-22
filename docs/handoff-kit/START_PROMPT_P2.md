# 创造模式会话启动提示词：dsh-handoff-kit P2（UI 工作台）

<!-- docs-meta: status=frozen; phase=P2; verified=ca27745@2026-10-22; tracks=-; supersedes=-; superseded-by=- -->

> **状态：已冻结（P2 已完成，0.3.0）**：本文件只作为 D5 启动场景的历史记录，**不再作为新会话入口**。
> P2 验收见 [acceptance/P2.md](acceptance/P2.md)；后续会话入口按
> [ROADMAP](../../ROADMAP.md) 的当前阶段与 [文档索引](../README.md) 选择。
>
> **推荐用法**：在 DSH Web 新开会话，**工作区 `D:\repos\dsh-plugins`**、**创造模式（cordis）**、
> **danger-full-access**；首条消息发送下面代码块，让 AI 自己读文件（不要手工粘贴全文）。
> 生成于 2026-10-22；对应 [ROADMAP](../../ROADMAP.md) P2 与 [P2 计划](design/P2_plan.md)。
> 本文件取代已归档的 P0 启动词（`docs/archive/handoff-kit/START_PROMPT.md`）。

## 启动消息（复制下面代码块发给新会话）

```text
你是 DSH 插件开发助手。当前会话工作区应为 D:\repos\dsh-plugins；若不是，先停下告诉我。

第一步（只读，不改代码）：按顺序读取
1. ROADMAP.md
2. docs/README.md（唯一文档索引；只读 status=current 的文档）
3. docs/WORKSTREAMS.md（三线任务与执行顺序 D1–D5）
4. docs/adr/0003-prompt-first-and-ui.md（P2 决策依据）
5. docs/handoff-kit/design/P2_plan.md（本次实施计划，现行）
然后运行 node scripts/docs-check.mjs，必须 0 error（1 warning 已知：ADR-0001 冻结链接）。
读完先复述：P2 目标（prompt-first UI 工作台）、v1 范围/非目标、U0–U4 里程碑、硬约束、验收方式。

第二步（D5 开工）：按 P2_plan 的 U0 → U1 → U2 → U3 → U4 推进，不要跳步：
- U0 spike 必须先做：用 cordis_inspect 确认 conversation.input.left / sidebar.panellist / main 的注册方式，
  确认 Client half 打包/加载方式与 Host RPC 注册 API（host.call 通道已核实，注册方式未核实）；
  spike 不通时停下来报告并给出降级方案，不要硬写。
- 纪律：P0/P1 工具 API、manifest@2、证据模型、验收记录不改；UI 只调宿主 service，
  不复制 manifest 解析/校验逻辑；不联网、不起子进程、不调 LLM；
  写操作（生成/append/update）必须用户点击确认并显示目标目录；只读动作零写入。
- 每步完成后：单测全绿 + 实际浏览器验证（安装/刷新后点击），再进下一步。
  浏览器验证需要用户点击时，明确请用户操作并等待反馈，不得把"注册成功"当成"UI 可用"。

收尾（U4）：写 docs/handoff-kit/acceptance/P2.md（命令/截图描述/实测结果/已知缺口）；
更新 docs/README.md 索引、ROADMAP P2 状态、CHANGELOG 0.3.0；node scripts/docs-check.mjs 0 error；
仓库内本地 commit（不 push）；向我汇报交付物/验收结果/缺口。
若需要重启 Desktop 或刷新页面才能验证，先告诉我。
```

## 参考链接

- [ROADMAP](../../ROADMAP.md) / [文档索引](../README.md) / [三线协调](../WORKSTREAMS.md)
- [ADR-0003](../adr/0003-prompt-first-and-ui.md) / [P2 计划](design/P2_plan.md)
- [P1 验收记录](acceptance/P1.md) / [GAPS](GAPS.md) / [插件 README](../../plugins/dsh-handoff-kit/README.md)
