---
name: handoff-pack
description: 生成、校验或消费当前工作区的确定性会话交接包（HANDOFF.md + manifest.json）。
---

<!-- docs-meta: status=current; phase=P2; verified=42fdf57@2026-10-22; tracks=plugins/dsh-handoff-kit/src; supersedes=-; superseded-by=- -->

# handoff-pack：会话交接包

## 何时用

- 长会话即将结束/上下文快满，需要把"做到哪、下一步、要复核什么"交给新会话；
- **接手一个新会话**：先用 `handoff_load` 判断上一会话留下的交接包是否仍然可信（trust + 漂移），再决定是否采信 HANDOFF 里的断言；
- 需要一份可校验的证据快照（git HEAD、文件 sha256、会话工具调用轨迹），而不是一段无法核对的叙述。

不要用：会话全文回放、长期记忆、项目管理、自动执行下一步、自动 push。

## 怎么生成

1. 先 `handoff_pack action=scan`：只采集 + 预览，不写盘，确认要采集的文件和 warnings；
2. 再 `handoff_pack action=create`，尽量由调用方提供真实输入：
   - `title` / `goal` / `summary`：本会话实际做了什么，**生成器不会编造**；
   - `decisions` / `nextSteps` / `concepts` / `flow` / `risks`：结构化条目；
   - `files`：关键文件的工作区相对路径（绝对路径/`..` 会被拒绝）；
   - `copyFiles=true`：把关键文件脱敏后复制进 `evidence/files/`（默认关闭）；
   - `includeDiffs=true`：附上有界 workspaceChanges diff（≤20 文件/单文件 64 KiB/总 512 KiB）。
3. 输出默认在用户级 `$DSH_HOME/handoff/<project-key>/<batch-id>/`；只有显式 `target=workspace` 才写 `<workspace>/.dsh/handoff/`。没有静默回退：权限不足会返回结构化错误和修法。
4. **同一工作连续交接**（P1/M2）：
   - `handoff_pack action=append previousBatchId=<上一批>` → 新建批次并记录血缘（默认最新批次）；
   - `handoff_pack action=update supersedes=<被替代批>` → 新建批次声明替代（默认最新批次）；
   - 两者都**不原地修改历史批次**；`verify` 会检查血缘（`LINEAGE_BROKEN`）与"已被替代"（`SUPERSEDED_BATCH`）。

生成时自动附带两类只读燃料（缺失时降级为 `available:false` + warning，不阻塞）：
- `changes`：宿主 `workspaceChanges` 的**已完成 turn**改动（H1「本会话改动」、H4 `[改动]`）；
  当前 turn 尚未结束、没有完整改动统计时，`changes.currentTurn` 会从会话 `tool/call`
  补上该 turn 的 file-tool 路径与计次（H1「当前未完成 turn 的触碰」，无增删行数）；
- `fuel`：当前 goal 与后台 jobs（只读，不自动执行）。

## 权威顺序

1. `manifest.json` 的哈希与 `SHA256SUMS`（可复算的机器证据）；
2. `handoff_load` 的 `trust` 判定与 findings/drift（当前状态是否仍与包一致）；
3. `HANDOFF.md` 中带 `[文件哈希]`/`[git]`/`[会话]`/`[输入]` 标签的断言；
4. 交接包正文中的无标签叙述（视为线索，不是事实）；
5. 会话记忆（最低权威）。

P0 证据缺口（如实标注）：没有 `git status`（禁子进程）、没有 mtime（fs 无此 API），所以不产出"最近改动"，用 git reflog + 会话 `tool/call` 元数据替代。

## 新会话怎么读

1. **首选** `handoff_load`（缺省=当前项目最新批次）：它内部先 verify，返回
   `trust: verified | stale | invalid` + findings/drift + 文件指针；
   - `verified` = 哈希/证据/源文件均未漂移，可以采信 H4 断言；
   - `stale` = 有 warning 或已漂移，**不要直接采信**，先看 findings；
   - `invalid` = 校验有 error，**停止**并按 next 处理（不采信、重新生成）；
   - 需要正文时用 `include=sections`（H0–H9 摘要）或 `include=full`（截断全文）。
2. 等价的人类命令：`/handoff resume [<batchId>]`（中文摘要）；只做哈希校验用 `handoff_pack action=verify`。
3. 需要逐字正文时直接读 `HANDOFF.md`：按 H2（概念）→ H3（代码地图）→ H4（已验证事实）→ H8（首轮动作）顺序；
4. 对 H4 抽查至少 3 条哈希：PowerShell `Get-FileHash <path> -Algorithm SHA256` 或 `sha256sum <path>`，与 manifest/HANDOFF 记录比对；
5. 汇报漂移：断言 / 期望值 / 实际值 / 结论（可信 / 已漂移 / 待验）。

> Windows/PowerShell 读 `manifest.json` / `HANDOFF.md` 时请**显式 UTF-8**：
> `[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)` 或 `Get-Content -Raw -Encoding utf8`。
> 否则中文会被按 ANSI 解码、`ConvertFrom-Json` 解析失败（实测踩坑：同一批次纯读取出现乱码/解析错误，改用显式 UTF-8 后正常）。

## 边界

- 不编造：缺失输入写"未提供，待补"，不确定写 `[待验]`；
- 不含密钥：文件级 denylist + 规则脱敏 + 写盘前终检，命中即整批失败；
- 不 commit、不 push、不改工作区业务文件（除显式 `target=workspace` 的 `.dsh/handoff` 输出）；
- 不联网、不起子进程、不调 LLM；只读 `.git` 与工作区文件；
- `handoff_load` 是只读消费，不写盘；不要用它替代 `handoff_pack action=create`；
- 不把 `HANDOFF.md` 当事实来源覆盖当前代码：先 verify/load，再以代码/实测为准。
