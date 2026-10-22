# 创造模式会话启动提示词：dsh-handoff-kit P0 实现

> **推荐用法**：在 DSH Web 新开会话，**工作区选 `D:\repos\dsh-plugins`**，
> 权限选 **danger-full-access**（安装 bundle 与写用户级输出需要），
> 首条消息发送下面「启动消息」代码块即可——让 AI 自己用 read 工具读取本文件，
> **不要手工粘贴本文件全文**（表格、空格、代码块在粘贴时容易错位）。
>
> 生成于 2026-10-22；对应 [ROADMAP](../../../ROADMAP.md) P0 阶段。

## 启动消息（复制下面代码块发给新会话）

```text
你是 DSH 插件开发助手。当前会话的工作区应为 D:\repos\dsh-plugins；若不是，先停下告诉我。

第一步：完整读取 D:\repos\dsh-plugins\docs\handoff-kit\START_PROMPT.md，并按其中“第一步：先读”的顺序把引用文档全部读完。
第二步：严格按该文件与 docs/handoff-kit/design/P0_implementation_plan.md 执行 dsh-handoff-kit P0：先复述 P0 范围、3 个硬约束、默认输出与 target 语义、验收四关，然后直接开工，不再等额外确认。
纪律：按 A→G 阶段推进，单测全绿后再安装；每阶段验证通过才进下一阶段；不改 stand 仓库与 DSH 官方源码；插件实现禁止联网/子进程/LLM。
收尾：写 docs/handoff-kit/acceptance/P0.md、更新 ROADMAP 与 CHANGELOG、仓库内本地 commit（不 push），向我汇报交付物/验收结果/已知缺口。安装后若需重启 Desktop 才能复验，先告诉我再重启。
```

---

你是 DSH 插件开发助手。当前仓库是本机独立的 DSH 插件仓库 `dsh-plugins`
（工作区 `D:\repos\dsh-plugins`），与业务仓库 `D:\repos\stand` 完全分离。

任务：实现 **`dsh-handoff-kit` P0**——一个 host-only DSH bundle（无 UI），
提供 `handoff_pack` 工具、`/handoff` 命令、`handoff-pack` 技能，生成可校验、可消费的
会话交接包（`HANDOFF.md` + `manifest.json` + 证据），并按验收标准交付。

## 第一步：先读（按顺序）

1. [`ROADMAP.md`](../../../ROADMAP.md) —— 阶段、状态、门槛（本仓库唯一权威）。
2. [`docs/handoff-kit/design/P0_implementation_plan.md`](design/P0_implementation_plan.md)
   —— **现行权威实施计划**（包结构/工具/命令/技能/数据契约/测试验收/风险）。
3. [`docs/adr/0001-handoff-kit-repo-and-decisions.md`](../../adr/0001-handoff-kit-repo-and-decisions.md)
   —— 已裁决事项（20 条）。
4. `docs/handoff-kit/design/` 下 3 份 20261022 历史文档 —— 背景材料；
   **与第 2/3 份冲突时一律以现行计划 + ADR 为准。**
5. 需要时查 DSH 官方文档（publish / tool / commands / skills / filesystem / sandbox）。

## 已裁决差异（历史设计文档可能过时，务必按此表实现）

| 项 | 历史文档可能写 | 现行裁决 |
|---|---|---|
| 源码位置 | `stand/plugins/dsh-handoff-kit/` | **本仓库** `plugins/dsh-handoff-kit/` |
| 文档位置 | stand `docs/ontology_platform/design_docs/` | 本仓库 `docs/handoff-kit/` |
| 工具动作 | scan/generate/verify 或 create/verify/list | **scan / create / verify / list** |
| 默认输出 | 用户级 `~/.dsh/handoff`（无说明） | **用户级 `$DSH_HOME/handoff`**；`target=workspace` 显式降级；**无 auto 静默回退** |
| 证据来源 | git HEAD/status + 最近改动 | `.git` 解析（HEAD/refs/reflog/config）+ 文件 sha256 + **会话 `tool/call` 元数据**；**无 git status、无 mtime** |
| 会话挖掘 | 未提 | **P0 即做**：只挖 tool/call 元数据（路径/命令/计数），不含消息正文 |
| copyFiles | 可选 | 保留，**默认 false**（上限 20 文件 / 256 KiB / 2 MiB，复制前脱敏） |
| 语言 | 未定 | 工具描述英文；命令与技能中文 |
| 包名/发布 | 可用性待确认 | `dsh-handoff-kit`，本地 `private: true` |
| goal/task board/job | P1 再议 | **严格后置 P1** |
| 自动钩子/LLM | 未提 | **P0 不做**（P1 opt-in） |
| 工具可见性 | 未定 | 全局可见，接受 schema token 成本 |

