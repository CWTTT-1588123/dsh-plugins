---
name: handoff-pack
description: 生成、校验或消费当前工作区的确定性会话交接包（HANDOFF.md + manifest.json）。
---

# handoff-pack：会话交接包

## 何时用

- 长会话即将结束/上下文快满，需要把"做到哪、下一步、要复核什么"交给新会话；
- 接手一个新会话，先要判断上一会话留下的交接包**是否仍然可信**（代码/git HEAD 是否漂移）；
- 需要一份可校验的证据快照（git HEAD、文件 sha256、会话工具调用轨迹），而不是一段无法核对的叙述。

不要用：会话全文回放、长期记忆、项目管理、自动执行下一步、自动 push。

## 怎么生成

1. 先 `handoff_pack action=scan`：只采集 + 预览，不写盘，确认要采集的文件和 warnings；
2. 再 `handoff_pack action=create`，尽量由调用方提供真实输入：
   - `title` / `goal` / `summary`：本会话实际做了什么，**生成器不会编造**；
   - `decisions` / `nextSteps` / `concepts` / `flow` / `risks`：结构化条目；
   - `files`：关键文件的工作区相对路径（绝对路径/`..` 会被拒绝）；
   - `copyFiles=true`：把关键文件脱敏后复制进 `evidence/files/`（默认关闭）。
3. 输出默认在用户级 `$DSH_HOME/handoff/<project-key>/<batch-id>/`；只有显式 `target=workspace` 才写 `<workspace>/.dsh/handoff/`。没有静默回退：权限不足会返回结构化错误和修法。

## 权威顺序

1. `manifest.json` 的哈希与 `SHA256SUMS`（可复算的机器证据）；
2. `HANDOFF.md` 中带 `[文件哈希]`/`[git]`/`[会话]`/`[输入]` 标签的断言；
3. 交接包正文中的无标签叙述（视为线索，不是事实）；
4. 会话记忆（最低权威）。

P0 证据缺口（如实标注）：没有 `git status`（禁子进程）、没有 mtime（fs 无此 API），所以不产出"最近改动"，用 git reflog + 会话 `tool/call` 元数据替代。

## 新会话怎么读

1. `handoff_pack action=verify batchId=<id>`（缺省=当前项目最新批次），确认 `ok:true`；
2. 按 `HANDOFF.md` 的 H2（概念）→ H3（代码地图）→ H4（已验证事实）→ H8（首轮动作）顺序读；
3. 对 H4 抽查至少 3 条哈希：PowerShell `Get-FileHash <path> -Algorithm SHA256` 或 `sha256sum <path>`，与 manifest/HANDOFF 记录比对；
4. 汇报漂移：断言 / 期望值 / 实际值 / 结论（可信 / 已漂移 / 待验）。

## 边界

- 不编造：缺失输入写"未提供，待补"，不确定写 `[待验]`；
- 不含密钥：文件级 denylist + 规则脱敏 + 写盘前终检，命中即整批失败；
- 不 commit、不 push、不改工作区业务文件（除显式 `target=workspace` 的 `.dsh/handoff` 输出）；
- 不联网、不起子进程、不调 LLM；只读 `.git` 与工作区文件；
- 不把 `HANDOFF.md` 当事实来源覆盖当前代码：先 verify，再以代码/实测为准。