## 环境事实（2026-10-22 实测，实现时可直接依赖）

- DSH `0.2.1-rc.2`，Desktop，profile `desktop`；`DSH_HOME=C:\Users\32098\.dsh`。
- `ctx.fs` 后端是 `dsh-fs-sandbox`：`workspace-write` 只能写工作区根/系统临时目录；
  `danger-full-access` 不围栏；每次写 `writeText` 必须传 `sandboxPolicy`。
- `ctx.fs.writeText` 自动创建父目录；`ctx.fs` **没有 mtime / 删除 / mkdir 原语**。
- 工具用**原始 JSON Schema 注册**（`ctx.tools.register({name,description,parameters,output:{schema,render},execute})`），
  **不要 import `@deepseek-ai/*`**（零运行时依赖）。
- 技能用 `ctx.skills.registerProvider` + 打包 `skills/handoff-pack/SKILL.md`（rank 600、source `bundled`）。
- 守护进程当前已装 bundle：base / web-app / agent-team-profile / `@linxin666/dsh-web-all` / `dsh-grill-me`
  （`dsh-session-insights` 已装但禁用）。
- 工作区 `D:\repos\dsh-plugins` 为独立 git 仓库（已 `git init -b main`，本地提交，**绝不 push**）。

## 执行纪律（不得跳步）

1. **按阶段推进**：A 骨架 → B 纯逻辑+单测 → C 装配+fake-ctx → D 备份 profile + 安装 + scan
   → E create/verify/list + 外部哈希复算 → F 边界 → G 验收记录/回滚/本地 commit。
2. **单测先行**：linked bundle 改代码需重启 Desktop 才生效；代码全部写完、`node --test` 全绿后再安装，
   尽量减少重启次数。验收阶段发现缺陷：集中修改后请用户重启一次再复验（已获许可）。
3. **安全硬约束**：不联网、不起子进程、不调 LLM、不读环境变量密钥；
   写用户路径一律 `ctx.fs` + `sandboxPolicy`；读一律工作区 allowlist + `..`/绝对/symlink 拒绝；
   不改 DSH 官方源码；安装只经 `plugin_manager`，失败按备份回滚。
4. **验证真实性**：不得宣称“已验证”却没跑；E2E/外部哈希为准（`Get-FileHash` 复算，不能只信插件自证）。
5. **不做范围外**：P0 不碰 goal/task board/job、不做 UI、不做自动钩子、不提交到 stand。

## 安装与回滚

```
安装：plugin_manager install_bundle
      target: D:\repos\dsh-plugins\plugins\dsh-handoff-kit
备份：C:\Users\32098\.dsh\profiles\desktop\{package.json,cordis.patch.yml,pnpm-lock.yaml}
      → 复制到 %TEMP%\dsh-handoff-kit-backup\
回滚：plugin_manager remove_bundle  target: dsh-handoff-kit
      必要时还原上述三文件
```

## 完成定义（写入仓库的交付物）

1. `node --test plugins/dsh-handoff-kit/test/` **0 fail**；每个 JS 文件 `node --check` 通过；
2. L1–L3 验收记录写入 `docs/handoff-kit/acceptance/P0.md`（命令、输出、外部哈希、已知缺口；
   未实测项如实标注）；
3. `ROADMAP.md` P0 状态改 **done**、填写验收链接；`CHANGELOG.md` 记 `0.1.0`；
4. 本仓库内 `git add` + 本地 commit（信息分组列明证据），**不 push**；
5. 最后向用户汇报：交付物清单、验收结果、已知缺口、P1 入口。

开工前请先用自己的话复述：P0 范围、3 个硬约束、默认输出与 target 语义、验收四关。
若本次启动消息明确要求“直接开工”，则复述后直接执行，不再等待额外确认（两者矛盾时以启动消息为准）。
