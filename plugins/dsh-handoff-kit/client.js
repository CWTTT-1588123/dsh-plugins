/**
 * dsh-handoff-kit Client half (plain browser module; no build step).
 *
 * Loaded lazily by the Web module system as this package's `./client` export.
 * It registers four surfaces:
 *   - a Handoff button at the left of the conversation composer
 *     (`conversation.input.left`),
 *   - a frame-wide floating panel (`shell.overlay`),
 *   - a sidebar panel icon and its center page (`sidebar.panellist` + `main`).
 *
 * Every piece of data comes from the Host half's authenticated `/api` route
 * (`/api/handoff-kit/rpc`): this file renders and copies, it does not parse
 * manifests, verify hashes or read the filesystem.
 *
 * Zero dependencies: React arrives from the module table, styles use the
 * host's `--dsw-alias-*` theme tokens. UI copy is English-first with Chinese
 * kept as a complete translation; the language is chosen from
 * `document.documentElement.lang` / `navigator.language` (zh* -> Chinese,
 * everything else -> English). The embedded `EN_MESSAGES`/`ZH_MESSAGES`
 * tables are mirrored into `locale/en.json` and `locale/zh.json`; a unit test
 * keeps the three in sync so neither copy drifts.
 */

window.__ModuleLoader__.load({
  id: 'dsh-handoff-kit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Authenticated Host route registered by src/ui.js. */
    const RPC_PATH = '/api/handoff-kit/rpc'
    const PROTOCOL = 1
    /**
     * Last conversation session this page saw. A root-scoped workbench surface
     * has no session binding of its own, and the Host falls back to the newest
     * live root session when this hint is stale or missing.
     */
    const SESSION_HINT_KEY = 'dsh.handoff-kit.lastSessionId'
    /**
     * Explicit UI language preference (`zh` / `en`). Set by the in-UI switch;
     * it outranks environment detection and survives reloads.
     */
    const LOCALE_KEY = 'dsh.handoff-kit.locale'
    /**
     * Sessions this page has seen, newest first. P2-G1: the workbench is a
     * root-scoped surface with no session binding of its own, so it shows an
     * explicit project/session selector backed by this (client-only) list plus
     * the Host's resolution; it never invents a Host project-listing method.
     */
    const KNOWN_SESSIONS_KEY = 'dsh.handoff-kit.knownSessions'
    const KNOWN_SESSIONS_LIMIT = 8
    /** Shared by the sidebar row and the `main` page (layout dispatches by key). */
    const PANEL_ID = 'handoff-kit'
    const BUTTON_ID = 'handoff'
    const BUTTON_ORDER = 40

    // ---------------------------------------------------------------- i18n
    /**
     * English UI copy (default language). Values are JSON-compatible on
     * purpose: locale/en.json carries the same table and a test compares both.
     * `{name}` placeholders are filled by the `t()` helper.
     */
    const EN_MESSAGES = /* i18n:en */ {
      "app.title": "Handoff",
      "app.subtitle": "Create and load session handoff packages",
      "app.workbenchTitle": "Handoff Workbench",
      "app.composerTitle": "Handoff: create or load handoff packages",
      "locale.label": "Language",
      "locale.zh": "Chinese",
      "locale.en": "English",
      "common.close": "Close",
      "common.cancel": "Cancel",
      "common.refresh": "Refresh",
      "common.refreshing": "Refreshing…",
      "common.openWorkbench": "Open workbench",
      "common.copyDirectory": "Copy directory",
      "common.copyOpeningPrompt": "Copy opening prompt",
      "common.copyAgain": "Copy again",
      "common.buildingPrompt": "Building prompt…",
      "common.insertIntoComposer": "Insert into composer",
      "common.verify": "Verify",
      "common.verifying": "Verifying…",
      "toast.copied": "Copied",
      "toast.copyManual": "Could not copy automatically; select the text manually",
      "toast.directoryCopied": "Directory copied",
      "toast.directoryCopyManual": "Could not copy automatically; select the directory manually",
      "toast.promptCopied": "Opening prompt copied",
      "toast.insertUnavailable": "Cannot insert: open the panel from the Handoff button in the composer",
      "toast.inserted": "Inserted into the composer",
      "error.requestFailed": "Request failed",
      "error.remedy": "Fix: {text}",
      "error.unreachable": "Cannot reach the Host service (the page or the Host may be restarting).",
      "error.unreachableRemedy": "Refresh the page and retry; if it still fails, confirm the plugin is enabled and the page is served by this local DSH instance.",
      "error.badResponse": "The Host returned a response that could not be parsed.",
      "error.badResponseRemedy": "Retry; if it still fails, check the DSH logs.",
      "error.hostRequestFailed": "Host request failed",
      "error.retryOnce": "Retry once.",
      "remedy.HANDOFF_READ_ONLY": "This session is read-only: switch the target to workspace or use a workspace-write session.",
      "remedy.HANDOFF_SANDBOX_DENIED": "The Host sandbox refused this write: check the session permission or switch the target to workspace.",
      "remedy.HANDOFF_PATH_ESCAPE": "Path escaped the allowed root: check the target and the workspace directory.",
      "remedy.HANDOFF_BATCH_EXISTS": "That batch already exists: enable overwrite (force) or retry later.",
      "remedy.HANDOFF_BATCH_NOT_FOUND": "No usable handoff batch found: refresh the list or create one on the Create tab first.",
      "remedy.HANDOFF_RESUME_NOT_FOUND": "No usable handoff batch found: refresh the list or create one on the Create tab first.",
      "remedy.HANDOFF_VERIFY_INVALID": "This batch is incomplete or failed verification: do not trust it; inspect the findings or regenerate it.",
      "remedy.HANDOFF_APPEND_TARGET_MISSING": "There is no batch to continue yet: create one on the Create tab, then continue the handoff.",
      "remedy.HANDOFF_LINEAGE_CYCLE": "Invalid lineage target (a batch cannot follow itself): leave it empty to use the latest batch.",
      "remedy.HANDOFF_MIGRATION_SOURCE_INVALID": "The source batch failed verification: fix or regenerate it before migrating.",
      "remedy.HANDOFF_MIGRATION_UNSUPPORTED_VERSION": "This schema version cannot be migrated by this build: upgrade the plugin.",
      "remedy.HANDOFF_MANIFEST_MISSING": "This batch is incomplete or failed verification: do not trust it; inspect the findings or regenerate it.",
      "remedy.HANDOFF_MANIFEST_INVALID": "This batch is incomplete or failed verification: do not trust it; inspect the findings or regenerate it.",
      "remedy.HANDOFF_WRITE_FAILED": "The Host failed to read or write: check directory permissions and disk space, then retry.",
      "remedy.HANDOFF_READ_FAILED": "The Host failed to read or write: check directory permissions and disk space, then retry.",
      "remedy.HANDOFF_SECRET_CHECK_FAILED": "Possible secret content was detected: clean it up and create the package again.",
      "remedy.HANDOFF_POLICY_INVALID": "The redaction policy is invalid ($DSH_HOME/handoff/policy.json): nothing was written (fail-closed); fix or remove that file and retry.",
      "remedy.HANDOFF_BATCH_REFERENCED": "This batch is still referenced by another batch lineage: delete the newer descendant batch(es) first, or use force explicitly (their LINEAGE_BROKEN finding follows).",
      "remedy.HANDOFF_INVALID_ARGS": "Invalid arguments: check the form and retry.",
      "remedy.HANDOFF_INTERNAL": "Host internal error: retry once; if it still fails, check the DSH logs.",
      "tab.create": "Create",
      "tab.load": "Load",
      "create.titleLabel": "Title",
      "create.titleHint": "Optional, up to 200 characters",
      "create.titlePlaceholder": "Handoff batch title (used in the manifest / list)",
      "create.summaryLabel": "Note",
      "create.summaryHint": "Optional, written into the H1 narrative of HANDOFF.md",
      "create.summaryPlaceholder": "One line about what matters in this handoff and what is unfinished",
      "create.targetLabel": "Target",
      "create.targetUser": "user (default, $DSH_HOME)",
      "create.targetWorkspace": "workspace (downgrade)",
      "create.targetRootLoading": "Target root: loading…",
      "create.writeRoot": "Write root: {root}",
      "create.dirNote": "Actual batch directory = root / project key / batchId; the Host computes it and shows it after creation. Nothing is written before you click.",
      "create.includeDiffs": "Include session change diffs (≤20 files / ≤512 KiB)",
      "create.submit": "Create handoff package",
      "create.submitAndCopy": "Create and copy opening prompt",
      "create.busy": "Creating…",
      "create.busyNote": "Collecting evidence and writing the package; this can take a few seconds… (this click confirmed the write)",
      "create.created": "Created",
      "create.artifacts": "{count} files",
      "create.artifactsWithBytes": "{count} files, {bytes}",
      "create.lineageSequence": "sequence {sequence}",
      "create.lineagePrevious": ", previous {batchId}",
      "create.lineageSupersedes": ", supersedes {batchId}",
      "create.warnings": "{count} warnings: {details}",
      "field.directory": "Directory",
      "field.evidence": "Evidence",
      "field.lineage": "Lineage",
      "field.title": "Title",
      "field.verifiedAt": "Verified at",
      "list.separator": ", ",
      "batchlist.untitled": "(untitled)",
      "batchlist.delete": "Delete",
      "batchlist.deleteTitle": "Delete this batch",
      "delete.title": "Delete handoff batch",
      "delete.subtitle": "Soft delete: the batch moves to the recycle bin and can be restored from the filesystem.",
      "delete.confirmBody": "Move batch {batchId} to the recycle bin? list / verify / load will no longer see it, but the files stay on disk under .trash/.",
      "delete.projectKeyLabel": "Project key",
      "delete.recycleBinLabel": "Recycle bin",
      "delete.softOnly": "This UI only soft-deletes; permanent deletion is available only through the CLI (--hard).",
      "delete.confirm": "Move to recycle bin",
      "delete.busy": "Deleting…",
      "delete.success": "Batch moved to the recycle bin",
      "prompt.heading": "New-session opening prompt",
      "prompt.trustBadge": "trust={trust}",
      "detail.loading": "Verifying: reading the package and re-checking hashes and drift…",
      "detail.empty": "Pick a batch on the left to inspect trust / drift / findings and copy the opening prompt.",
      "detail.counts": "errors: {errors} · warnings: {warnings}",
      "detail.driftNotChecked": "Drift: not checked",
      "detail.driftChanged": "Drift: gitHead {head} · {changed} source files changed · {missing} missing",
      "detail.driftHeadChanged": "changed",
      "detail.driftHeadUnchanged": "unchanged",
      "detail.driftClean": "Drift: none (gitHead unchanged, source hashes match)",
      "detail.findingsTitle": "Findings ({count})",
      "detail.findingsMore": "and {count} more…",
      "detail.warningsTitle": "Package warnings ({count}): ",
      "detail.nextSteps": "Next steps",
      "load.loadingBatches": "Reading batches…",
      "load.empty": "No batches yet. Switch to Create to make your first handoff package.",
      "continue.title": "Continue handoff",
      "continue.subtitle": "Writes a new batch; older batches are never modified",
      "continue.appendChoice": "append (continue the latest)",
      "continue.updateChoice": "update (mark supersedes)",
      "continue.updateNote": "Creates a new generation and records supersedes for the latest batch; the old batch stays untouched and read-only. Requires a second confirmation.",
      "continue.appendNote": "Appends a generation after the latest batch (lineage.previous); the old batch stays untouched.",
      "continue.baseBatch": "Base batch",
      "continue.noBatch": "(no batch available)",
      "continue.writeRoot": "Write root",
      "continue.dirNote": "The Host derives the actual batch directory from the project key and shows it after the write. Nothing is written before you click.",
      "continue.titleLabel": "Title",
      "continue.titleHint": "Optional",
      "continue.titlePlaceholder": "Title for this generation (optional)",
      "continue.summaryLabel": "Note",
      "continue.summaryHint": "Optional, written into H1",
      "continue.includeDiffs": "Include session change diffs",
      "continue.written": "New batch written",
      "continue.generation": "Generation {sequence}",
      "continue.viewBatch": "View this batch",
      "continue.confirmNote": "Second confirmation: a new supersedes batch will be created; the old batch is kept read-only.",
      "continue.confirmUpdate": "Continue handoff (update)",
      "continue.confirmWrite": "Confirm write ({mode})",
      "continue.writing": "Writing…",
      "panel.summaryLoading": "Loading…",
      "panel.project": "Project {name}",
      "panel.batches": "· {count} batches",
      "workbench.backToConversation": "Back to conversation",
      "workbench.description": "A handoff package is the evidence behind the new-session opening prompt; write actions (create / continue) show the target directory first and run only after you click.",
      "workbench.sessionUnbound": "unbound",
      "history.badge": "Historical project (read-only)",
      "history.notice": "Current project {project} has no batches. Showing {count} historical batch(es) from project key(s) {keys} read-only; new batches are still written to the current project key.",
      "history.continueDisabled": "Continue handoff is unavailable while viewing historical batches (they belong to another project key). Create a new batch to start lineage in the current project.",
      "selector.title": "Project / session",
      "selector.hint": "Choose the session whose workspace this workbench reads and writes; the project follows the session. Host default resolves the newest live session.",
      "selector.hostDefault": "Host default (newest live session)",
      "selector.knownEmpty": "No session recorded yet: open a conversation, click Handoff once, then return here.",
      "selector.project": "Project",
      "selector.workspace": "Workspace",
      "selector.session": "Session",
      "selector.value": "{label}: {value}",
      "selector.live": "live",
      "selector.fallbackBadge": "Host fallback",
      "selector.noticeImplicit": "This workbench is not explicitly bound: the Host resolved session {id}, so reads and writes use {cwd}. Choose a session above to pin it.",
      "selector.noticeFallback": "No live session is bound, so the Host falls back to {cwd}. Choose a session above (or open a conversation and click Handoff) to pin this workbench.",
      "selector.noticeStale": "Session {pinned} is not live; the Host resolved {resolved} instead. Pick a live session above or use Host default.",
      "selector.optionWithTitle": "{title} · {id}",
      "selector.optionNoTitle": "{id}"
    }
    /** Chinese UI copy: the original pre-i18n wire copy, kept in full. */
    const ZH_MESSAGES = /* i18n:zh */ {
      "app.title": "交接",
      "app.subtitle": "生成 / 载入会话交接包",
      "app.workbenchTitle": "交接工作台",
      "app.composerTitle": "交接：生成 / 载入交接包",
      "locale.label": "语言",
      "locale.zh": "中文",
      "locale.en": "English",
      "common.close": "关闭",
      "common.cancel": "取消",
      "common.refresh": "刷新",
      "common.refreshing": "刷新中…",
      "common.openWorkbench": "打开工作台",
      "common.copyDirectory": "复制目录",
      "common.copyOpeningPrompt": "复制开场提示词",
      "common.copyAgain": "再次复制",
      "common.buildingPrompt": "正在生成提示词…",
      "common.insertIntoComposer": "插入输入框",
      "common.verify": "校验",
      "common.verifying": "校验中…",
      "toast.copied": "已复制",
      "toast.copyManual": "无法自动复制，请手动选择文本",
      "toast.directoryCopied": "目录已复制",
      "toast.directoryCopyManual": "无法自动复制，请手动选择目录",
      "toast.promptCopied": "开场提示词已复制",
      "toast.insertUnavailable": "无法插入：请从输入框「交接」按钮打开面板",
      "toast.inserted": "已插入输入框",
      "error.requestFailed": "请求失败",
      "error.remedy": "修法：{text}",
      "error.unreachable": "无法连接宿主服务（页面或宿主可能正在重启）。",
      "error.unreachableRemedy": "刷新页面后重试；若仍失败，确认插件已启用且页面由本机 DSH 提供。",
      "error.badResponse": "宿主返回了无法解析的响应。",
      "error.badResponseRemedy": "重试；仍失败时查看 DSH 日志。",
      "error.hostRequestFailed": "宿主请求失败",
      "error.retryOnce": "重试一次。",
      "remedy.HANDOFF_READ_ONLY": "当前会话权限是只读：改用 target=workspace 或切换到 workspace-write 再试。",
      "remedy.HANDOFF_SANDBOX_DENIED": "宿主的沙箱拒绝了这次写入：检查会话权限，或把目标切到 workspace。",
      "remedy.HANDOFF_PATH_ESCAPE": "路径越界：检查 target 与工作区目录。",
      "remedy.HANDOFF_BATCH_EXISTS": "该批次已存在：勾选「覆盖（force）」或稍后重试。",
      "remedy.HANDOFF_BATCH_NOT_FOUND": "没有找到可用的交接批次：刷新列表，或先在「生成」里创建一包。",
      "remedy.HANDOFF_RESUME_NOT_FOUND": "没有找到可用的交接批次：刷新列表，或先在「生成」里创建一包。",
      "remedy.HANDOFF_VERIFY_INVALID": "该批次的包不完整或校验失败：不要直接信任，查看 findings 或重新生成。",
      "remedy.HANDOFF_APPEND_TARGET_MISSING": "没有可继续的目标批次：先在「生成」里创建一包，再继续交接。",
      "remedy.HANDOFF_LINEAGE_CYCLE": "血缘目标不合法（不能串到自己）：留空以使用最新批次。",
      "remedy.HANDOFF_MIGRATION_SOURCE_INVALID": "源批次未通过校验：修复或重新生成后再迁移。",
      "remedy.HANDOFF_MIGRATION_UNSUPPORTED_VERSION": "该 schema 版本无法由当前版本迁移：请升级插件。",
      "remedy.HANDOFF_MANIFEST_MISSING": "该批次的包不完整或校验失败：不要直接信任，查看 findings 或重新生成。",
      "remedy.HANDOFF_MANIFEST_INVALID": "该批次的包不完整或校验失败：不要直接信任，查看 findings 或重新生成。",
      "remedy.HANDOFF_WRITE_FAILED": "宿主读写失败：检查目录权限与磁盘空间后重试。",
      "remedy.HANDOFF_READ_FAILED": "宿主读写失败：检查目录权限与磁盘空间后重试。",
      "remedy.HANDOFF_SECRET_CHECK_FAILED": "检测到疑似密钥内容：清理后重新生成。",
      "remedy.HANDOFF_POLICY_INVALID": "脱敏策略配置无效（$DSH_HOME/handoff/policy.json）：已按 fail-closed 拒绝生成，请修正或删除该文件后重试。",
      "remedy.HANDOFF_BATCH_REFERENCED": "该批次仍被其它批次的 lineage 引用：先删除更新的后代批次，或显式 force（会让后代出现 LINEAGE_BROKEN）。",
      "remedy.HANDOFF_INVALID_ARGS": "参数不合法：检查表单内容后重试。",
      "remedy.HANDOFF_INTERNAL": "宿主内部错误：重试一次；仍失败时查看 DSH 日志。",
      "tab.create": "生成",
      "tab.load": "载入",
      "create.titleLabel": "标题",
      "create.titleHint": "可选，最多 200 字",
      "create.titlePlaceholder": "交接批次标题（用于 manifest / 列表）",
      "create.summaryLabel": "备注",
      "create.summaryHint": "可选，写进 HANDOFF 的 H1 叙述",
      "create.summaryPlaceholder": "一句话说明这次交接的重点 / 未完成事项",
      "create.targetLabel": "目标",
      "create.targetUser": "user（默认，$DSH_HOME）",
      "create.targetWorkspace": "workspace（降级）",
      "create.targetRootLoading": "目标根目录：读取中…",
      "create.writeRoot": "写入根目录：{root}",
      "create.dirNote": "实际批次目录 = 根目录 / 项目 key / batchId，由宿主计算并在生成后显示；点击前不会写盘。",
      "create.includeDiffs": "附带会话改动 diff（≤20 文件 / ≤512 KiB）",
      "create.submit": "生成交接包",
      "create.submitAndCopy": "生成并复制开场提示词",
      "create.busy": "正在生成…",
      "create.busyNote": "正在采集证据并写入交接包，可能需要几秒…（写操作已由这次点击确认）",
      "create.created": "已生成",
      "create.artifacts": "{count} 个文件",
      "create.artifactsWithBytes": "{count} 个文件，{bytes}",
      "create.lineageSequence": "sequence {sequence}",
      "create.lineagePrevious": "，previous {batchId}",
      "create.lineageSupersedes": "，supersedes {batchId}",
      "create.warnings": "{count} 条警告：{details}",
      "field.directory": "目录",
      "field.evidence": "证据",
      "field.lineage": "血缘",
      "field.title": "标题",
      "field.verifiedAt": "校验于",
      "list.separator": "；",
      "batchlist.untitled": "（无标题）",
      "batchlist.delete": "删除",
      "batchlist.deleteTitle": "删除该批次",
      "delete.title": "删除交接批次",
      "delete.subtitle": "软删除：批次移入回收站，仍可从文件系统恢复。",
      "delete.confirmBody": "将批次 {batchId} 移入回收站？list / verify / load 将不再看到它，但文件仍保留在 .trash/ 下。",
      "delete.projectKeyLabel": "项目 key",
      "delete.recycleBinLabel": "回收站",
      "delete.softOnly": "本界面只做软删除；永久删除仅可通过 CLI（--hard）。",
      "delete.confirm": "移入回收站",
      "delete.busy": "删除中…",
      "delete.success": "批次已移入回收站",
      "prompt.heading": "新会话开场提示词",
      "prompt.trustBadge": "trust={trust}",
      "detail.loading": "正在校验：读包 + 重算哈希与漂移…",
      "detail.empty": "从左侧选择一个批次，查看 trust / drift / findings，并复制开场提示词。",
      "detail.counts": "{errors} 错误 / {warnings} 警告",
      "detail.driftNotChecked": "漂移：未执行漂移检查",
      "detail.driftChanged": "漂移：gitHead {head} · 源文件变化 {changed} · 缺失 {missing}",
      "detail.driftHeadChanged": "已变",
      "detail.driftHeadUnchanged": "未变",
      "detail.driftClean": "漂移：无（gitHead 未变，源文件哈希一致）",
      "detail.findingsTitle": "findings（{count}）",
      "detail.findingsMore": "还有 {count} 条…",
      "detail.warningsTitle": "包内警告（{count}）：",
      "detail.nextSteps": "下一步",
      "load.loadingBatches": "正在读取批次…",
      "load.empty": "还没有批次。先切到「生成」创建第一包交接。",
      "continue.title": "继续交接",
      "continue.subtitle": "写入新批次；旧批次不被修改",
      "continue.appendChoice": "append（承接最新）",
      "continue.updateChoice": "update（标记 supersedes）",
      "continue.updateNote": "新建一代并记录 supersedes 最新批次；旧批次保持原样，不会被改写。需要二次确认。",
      "continue.appendNote": "承接最新批次追加一代（lineage.previous）；旧批次保持原样。",
      "continue.baseBatch": "基准批次",
      "continue.noBatch": "（无可用批次）",
      "continue.writeRoot": "写入根目录",
      "continue.dirNote": "实际批次目录由宿主按项目 key 生成，写入完成后显示；点击前不会写盘。",
      "continue.titleLabel": "标题",
      "continue.titleHint": "可选",
      "continue.titlePlaceholder": "这一代的标题（可选）",
      "continue.summaryLabel": "备注",
      "continue.summaryHint": "可选，写进 H1",
      "continue.includeDiffs": "附带会话改动 diff",
      "continue.written": "已写入新批次",
      "continue.generation": "第 {sequence} 代",
      "continue.viewBatch": "查看该批次",
      "continue.confirmNote": "二次确认：将新建一个 supersedes 批次，旧批次只读保留。",
      "continue.confirmUpdate": "继续交接（update）",
      "continue.confirmWrite": "确认写入（{mode}）",
      "continue.writing": "正在写入…",
      "panel.summaryLoading": "读取中…",
      "panel.project": "项目 {name}",
      "panel.batches": "· {count} 个批次",
      "workbench.backToConversation": "返回对话",
      "workbench.description": "交接包是“新会话开场提示词”的后端证据；写操作（生成 / 继续交接）会先显示目标目录并在点击后执行。",
      "workbench.sessionUnbound": "未绑定",
      "history.badge": "历史项目（只读）",
      "history.notice": "当前项目 {project} 没有批次，只读显示 {keys} 的 {count} 个历史批次；新建批次仍写入当前项目 key。",
      "history.continueDisabled": "查看历史批次时无法继续交接（它们属于其他项目 key）。如需在当前项目建立血缘，请新建批次。",
      "selector.title": "项目 / 会话",
      "selector.hint": "选择本工作台读写的工作区所属会话；项目随会话确定。选「宿主默认」则由宿主解析最新活动会话。",
      "selector.hostDefault": "宿主默认（最新活动会话）",
      "selector.knownEmpty": "尚未记录会话：打开一个对话点一次「交接」，再回到这里。",
      "selector.project": "项目",
      "selector.workspace": "工作区",
      "selector.session": "会话",
      "selector.value": "{label}：{value}",
      "selector.live": "在线",
      "selector.fallbackBadge": "宿主回退",
      "selector.noticeImplicit": "本工作台未显式绑定会话：宿主解析到会话 {id}，读写都使用 {cwd}。请在上方选择一个会话以固定。",
      "selector.noticeFallback": "未绑定活动会话，宿主回退到 {cwd}。请在上方选择会话（或在对话里点一次「交接」）以固定本工作台。",
      "selector.noticeStale": "会话 {pinned} 已不在线；宿主改用了 {resolved}。请在上方选择在线会话或改用宿主默认。",
      "selector.optionWithTitle": "{title} · {id}",
      "selector.optionNoTitle": "{id}"
    }
    const MESSAGES = { en: EN_MESSAGES, zh: ZH_MESSAGES }

    /** Pick `zh` for a `zh*` tag, `en` otherwise; `null` when the tag is empty. */
    function localeFromTag(tag) {
      if (typeof tag !== 'string' || tag === '') return null
      return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /**
     * Resolve the UI language.
     *
     * Priority (P3 follow-up): an explicit saved preference wins, then a `zh*`
     * entry in `navigator.languages` / `navigator.language` (a Chinese browser
     * must show Chinese even when the shell pins `<html lang="en">`), then
     * `document.documentElement.lang`, then English.
     *
     * @param {any} [nav] navigator (injectable for tests)
     * @param {any} [doc] document (injectable for tests)
     * @param {string|null} [stored] persisted `zh` / `en` preference
     */
    function detectLocale(nav, doc, stored) {
      const saved = localeFromTag(stored)
      if (saved !== null) return saved
      try {
        if (nav !== undefined && nav !== null) {
          const tags = []
          if (Array.isArray(nav.languages)) {
            for (const tag of nav.languages) tags.push(tag)
          }
          if (typeof nav.language === 'string') tags.push(nav.language)
          for (const tag of tags) {
            if (typeof tag === 'string' && tag.toLowerCase().startsWith('zh')) return 'zh'
          }
        }
      } catch {
        /* a restricted navigator object must not break the UI */
      }
      try {
        const fromDocument =
          doc !== undefined && doc !== null && doc.documentElement
            ? localeFromTag(doc.documentElement.lang)
            : null
        if (fromDocument !== null) return fromDocument
      } catch {
        /* the same applies to document */
      }
      return 'en'
    }

    /** Explicit saved language preference (`zh` / `en`), or null when unset. */
    function storedLocale() {
      const raw = storageGet(storageRef(), LOCALE_KEY)
      return raw === 'zh' || raw === 'en' ? raw : null
    }

    let currentLocale = detectLocale(
      typeof navigator === 'undefined' ? undefined : navigator,
      typeof document === 'undefined' ? undefined : document,
      storedLocale()
    )

    /**
     * Switch the UI language immediately (no reload) and remember the explicit
     * preference. Every mounted surface re-renders through the shared store.
     * @param {'zh'|'en'|string} next
     */
    function setLocale(next) {
      const target = next === 'zh' ? 'zh' : 'en'
      if (currentLocale !== target) {
        currentLocale = target
        set({ locale: target })
      }
      storageSet(storageRef(), LOCALE_KEY, target)
    }

    /**
     * Render one message in a given locale, filling `{name}` placeholders.
     * Missing keys fall back to the English table, then to the key itself.
     * @param {'en'|'zh'} locale
     * @param {string} key
     * @param {Record<string, unknown>} [vars]
     */
    function formatMessage(locale, key, vars) {
      const table = locale === 'zh' ? ZH_MESSAGES : EN_MESSAGES
      const template = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : EN_MESSAGES[key]
      if (typeof template !== 'string') return key
      if (vars === undefined || vars === null) return template
      return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
        vars[name] === undefined || vars[name] === null ? match : String(vars[name])
      )
    }

    /** Translate a UI key in the current language. */
    function t(key, vars) {
      return formatMessage(currentLocale, key, vars)
    }

    /** Whether the English table defines a key (tests rely on full parity). */
    function hasMessage(key) {
      return Object.prototype.hasOwnProperty.call(EN_MESSAGES, key)
    }

    // ---------------------------------------------------------------- theme
    const T = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      success: 'var(--dsw-alias-state-success-primary)'
    }
    const FONT =
      'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif)'
    const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace'

    // ---------------------------------------------------------------- store
    /** One tiny observable store shared by the four slot components. */
    const store = {
      version: 0,
      open: false,
      tab: 'create',
      locale: currentLocale,
      sessionId: undefined,
      sessionTitle: '',
      inputActions: null,
      state: null,
      stateError: null,
      loading: false,
      target: 'user',
      selectedBatchId: null,
      toast: null,
      // create tab
      createTitle: '',
      createSummary: '',
      createIncludeDiffs: false,
      createBusy: false,
      createResult: null,
      createError: null,
      // opening prompt (copy)
      promptText: '',
      promptBatchId: '',
      promptTrust: '',
      promptError: null,
      copying: false,
      // load tab / detail
      detailBatchId: '',
      detail: null,
      detailLoading: false,
      detailError: null,
      // delete (soft delete into the recycle bin; Host RPC `delete`)
      deleteTarget: null,
      deleteBusy: false,
      deleteError: null,
      // continue (append/update) from the workbench
      continueOpen: false,
      continueMode: 'append',
      continueConfirm: false,
      continueBaseId: '',
      continueIncludeDiffs: false,
      continueTitle: '',
      continueSummary: '',
      continueBusy: false,
      continueError: null,
      continueResult: null
    }
    const listeners = new Set()
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    function getVersion() {
      return store.version
    }
    function set(patch) {
      Object.assign(store, patch)
      store.version += 1
      for (const listener of Array.from(listeners)) listener()
    }
    function useStoreVersion() {
      return React.useSyncExternalStore(subscribe, getVersion)
    }

    // ------------------------------------------------------------ host RPC
    function uiError(code, message, remedy) {
      const error = new Error(message)
      error.code = code
      error.remedy = remedy
      return error
    }

    /**
     * One JSON request to this bundle's Host half.
     * @param {string} method `state` | `detail` | `copy` | `create`
     * @param {Record<string, unknown>} [params]
     */
    async function callHost(method, params) {
      let response
      try {
        response = await fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocol: PROTOCOL, method, params: params ?? {} })
        })
      } catch {
        throw uiError('HANDOFF_UI_UNREACHABLE', t('error.unreachable'), t('error.unreachableRemedy'))
      }
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        throw uiError('HANDOFF_UI_BAD_RESPONSE', t('error.badResponse'), t('error.badResponseRemedy'))
      }
      if (payload !== null && payload.ok === true) return payload.value
      const failure = payload !== null && typeof payload === 'object' ? payload.error : undefined
      throw uiError(
        failure !== undefined && typeof failure.code === 'string' ? failure.code : `HTTP_${response.status}`,
        failure !== undefined && typeof failure.message === 'string' ? failure.message : t('error.hostRequestFailed'),
        failure !== undefined && typeof failure.remedy === 'string' ? failure.remedy : t('error.retryOnce')
      )
    }

    function describeError(error) {
      if (error === null || error === undefined) return { code: '', message: '', remedy: '' }
      return {
        code: typeof error.code === 'string' ? error.code : '',
        message: error instanceof Error ? error.message : String(error),
        remedy: typeof error.remedy === 'string' ? error.remedy : ''
      }
    }

    function showToast(message) {
      set({ toast: message })
      setTimeout(() => {
        if (store.toast === message) set({ toast: null })
      }, 2600)
    }

    function sessionParams() {
      const params = {}
      if (typeof store.sessionId === 'string' && store.sessionId !== '') params.sessionId = store.sessionId
      return params
    }

    // ---------------------------------------- project / session selection (P2-G1)
    /** @returns {Storage|null} the browser store, or null when unavailable. */
    function storageRef() {
      try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
      } catch {
        return null
      }
    }

    /** Read one storage value; private mode / disabled storage must not throw. */
    function storageGet(storage, key) {
      try {
        return storage === null || storage === undefined ? null : storage.getItem(key)
      } catch {
        return null
      }
    }

    function storageSet(storage, key, value) {
      try {
        if (storage !== null && storage !== undefined) storage.setItem(key, value)
      } catch {
        /* storage unavailable: the in-memory pin still applies to this tab */
      }
    }

    function storageRemove(storage, key) {
      try {
        if (storage !== null && storage !== undefined) storage.removeItem(key)
      } catch {
        /* ignore */
      }
    }

    /**
     * Sessions this workbench may bind to, newest first. They are recorded when
     * the composer button opens: the Host exposes no project/session listing
     * method, so the selector must not invent one.
     * @param {Storage|null} [storage]
     * @returns {{id: string, title: string}[]}
     */
    function knownSessions(storage) {
      const resolved = storage === undefined ? storageRef() : storage
      const raw = storageGet(resolved, KNOWN_SESSIONS_KEY)
      if (raw === null || raw === '') return []
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return []
      }
      if (!Array.isArray(parsed)) return []
      const seen = new Set()
      const sessions = []
      for (const entry of parsed) {
        if (entry === null || typeof entry !== 'object') continue
        const id = typeof entry.id === 'string' ? entry.id : ''
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        sessions.push({ id, title: typeof entry.title === 'string' ? entry.title : '' })
        if (sessions.length >= KNOWN_SESSIONS_LIMIT) break
      }
      return sessions
    }

    /** Record a session (moving it to the front) and update the last-session hint. */
    function rememberSession(sessionId, title, storage) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const resolved = storage === undefined ? storageRef() : storage
      const entry = { id: sessionId, title: typeof title === 'string' ? title : '' }
      const others = knownSessions(resolved).filter((candidate) => candidate.id !== sessionId)
      storageSet(resolved, KNOWN_SESSIONS_KEY, JSON.stringify([entry, ...others].slice(0, KNOWN_SESSIONS_LIMIT)))
      storageSet(resolved, SESSION_HINT_KEY, sessionId)
    }

    /**
     * Pure view-model for the project/session bar. `fallback` marks a state the
     * Host resolved implicitly (no live session, or the newest live root
     * session rather than an explicit binding by this page).
     * @param {any} state the `state` RPC value
     */
    function projectSessionView(state) {
      if (state === null || state === undefined || typeof state !== 'object') return null
      const project = state.project !== null && typeof state.project === 'object' ? state.project : {}
      const session = state.session !== null && typeof state.session === 'object' ? state.session : {}
      const sessionId = typeof session.id === 'string' && session.id !== '' ? session.id : ''
      const cwd = typeof session.cwd === 'string' ? session.cwd : ''
      const projectName = typeof project.name === 'string' && project.name !== '' ? project.name : '—'
      const projectKey = typeof project.key === 'string' ? project.key : ''
      const workspace = typeof project.workspace === 'string' && project.workspace !== '' ? project.workspace : cwd
      return {
        projectName,
        projectKey,
        workspace: workspace === '' ? '—' : workspace,
        sessionId,
        cwd,
        live: session.live === true,
        fallback: sessionId === '' || session.live !== true
      }
    }

    /**
     * Candidate rows for the selector: the Host-resolved session and the
     * explicitly pinned one first, then locally recorded sessions.
     * @param {{id: string, title: string}[]} known
     * @param {string} pinnedId
     * @param {string} resolvedId
     */
    function sessionChoices(known, pinnedId, resolvedId) {
      const listed = Array.isArray(known) ? known : []
      const ordered = []
      for (const candidate of [resolvedId, pinnedId]) {
        if (typeof candidate === 'string' && candidate !== '') ordered.push(candidate)
      }
      for (const entry of listed) ordered.push(entry.id)
      const seen = new Set()
      const choices = []
      for (const id of ordered) {
        if (typeof id !== 'string' || id === '' || seen.has(id)) continue
        seen.add(id)
        const match = listed.find((entry) => entry.id === id)
        choices.push({ id, title: match !== undefined && typeof match.title === 'string' ? match.title : '' })
      }
      return choices
    }

    /** Shorten a session id for a compact label without hiding its prefix. */
    function shortSessionId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      return sessionId.length <= 16 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`
    }

    function sessionChoiceLabel(choice) {
      const id = shortSessionId(choice.id)
      const title = typeof choice.title === 'string' && choice.title !== '' ? choice.title : ''
      return title === '' ? t('selector.optionNoTitle', { id }) : t('selector.optionWithTitle', { title, id })
    }

    /**
     * Bind the workbench to a session explicitly (empty id -> Host default).
     * The write to localStorage is only a hint; the Host still resolves the
     * session and reports back what it actually used.
     */
    function bindSession(sessionId) {
      const next = typeof sessionId === 'string' ? sessionId : ''
      const storage = storageRef()
      if (next === '') storageRemove(storage, SESSION_HINT_KEY)
      else storageSet(storage, SESSION_HINT_KEY, next)
      set({ sessionId: next, selectedBatchId: null, detailBatchId: '', detail: null, detailError: null })
      void refreshState({ sessionId: next })
    }

    async function refreshState(options) {
      const sessionId = options !== undefined && 'sessionId' in options ? options.sessionId : store.sessionId
      const target = (options !== undefined && options.target) || store.target || 'user'
      set({ loading: true, stateError: null, target })
      const params = { target }
      if (typeof sessionId === 'string' && sessionId !== '') params.sessionId = sessionId
      try {
        const state = await callHost('state', params)
        set({ state, loading: false })
      } catch (error) {
        set({ loading: false, stateError: error })
      }
    }

    function openPanel() {
      const prefill = store.createTitle !== '' ? store.createTitle : store.sessionTitle
      set({ open: true, createTitle: typeof prefill === 'string' ? prefill : '', createError: null })
      void refreshState({})
    }
    function closePanel() {
      set({ open: false })
    }

    /** Clipboard write; returns false when the browser refuses (no DOM fallback). */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the manual-copy hint */
      }
      return false
    }

    /** Navigate to this bundle's center page through the layout service. */
    let pluginCtx = null
    function selectMainPanel(panelId) {
      try {
        const layout = pluginCtx !== null ? (pluginCtx.layout ?? pluginCtx.get?.('layout')) : undefined
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(panelId)
      } catch {
        /* the shell may not expose layout in a reduced composition */
      }
    }
    function openWorkbench() {
      set({ open: false })
      selectMainPanel(PANEL_ID)
    }

    // ----------------------------------------------------------- actions
    /** Generate one package through the Host service, then optionally copy. */
    async function performCreate(options) {
      if (store.createBusy) return
      const copyAfter = options !== undefined && options.copy === true
      const params = Object.assign({ mode: 'create', target: store.target || 'user' }, sessionParams())
      const title = store.createTitle.trim()
      const summary = store.createSummary.trim()
      if (title !== '') params.title = title
      if (summary !== '') params.summary = summary
      if (store.createIncludeDiffs === true) params.includeDiffs = true
      set({ createBusy: true, createError: null, createResult: null, promptText: '', promptError: null })
      try {
        const result = await callHost('create', params)
        set({ createBusy: false, createResult: result })
        await refreshState({})
        if (copyAfter) await performCopy(result.batchId)
      } catch (error) {
        set({ createBusy: false, createError: error })
      }
    }

    /** Build the new-session opening prompt for a batch. Read-only. */
    async function fetchPromptText(batchId) {
      const params = Object.assign({ target: store.target || 'user' }, sessionParams())
      if (typeof batchId === 'string' && batchId !== '') params.batchId = batchId
      const result = await callHost('copy', params)
      set({
        promptText: result.text,
        promptBatchId: result.batchId,
        promptTrust: result.trust,
        promptError: null
      })
      return result.text
    }

    /** Build the opening prompt for a batch and copy it. Read-only. */
    async function performCopy(batchId) {
      if (store.copying) return
      const explicit = typeof batchId === 'string' && batchId !== '' ? batchId : store.createResult?.batchId
      set({ copying: true, promptError: null })
      try {
        const text = await fetchPromptText(explicit)
        const copied = await copyText(text)
        set({ copying: false })
        showToast(copied ? t('toast.promptCopied') : t('toast.copyManual'))
      } catch (error) {
        set({ copying: false, promptError: error })
      }
    }

    /** Verify one batch and load its bounded detail. Read-only. */
    async function performDetail(batchId) {
      if (typeof batchId !== 'string' || batchId === '') return
      const params = Object.assign({ target: store.target || 'user', batchId }, sessionParams())
      set({ detailBatchId: batchId, detailLoading: true, detailError: null })
      try {
        const detail = await callHost('detail', params)
        set({ detail, detailLoading: false })
      } catch (error) {
        set({ detailLoading: false, detail: null, detailError: error })
      }
    }

    // ------------------------------------------------- delete (soft delete)
    /**
     * Open the delete confirmation for one batch. The dialog is the second
     * confirmation step; nothing is written until the user clicks confirm.
     */
    function requestDelete(batch) {
      if (batch === null || typeof batch !== 'object' || typeof batch.batchId !== 'string' || batch.batchId === '')
        return
      set({ deleteTarget: batch, deleteBusy: false, deleteError: null })
    }

    /** Close the delete confirmation without writing anything. */
    function closeDelete() {
      set({ deleteTarget: null, deleteBusy: false, deleteError: null })
    }

    /**
     * Soft-delete the selected batch through the Host RPC.
     *
     * Only `mode: 'trash'` is reachable here: the Host moves the directory into
     * `<handoffRoot>/.trash/` and it stays recoverable from the filesystem.
     * A lineage-referenced batch is refused by the Host and shown as an error
     * toast (the UI never forces a lineage break).
     */
    async function performDelete() {
      const target = store.deleteTarget
      if (target === null || typeof target !== 'object' || store.deleteBusy) return null
      const batchId = typeof target.batchId === 'string' ? target.batchId : ''
      if (batchId === '') return null
      const params = Object.assign({ target: store.target || 'user', batchId }, sessionParams())
      if (typeof target.projectKey === 'string' && target.projectKey !== '') {
        // Historical (moved-key) batch: the Host validates the key and locates
        // the batch read/write under that exact directory.
        params.projectKey = target.projectKey
      }
      set({ deleteBusy: true, deleteError: null })
      try {
        const result = await callHost('delete', params)
        set({ deleteBusy: false, deleteTarget: null })
        showToast(t('delete.success'))
        if (store.detailBatchId === batchId) set({ detailBatchId: '', detail: null, detailError: null })
        if (store.selectedBatchId === batchId) set({ selectedBatchId: null })
        await refreshState({})
        return result
      } catch (error) {
        set({ deleteBusy: false, deleteError: error })
        const described = describeError(error)
        showToast(described.message || described.code || t('error.hostRequestFailed'))
        return null
      }
    }

    /** Put the opening prompt into the composer draft (no clipboard needed). */
    async function insertPrompt(batchId) {
      try {
        let text = store.promptText
        const reused = store.promptBatchId === batchId && typeof text === 'string' && text !== ''
        if (!reused) text = await fetchPromptText(batchId)
        const actions = store.inputActions
        if (actions === null || actions === undefined || typeof actions.setDraft !== 'function') {
          showToast(t('toast.insertUnavailable'))
          return
        }
        actions.setDraft(text)
        closePanel()
        showToast(t('toast.inserted'))
      } catch (error) {
        set({ promptError: error })
      }
    }

    // ------------------------------------------------- continue (append/update)
    function openContinue(mode) {
      const batches = store.state !== null && Array.isArray(store.state.batches) ? store.state.batches : []
      // A historical (other project key) batch cannot be the lineage base: the
      // write would either fail or imply lineage across project keys, so the
      // action is refused rather than silently re-targeted.
      const history = store.state !== null && store.state !== undefined ? store.state.history : null
      if (history !== null && history !== undefined && history.active === true) {
        showToast(t('history.continueDisabled'))
        return
      }
      set({
        continueOpen: true,
        continueMode: mode === 'update' ? 'update' : 'append',
        continueConfirm: false,
        // Capture the base at open time: after the write, the list's newest
        // batch is the NEW one, so re-deriving the base would mislabel it.
        continueBaseId: batches.length > 0 ? batches[0].batchId : '',
        continueBusy: false,
        continueError: null,
        continueResult: null
      })
    }

    function closeContinue() {
      set({
        continueOpen: false,
        continueConfirm: false,
        continueBusy: false,
        continueError: null,
        continueResult: null
      })
    }

    /**
     * Write the next generation through the existing service. The old batch is
     * never modified: `append` links `previous`, `update` also records
     * `supersedes`, both in a NEW batch directory.
     */
    async function performContinue() {
      if (store.continueBusy) return
      const mode = store.continueMode === 'update' ? 'update' : 'append'
      const params = Object.assign({ mode, target: store.target || 'user' }, sessionParams())
      const baseId = store.continueBaseId
      if (typeof baseId === 'string' && baseId !== '') {
        // Pin the lineage target the dialog showed, so the write matches it even
        // if another batch appeared in between.
        if (mode === 'update') params.supersedes = baseId
        else params.previousBatchId = baseId
      }
      const title = store.continueTitle.trim()
      const summary = store.continueSummary.trim()
      if (title !== '') params.title = title
      if (summary !== '') params.summary = summary
      if (store.continueIncludeDiffs === true) params.includeDiffs = true
      set({ continueBusy: true, continueError: null, continueResult: null, continueConfirm: false })
      try {
        const result = await callHost('create', params)
        set({ continueBusy: false, continueResult: result })
        await refreshState({})
        set({ detailBatchId: result.batchId, selectedBatchId: result.batchId })
        await performDetail(result.batchId)
      } catch (error) {
        set({ continueBusy: false, continueError: error })
      }
    }

    // -------------------------------------------------------- presentations
    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (number) => String(number).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function trustColor(trust) {
      if (trust === 'verified') return T.success
      if (trust === 'invalid') return T.error
      return T.warn
    }

    // -------------------------------------------------------------- atoms
    function Button(props) {
      const [hover, setHover] = React.useState(false)
      const primary = props.primary === true
      const disabled = props.disabled === true
      const base = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        borderRadius: 7,
        border: `1px solid ${primary ? 'transparent' : T.border1}`,
        background: primary
          ? props.danger === true
            ? T.error
            : T.brand
          : hover && !disabled
            ? T.layer2
            : 'transparent',
        color: primary ? '#ffffff' : props.danger === true ? T.error : T.text,
        fontFamily: FONT,
        fontSize: 12.5,
        lineHeight: '1',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap'
      }
      return h(
        'button',
        {
          type: 'button',
          'data-testid': props.testId,
          disabled,
          title: props.title,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: Object.assign(base, props.style ?? {})
        },
        props.children
      )
    }

    function Badge({ text, color }) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: 19,
            padding: '0 7px',
            borderRadius: 10,
            border: `1px solid ${color}`,
            color,
            fontFamily: FONT,
            fontSize: 11,
            lineHeight: '1',
            whiteSpace: 'nowrap'
          }
        },
        text
      )
    }

    /** Localized remedy for a Host `HANDOFF_*` code; '' when the table has none. */
    function localizedRemedy(code) {
      if (typeof code !== 'string' || code === '') return ''
      const key = `remedy.${code}`
      return hasMessage(key) ? t(key) : ''
    }

    function ErrorNotice({ error }) {
      const described = describeError(error)
      if (described.message === '') return null
      // The Host sends a remedy with every failure; older/newer builds may omit
      // one or carry a code this UI does not know, so prefer the localized table
      // and fall back to whatever the Host supplied.
      const remedy = localizedRemedy(described.code) || described.remedy
      return h(
        'div',
        {
          style: {
            border: `1px solid ${T.error}`,
            background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
            borderRadius: 8,
            padding: '9px 11px',
            margin: '10px 0',
            fontFamily: FONT,
            fontSize: 12,
            lineHeight: 1.6,
            color: T.text
          }
        },
        h('div', { style: { fontWeight: 600, color: T.error } }, described.code === '' ? t('error.requestFailed') : described.code),
        h('div', null, described.message),
        remedy === '' ? null : h('div', { style: { color: T.text2 } }, t('error.remedy', { text: remedy }))
      )
    }

    function KeyValue({ label, children, mono }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 10, alignItems: 'baseline', padding: '2px 0', minWidth: 0 } },
        h('span', { style: { flex: '0 0 auto', color: T.text2, fontFamily: FONT, fontSize: 12 } }, label),
        h(
          'span',
          {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflowWrap: 'anywhere',
              fontFamily: mono === true ? MONO : FONT,
              fontSize: 12
            }
          },
          children
        )
      )
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { style: { display: 'block', marginBottom: 10 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 } },
          h('span', { style: { fontFamily: FONT, fontSize: 12, color: T.text } }, label),
          hint === undefined ? null : h('span', { style: { fontFamily: FONT, fontSize: 11, color: T.text2 } }, hint)
        ),
        children
      )
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      background: T.base,
      border: `1px solid ${T.border1}`,
      borderRadius: 7,
      color: T.text,
      fontFamily: FONT,
      fontSize: 12.5,
      lineHeight: 1.55,
      padding: '6px 9px',
      outline: 'none'
    }

    function TextInput(props) {
      return h('input', {
        type: 'text',
        value: props.value,
        placeholder: props.placeholder,
        maxLength: props.maxLength,
        disabled: props.disabled,
        onChange: (event) => props.onChange(event.target.value),
        style: Object.assign({}, inputStyle, { height: 32 })
      })
    }

    function TextArea(props) {
      return h('textarea', {
        value: props.value,
        placeholder: props.placeholder,
        rows: props.rows ?? 3,
        maxLength: props.maxLength,
        onChange: (event) => props.onChange(event.target.value),
        style: Object.assign({}, inputStyle, { resize: 'vertical', minHeight: 58 })
      })
    }

    function Choice(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 11px',
            borderRadius: 14,
            border: `1px solid ${props.active ? T.brand : T.border1}`,
            background: props.active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)' : 'transparent',
            color: props.active ? T.brand : T.text2,
            fontFamily: FONT,
            fontSize: 12,
            cursor: 'pointer'
          }
        },
        props.children
      )
    }

    function Checkbox(props) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontFamily: FONT, fontSize: 12, color: T.text } },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: (event) => props.onChange(event.target.checked),
          style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 14, height: 14, margin: 0 }
        }),
        props.children
      )
    }

    /**
     * In-UI language switch (Chinese / English). The choice is explicit: it
     * beats browser/page detection and is persisted, so a Chinese user can
     * keep the UI Chinese even when the shell serves `<html lang="en">`.
     */
    function LocaleToggle() {
      useStoreVersion()
      const option = (locale) =>
        h(
          'button',
          {
            type: 'button',
            key: locale,
            'data-testid': `handoff-locale-${locale}`,
            'aria-pressed': currentLocale === locale,
            onClick: () => setLocale(locale),
            style: {
              height: 24,
              padding: '0 8px',
              borderRadius: 12,
              border: `1px solid ${currentLocale === locale ? T.brand : T.border1}`,
              background:
                currentLocale === locale
                  ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)'
                  : 'transparent',
              color: currentLocale === locale ? T.brand : T.text2,
              fontFamily: FONT,
              fontSize: 11.5,
              lineHeight: '1',
              cursor: 'pointer',
              whiteSpace: 'nowrap'
            }
          },
          t(locale === 'zh' ? 'locale.zh' : 'locale.en')
        )
      return h(
        'div',
        {
          'data-testid': 'handoff-locale-toggle',
          role: 'group',
          'aria-label': t('locale.label'),
          style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }
        },
        option('zh'),
        option('en')
      )
    }

    // ------------------------------------------------------------- glyph
    function HandoffGlyph({ size, dim }) {
      const edge = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: edge,
          height: edge,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto', opacity: dim === true ? 0.75 : 1 }
        },
        h('rect', { x: 2, y: 3, width: 7.5, height: 10, rx: 1.6 }),
        h('rect', { x: 6.5, y: 3, width: 7.5, height: 10, rx: 1.6 }),
        h('path', { d: 'M4.2 7.4h3.2M6.2 6l1.4 1.4L6.2 8.8' }),
        h('path', { d: 'M11.8 10.2H8.6M9.8 8.8 8.4 10.2l1.4 1.4' })
      )
    }

    // -------------------------------------------------------- composer button
    /**
     * The conversation entry point. Kept to the composer's compact control
     * height; opens the floating panel and remembers this session's context.
     */
    function ComposerButton(props) {
      useStoreVersion()
      const [hover, setHover] = React.useState(false)
      const sessionTitle =
        typeof props.useSessions === 'function'
          ? props.useSessions((snapshot) => {
              if (props.sessionId === undefined) return undefined
              const row = snapshot?.byId?.[props.sessionId]
              return row?.title ?? row?.displayTitle
            })
          : undefined
      const active = store.open
      return h(
        'button',
        {
          type: 'button',
          title: t('app.composerTitle'),
          'aria-label': t('app.title'),
          'aria-expanded': active,
          onClick: () => {
            if (store.open) {
              closePanel()
              return
            }
            if (typeof props.sessionId === 'string' && props.sessionId !== '') {
              // P2-G1: record the session so the workbench selector can bind
              // back to it without a Host-side session-listing method.
              rememberSession(props.sessionId, typeof sessionTitle === 'string' ? sessionTitle : '')
            }
            set({
              sessionId: props.sessionId,
              sessionTitle: typeof sessionTitle === 'string' ? sessionTitle : '',
              inputActions: props.inputActions ?? null
            })
            openPanel()
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 26,
            padding: '0 7px',
            borderRadius: 6,
            border: '1px solid transparent',
            background: active ? T.layer2 : hover ? T.layer1 : 'transparent',
            color: active ? T.text : T.text2,
            fontFamily: FONT,
            fontSize: 12,
            lineHeight: '1',
            cursor: 'pointer',
            flex: '0 0 auto'
          }
        },
        h(HandoffGlyph, { size: 15 }),
        h('span', { style: { whiteSpace: 'nowrap' } }, t('app.title'))
      )
    }

    // -------------------------------------------------------- create tab
    function CreateResult({ result }) {
      useStoreVersion()
      if (result === null || result === undefined) return null
      const warnings = Array.isArray(result.warnings) ? result.warnings : []
      const lineage = result.lineage
      return h(
        'div',
        {
          style: {
            marginTop: 14,
            border: `1px solid ${T.success}`,
            background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)',
            borderRadius: 10,
            padding: '11px 12px'
          }
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('span', { style: { color: T.success, fontFamily: FONT, fontSize: 12.5, fontWeight: 600 } }, t('create.created')),
          h('span', { style: { fontFamily: MONO, fontSize: 12 } }, result.batchId ?? ''),
          h('span', { style: { flex: '1 1 auto' } }),
          h(Badge, {
            text: result.action === 'update' ? 'update' : result.action === 'append' ? 'append' : 'create',
            color: T.brand
          })
        ),
        h(KeyValue, { label: t('field.directory'), mono: true, children: result.displayDir ?? result.dir ?? '—' }),
        h(KeyValue, {
          label: t('field.evidence'),
          children:
            result.totals?.artifactBytes === undefined
              ? t('create.artifacts', { count: Array.isArray(result.artifacts) ? result.artifacts.length : 0 })
              : t('create.artifactsWithBytes', {
                  count: Array.isArray(result.artifacts) ? result.artifacts.length : 0,
                  bytes: formatBytes(result.totals.artifactBytes)
                })
        }),
        lineage === undefined || lineage === null
          ? null
          : h(KeyValue, {
              label: t('field.lineage'),
              children:
                t('create.lineageSequence', { sequence: lineage.sequence }) +
                (lineage.previous === undefined ? '' : t('create.lineagePrevious', { batchId: lineage.previous })) +
                (lineage.supersedes === undefined ? '' : t('create.lineageSupersedes', { batchId: lineage.supersedes }))
            }),
        warnings.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 6, fontFamily: FONT, fontSize: 11.5, color: T.warn } },
              t('create.warnings', {
                count: warnings.length,
                details: warnings
                  .slice(0, 4)
                  .map((warning) => `[${warning.code}] ${warning.detail}`)
                  .join(t('list.separator'))
              })
            ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h(Button, { primary: true, onClick: () => void performCopy(result.batchId), disabled: store.copying }, store.copying ? t('common.buildingPrompt') : t('common.copyOpeningPrompt')),
          h(Button, {
            onClick: async () => {
              const ok = await copyText(String(result.displayDir ?? result.dir ?? ''))
              showToast(ok ? t('toast.directoryCopied') : t('toast.directoryCopyManual'))
            }
          }, t('common.copyDirectory')),
          h(Button, { onClick: openWorkbench }, t('common.openWorkbench'))
        )
      )
    }

    function PromptPreview() {
      useStoreVersion()
      if (store.promptError !== null) return h(ErrorNotice, { error: store.promptError })
      if (store.promptText === '') return null
      return h(
        'div',
        { style: { marginTop: 12 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' } },
          h('span', { style: { fontFamily: FONT, fontSize: 12, color: T.text } }, t('prompt.heading')),
          h(Badge, { text: t('prompt.trustBadge', { trust: store.promptTrust }), color: trustColor(store.promptTrust) }),
          h('span', { style: { fontFamily: MONO, fontSize: 11, color: T.text2 } }, store.promptBatchId),
          h('span', { style: { flex: '1 1 auto' } }),
          h(Button, {
            onClick: async () => {
              const ok = await copyText(store.promptText)
              showToast(ok ? t('toast.copied') : t('toast.copyManual'))
            }
          }, t('common.copyAgain'))
        ),
        h('textarea', {
          readOnly: true,
          value: store.promptText,
          rows: 7,
          style: Object.assign({}, inputStyle, {
            resize: 'vertical',
            minHeight: 120,
            fontFamily: MONO,
            fontSize: 11.5,
            lineHeight: 1.6
          })
        })
      )
    }

    function CreateTab() {
      useStoreVersion()
      const state = store.state
      const roots = state !== null && state.roots !== undefined ? state.roots : null
      const target = store.target || 'user'
      const targetRoot = roots !== null ? roots[target] : null
      const busy = store.createBusy === true
      const manageDisabled = busy || (state === null && store.stateError === null)
      return h(
        'div',
        { style: { padding: '12px 14px 16px' } },
        h(ErrorNotice, { error: store.stateError }),
        h(
          Field,
          { label: t('create.titleLabel'), hint: t('create.titleHint') },
          h(TextInput, {
            value: store.createTitle,
            placeholder: t('create.titlePlaceholder'),
            maxLength: 200,
            disabled: busy,
            onChange: (value) => set({ createTitle: value })
          })
        ),
        h(
          Field,
          { label: t('create.summaryLabel'), hint: t('create.summaryHint') },
          h(TextArea, {
            value: store.createSummary,
            placeholder: t('create.summaryPlaceholder'),
            rows: 3,
            maxLength: 8000,
            onChange: (value) => set({ createSummary: value })
          })
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h('div', { style: { fontFamily: FONT, fontSize: 12, marginBottom: 4 } }, t('create.targetLabel')),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(Choice, { active: target === 'user', onClick: () => set({ target: 'user' }) }, t('create.targetUser')),
            h(Choice, { active: target === 'workspace', onClick: () => set({ target: 'workspace' }) }, t('create.targetWorkspace'))
          ),
          h(
            'div',
            { style: { marginTop: 6, fontFamily: MONO, fontSize: 11.5, color: T.text2, overflowWrap: 'anywhere' } },
            targetRoot === null ? t('create.targetRootLoading') : t('create.writeRoot', { root: targetRoot })
          ),
          h(
            'div',
            { style: { marginTop: 2, fontFamily: FONT, fontSize: 11, color: T.text2 } },
            t('create.dirNote')
          )
        ),
        h(
          'div',
          { style: { marginBottom: 12 } },
          h(
            Checkbox,
            { checked: store.createIncludeDiffs === true, onChange: (value) => set({ createIncludeDiffs: value }) },
            t('create.includeDiffs')
          )
        ),
        store.createError === null ? null : h(ErrorNotice, { error: store.createError }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h(Button, { primary: true, disabled: manageDisabled, onClick: () => void performCreate({ copy: false }) }, busy ? t('create.busy') : t('create.submit')),
          h(Button, { disabled: manageDisabled, onClick: () => void performCreate({ copy: true }) }, t('create.submitAndCopy'))
        ),
        busy
          ? h(
              'div',
              { style: { marginTop: 8, fontFamily: FONT, fontSize: 11.5, color: T.text2 } },
              t('create.busyNote')
            )
          : null,
        h(ErrorNotice, { error: store.promptError }),
        h(CreateResult, { result: store.createResult }),
        h(PromptPreview)
      )
    }

    // -------------------------------------------------------- load tab / detail
    /** Trust + drift + findings + bounded HANDOFF excerpts for one batch. */
    function DetailView({ detail, loading, error }) {
      useStoreVersion()
      if (error !== null && error !== undefined) return h(ErrorNotice, { error })
      if (loading === true && (detail === null || detail === undefined)) {
        return h(
          'div',
          { style: { color: T.text2, fontFamily: FONT, fontSize: 12, padding: '14px 0' } },
          t('detail.loading')
        )
      }
      if (detail === null || detail === undefined) {
        return h(
          'div',
          { style: { color: T.text2, fontFamily: FONT, fontSize: 12, padding: '14px 0', lineHeight: 1.8 } },
          t('detail.empty')
        )
      }
      const verification = detail.verification
      const counts = verification !== null && verification !== undefined ? verification.counts : undefined
      const findings = Array.isArray(verification?.findings) ? verification.findings : []
      const drift = verification?.drift
      const pointers = Array.isArray(detail.pointers) ? detail.pointers : []
      const next = Array.isArray(detail.next) ? detail.next : []
      const warnings = Array.isArray(detail.warnings) ? detail.warnings : []
      const sections = Array.isArray(detail.handoff?.sections) ? detail.handoff.sections : []
      const drifted =
        drift !== undefined &&
        drift !== null &&
        (drift.gitHeadChanged === true || drift.sourceFilesChanged > 0 || drift.sourceFilesMissing > 0)
      const trust = typeof detail.trust === 'string' ? detail.trust : 'stale'
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
          h('span', { style: { fontFamily: MONO, fontSize: 12.5, fontWeight: 600 } }, detail.batchId ?? ''),
          h(Badge, { text: t('prompt.trustBadge', { trust }), color: trustColor(trust) }),
          counts === undefined
            ? null
            : h(Badge, {
                text: t('detail.counts', { errors: counts.errors, warnings: counts.warnings }),
                color: counts.errors > 0 ? T.error : counts.warnings > 0 ? T.warn : T.success
              }),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'button',
            {
              type: 'button',
              onClick: async () => {
                const ok = await copyText(String(detail.displayDir ?? detail.dir ?? ''))
                showToast(ok ? t('toast.directoryCopied') : t('toast.directoryCopyManual'))
              },
              style: {
                border: 'none',
                background: 'transparent',
                color: T.brand,
                fontFamily: FONT,
                fontSize: 11.5,
                cursor: 'pointer',
                padding: 0
              }
            },
            t('common.copyDirectory')
          )
        ),
        h(KeyValue, { label: t('field.directory'), mono: true, children: detail.displayDir ?? detail.dir ?? '—' }),
        detail.manifest?.title === null || detail.manifest?.title === undefined
          ? null
          : h(KeyValue, { label: t('field.title'), children: detail.manifest.title }),
        verification?.checkedAt === undefined
          ? null
          : h(KeyValue, { label: t('field.verifiedAt'), children: formatTime(verification.checkedAt) }),
        h(
          'div',
          {
            style: {
              marginTop: 6,
              fontFamily: FONT,
              fontSize: 11.5,
              color: drifted ? T.warn : T.success
            }
          },
          drift === undefined || drift === null
            ? t('detail.driftNotChecked')
            : drifted
              ? t('detail.driftChanged', {
                  head: drift.gitHeadChanged === true ? t('detail.driftHeadChanged') : t('detail.driftHeadUnchanged'),
                  changed: drift.sourceFilesChanged,
                  missing: drift.sourceFilesMissing
                })
              : t('detail.driftClean')
        ),
        findings.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, border: `1px solid ${T.border1}`, borderRadius: 8, padding: '7px 10px' } },
              h('div', { style: { fontFamily: FONT, fontSize: 11.5, fontWeight: 600, marginBottom: 3 } }, t('detail.findingsTitle', { count: findings.length })),
              findings.slice(0, 12).map((finding, index) =>
                h(
                  'div',
                  {
                    key: `f-${index}`,
                    style: {
                      fontFamily: FONT,
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      color: finding.severity === 'error' ? T.error : T.warn,
                      overflowWrap: 'anywhere'
                    }
                  },
                  `[${finding.severity}] ${finding.code}${finding.path === undefined ? '' : ` · ${finding.path}`}${
                    finding.detail === undefined ? '' : ` — ${finding.detail}`
                  }`
                )
              ),
              findings.length > 12
                ? h('div', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } }, t('detail.findingsMore', { count: findings.length - 12 }))
                : null
            ),
        warnings.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, fontFamily: FONT, fontSize: 11.5, color: T.warn, lineHeight: 1.6 } },
              t('detail.warningsTitle', { count: warnings.length }) +
                warnings
                  .slice(0, 5)
                  .map((warning) => `[${warning.code}] ${warning.detail}`)
                  .join(t('list.separator'))
            ),
        sections.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8 } },
              sections.slice(0, 3).map((section, index) =>
                h(
                  'div',
                  { key: `s-${index}`, style: { marginBottom: 6 } },
                  h('div', { style: { fontFamily: FONT, fontSize: 11.5, fontWeight: 600, color: T.text } }, section.heading ?? section.id),
                  h(
                    'div',
                    {
                      style: {
                        fontFamily: FONT,
                        fontSize: 11.5,
                        lineHeight: 1.65,
                        color: T.text2,
                        whiteSpace: 'pre-wrap',
                        maxHeight: 120,
                        overflowY: 'auto'
                      }
                    },
                    section.text ?? ''
                  )
                )
              )
            ),
        pointers.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, fontFamily: MONO, fontSize: 11, color: T.text2, lineHeight: 1.7, overflowWrap: 'anywhere' } },
              pointers.map((pointer, index) => h('div', { key: `p-${index}` }, `· ${pointer.label}: ${pointer.path}`))
            ),
        next.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, fontFamily: FONT, fontSize: 11.5, color: T.text2, lineHeight: 1.7 } },
              h('div', { style: { color: T.text, fontWeight: 600, marginBottom: 2 } }, t('detail.nextSteps')),
              next.slice(0, 3).map((item, index) => h('div', { key: `n-${index}` }, `· ${item}`))
            ),
        h(ErrorNotice, { error: store.promptError }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h(Button, { primary: true, disabled: store.copying, onClick: () => void performCopy(detail.batchId) }, store.copying ? t('common.buildingPrompt') : t('common.copyOpeningPrompt')),
          h(Button, { onClick: () => void insertPrompt(detail.batchId) }, t('common.insertIntoComposer')),
          h(
            Button,
            {
              onClick: () => {
                set({ selectedBatchId: detail.batchId })
                openWorkbench()
              }
            },
            t('common.openWorkbench')
          )
        )
      )
    }

    /** Group batches by project key (the read-only historical list is grouped). */
    function groupBatchesByProject(batches) {
      const groups = []
      const index = new Map()
      for (const batch of Array.isArray(batches) ? batches : []) {
        if (batch === null || typeof batch !== 'object') continue
        const projectKey = typeof batch.projectKey === 'string' ? batch.projectKey : ''
        if (!index.has(projectKey)) {
          const group = { projectKey, batches: [] }
          index.set(projectKey, group)
          groups.push(group)
        }
        index.get(projectKey).batches.push(batch)
      }
      return groups
    }

    /**
     * Read-only banner shown when the workbench list fell back to historical
     * project keys (remote-seeded project key changed). Writes still target the
     * current project key, which the copy states explicitly.
     */
    function HistoryNotice({ state }) {
      useStoreVersion()
      const history =
        state !== null &&
        state !== undefined &&
        state.history !== null &&
        state.history !== undefined &&
        state.history.active === true
          ? state.history
          : null
      if (history === null) return null
      const projectKeys = Array.isArray(history.projectKeys) ? history.projectKeys : []
      const keys = projectKeys.join(', ')
      const count = Array.isArray(state.batches) ? state.batches.length : 0
      return h(
        'div',
        {
          'data-testid': 'handoff-history-notice',
          style: {
            margin: '0 0 10px',
            padding: '8px 11px',
            border: `1px solid ${T.warn}`,
            borderRadius: 8,
            background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)',
            fontFamily: FONT,
            fontSize: 11.5,
            lineHeight: 1.6,
            color: T.text
          }
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' } },
          h(Badge, { text: t('history.badge'), color: T.warn }),
          h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2, overflowWrap: 'anywhere' } }, keys)
        ),
        h('div', null, t('history.notice', { project: history.currentProjectKey ?? '—', count, keys }))
      )
    }

    /** The batch list shared by the Load tab and the workbench page. */
    function BatchList({ maxHeight }) {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      const historyActive =
        state !== null &&
        state !== undefined &&
        state.history !== null &&
        state.history !== undefined &&
        state.history.active === true
      const groups = historyActive ? groupBatchesByProject(batches) : [{ projectKey: '', batches }]
      const batchRow = (batch) =>
        h(
          'div',
          {
            key: batch.batchId,
            style: {
              display: 'flex',
              alignItems: 'stretch',
              borderLeft: `3px solid ${batch.batchId === store.detailBatchId ? T.brand : 'transparent'}`,
              background: batch.batchId === store.detailBatchId ? T.layer1 : 'transparent'
            }
          },
          h(
            'button',
            {
              type: 'button',
              onClick: () => void performDetail(batch.batchId),
              style: {
                display: 'block',
                flex: '1 1 auto',
                minWidth: 0,
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                padding: '7px 10px',
                cursor: 'pointer'
              }
            },
            h('div', { style: { fontFamily: MONO, fontSize: 11.5, color: T.text } }, batch.batchId),
            h(
              'div',
              {
                style: {
                  fontFamily: FONT,
                  fontSize: 11,
                  color: T.text2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }
              },
              `${batch.title !== null && batch.title !== undefined ? batch.title : t('batchlist.untitled')} · ${formatTime(batch.createdAt)}`
            )
          ),
          h(
            'button',
            {
              type: 'button',
              'data-testid': 'handoff-delete-batch',
              title: t('batchlist.deleteTitle'),
              'aria-label': t('batchlist.deleteTitle'),
              onClick: () => requestDelete(batch),
              style: {
                border: 'none',
                background: 'transparent',
                color: T.error,
                cursor: 'pointer',
                fontFamily: FONT,
                fontSize: 11,
                padding: '0 8px',
                flex: '0 0 auto'
              }
            },
            t('batchlist.delete')
          )
        )
      return h(
        'div',
        {
          style: {
            borderRight: `1px solid ${T.border1}`,
            maxHeight: maxHeight ?? '52vh',
            overflowY: 'auto',
            padding: '6px 0'
          }
        },
        groups.map((group) =>
          h(
            'div',
            { key: `group-${group.projectKey}`, 'data-testid': historyActive ? 'handoff-history-group' : undefined },
            historyActive
              ? h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                      padding: '6px 10px 4px',
                      borderTop: `1px solid ${T.border1}`,
                      background: T.layer2
                    }
                  },
                  h(
                    'span',
                    { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2, overflowWrap: 'anywhere' } },
                    group.projectKey
                  ),
                  h(Badge, { text: t('history.badge'), color: T.warn })
                )
              : null,
            group.batches.map((batch) => batchRow(batch))
          )
        )
      )
    }

    function LoadTab() {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      React.useEffect(() => {
        if (store.tab !== 'load') return
        if (batches.length === 0) return
        if (store.detailBatchId !== '') return
        void performDetail(batches[0].batchId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [store.tab, store.detailBatchId, batches.length])
      if (state === null) {
        return h(
          'div',
          { style: { padding: '16px 14px' } },
          store.stateError !== null
            ? h(ErrorNotice, { error: store.stateError })
            : h('div', { style: { color: T.text2, fontFamily: FONT, fontSize: 12 } }, t('load.loadingBatches'))
        )
      }
      if (batches.length === 0) {
        return h(
          'div',
          { style: { padding: '16px 14px', color: T.text2, fontFamily: FONT, fontSize: 12, lineHeight: 1.8 } },
          t('load.empty')
        )
      }
      return h(
        'div',
        null,
        h('div', { style: { padding: '10px 12px 0' } }, h(HistoryNotice, { state })),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'minmax(200px, 250px) 1fr', minHeight: 280 } },
          h(BatchList, { maxHeight: '52vh' }),
          h(
            'div',
            { style: { padding: '10px 14px 14px', maxHeight: '52vh', overflowY: 'auto' } },
            h(DetailView, { detail: store.detail, loading: store.detailLoading, error: store.detailError })
          )
        )
      )
    }

    // ----------------------------------------------------- continue modal
    function ContinueModal() {
      useStoreVersion()
      if (store.continueOpen !== true) return null
      const mode = store.continueMode === 'update' ? 'update' : 'append'
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      const latest = batches.length > 0 ? batches[0] : null
      const baseId = typeof store.continueBaseId === 'string' && store.continueBaseId !== '' ? store.continueBaseId : latest?.batchId ?? ''
      const target = store.target || 'user'
      const targetRoot = state !== null && state.roots !== undefined ? state.roots[target] : null
      const busy = store.continueBusy === true
      const result = store.continueResult
      const needsUpdateConfirm = mode === 'update' && store.continueConfirm !== true && result === null
      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: `1px solid ${T.border1}`,
            background: T.layer1
          }
        },
        h('span', { style: { color: T.brand, display: 'inline-flex' } }, h(HandoffGlyph, { size: 18 })),
        h('div', { style: { flex: '1 1 auto' } },
          h('div', { style: { fontFamily: FONT, fontSize: 13.5, fontWeight: 600 } }, t('continue.title')),
          h('div', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } }, t('continue.subtitle'))
        ),
        h('button', {
          type: 'button',
          'aria-label': t('common.close'),
          onClick: closeContinue,
          style: { border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 16, lineHeight: '1', padding: 4 }
        }, '×')
      )
      const form = h(
        'div',
        { style: { padding: '12px 14px' } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
          h(Choice, { active: mode === 'append', onClick: () => set({ continueMode: 'append', continueConfirm: false }) }, t('continue.appendChoice')),
          h(Choice, { active: mode === 'update', onClick: () => set({ continueMode: 'update', continueConfirm: false }) }, t('continue.updateChoice'))
        ),
        h(
          'div',
          { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2, lineHeight: 1.7, marginBottom: 8 } },
          mode === 'update' ? t('continue.updateNote') : t('continue.appendNote')
        ),
        h(KeyValue, { label: t('continue.baseBatch'), mono: true, children: baseId === '' ? t('continue.noBatch') : baseId }),
        h(KeyValue, { label: t('continue.writeRoot'), mono: true, children: targetRoot ?? '—' }),
        h(
          'div',
          { style: { fontFamily: FONT, fontSize: 11, color: T.text2, marginBottom: 10 } },
          t('continue.dirNote')
        ),
        h(
          Field,
          { label: t('continue.titleLabel'), hint: t('continue.titleHint') },
          h(TextInput, {
            value: store.continueTitle,
            placeholder: t('continue.titlePlaceholder'),
            maxLength: 200,
            disabled: busy,
            onChange: (value) => set({ continueTitle: value })
          })
        ),
        h(
          Field,
          { label: t('continue.summaryLabel'), hint: t('continue.summaryHint') },
          h(TextArea, {
            value: store.continueSummary,
            rows: 2,
            maxLength: 8000,
            onChange: (value) => set({ continueSummary: value })
          })
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h(
            Checkbox,
            { checked: store.continueIncludeDiffs === true, onChange: (value) => set({ continueIncludeDiffs: value }) },
            t('continue.includeDiffs')
          )
        ),
        h(ErrorNotice, { error: store.continueError }),
        result === null
          ? null
          : h(
              'div',
              {
                style: {
                  border: `1px solid ${T.success}`,
                  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)',
                  borderRadius: 8,
                  padding: '9px 11px',
                  marginBottom: 8
                }
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' } },
                h('span', { style: { color: T.success, fontFamily: FONT, fontSize: 12.5, fontWeight: 600 } }, t('continue.written')),
                h('span', { style: { fontFamily: MONO, fontSize: 12 } }, result.batchId ?? ''),
                result.lineage === undefined || result.lineage === null
                  ? null
                  : h(Badge, {
                      text: t('continue.generation', { sequence: result.lineage.sequence }),
                      color: T.brand
                    })
              ),
              h(KeyValue, { label: t('field.directory'), mono: true, children: result.displayDir ?? result.dir ?? '—' }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 8 } },
                h(Button, {
                  onClick: () => {
                    set({ selectedBatchId: result.batchId, detailBatchId: result.batchId })
                    void performDetail(result.batchId)
                    closeContinue()
                  }
                }, t('continue.viewBatch')),
                h(Button, { onClick: closeContinue }, t('common.close'))
              )
            ),
        needsUpdateConfirm
          ? h(
              'div',
              {
                style: {
                  border: `1px solid ${T.warn}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontFamily: FONT,
                  fontSize: 11.5,
                  color: T.warn,
                  marginTop: 6
                }
              },
              t('continue.confirmNote')
            )
          : null,
        result === null
          ? h(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
              needsUpdateConfirm
                ? h(Button, { onClick: () => set({ continueConfirm: true }) }, t('continue.confirmUpdate'))
                : h(Button, { primary: true, disabled: busy || latest === null, onClick: () => void performContinue() }, busy ? t('continue.writing') : t('continue.confirmWrite', { mode })),
              h(Button, { onClick: closeContinue }, t('common.cancel'))
            )
          : null
      )
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.42)'
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeContinue()
          }
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('continue.title'),
            style: {
              width: 'min(560px, calc(100vw - 40px))',
              maxHeight: 'min(84vh, 720px)',
              display: 'flex',
              flexDirection: 'column',
              background: T.overlay,
              color: T.text,
              border: `1px solid ${T.border2}`,
              borderRadius: 12,
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
              overflow: 'hidden',
              fontFamily: FONT
            }
          },
          header,
          h('div', { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } }, form)
        )
      )
    }

    // ------------------------------------------------------- delete modal
    /**
     * Second confirmation for soft deletion. The dialog states the target batch,
     * project key and recycle bin root, and that the UI never deletes
     * permanently. Host refusals (for example a lineage-referenced batch) stay
     * in the dialog as an error notice and are also toasted.
     */
    function DeleteModal() {
      useStoreVersion()
      const target = store.deleteTarget
      if (target === null || typeof target !== 'object') return null
      const batchId = typeof target.batchId === 'string' ? target.batchId : ''
      const projectKey = typeof target.projectKey === 'string' ? target.projectKey : ''
      const state = store.state
      const targetName = store.target || 'user'
      const targetRoot = state !== null && state.roots !== undefined ? state.roots[targetName] : null
      const recycleBin =
        typeof targetRoot === 'string' && targetRoot !== '' ? `${targetRoot}\\.trash` : '—'
      const busy = store.deleteBusy === true
      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: `1px solid ${T.border1}`,
            background: T.layer1
          }
        },
        h('span', { style: { color: T.error, display: 'inline-flex' } }, h(HandoffGlyph, { size: 18 })),
        h(
          'div',
          { style: { flex: '1 1 auto' } },
          h('div', { style: { fontFamily: FONT, fontSize: 13.5, fontWeight: 600 } }, t('delete.title')),
          h('div', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } }, t('delete.subtitle'))
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': t('common.close'),
            onClick: closeDelete,
            style: { border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 16, lineHeight: '1', padding: 4 }
          },
          '×'
        )
      )
      const body = h(
        'div',
        { style: { padding: '12px 14px' } },
        h(
          'div',
          { style: { fontFamily: FONT, fontSize: 12, color: T.text, lineHeight: 1.7, marginBottom: 10 } },
          t('delete.confirmBody', { batchId })
        ),
        h(KeyValue, { label: t('delete.projectKeyLabel'), mono: true, children: projectKey === '' ? '—' : projectKey }),
        h(KeyValue, { label: t('delete.recycleBinLabel'), mono: true, children: recycleBin }),
        h(
          'div',
          { style: { fontFamily: FONT, fontSize: 11, color: T.text2, lineHeight: 1.6, marginTop: 8 } },
          t('delete.softOnly')
        ),
        h(ErrorNotice, { error: store.deleteError }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
          h(Button, { primary: true, danger: true, disabled: busy, testId: 'handoff-delete-confirm', onClick: () => void performDelete() }, busy ? t('delete.busy') : t('delete.confirm')),
          h(Button, { testId: 'handoff-delete-cancel', onClick: closeDelete }, t('common.cancel'))
        )
      )
      return h(
        'div',
        {
          'data-testid': 'handoff-delete-dialog',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 75,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.42)'
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeDelete()
          }
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('delete.title'),
            style: {
              width: 'min(520px, calc(100vw - 40px))',
              maxHeight: 'min(84vh, 640px)',
              display: 'flex',
              flexDirection: 'column',
              background: T.overlay,
              color: T.text,
              border: `1px solid ${T.border2}`,
              borderRadius: 12,
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
              overflow: 'hidden',
              fontFamily: FONT
            }
          },
          header,
          h('div', { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } }, body)
        )
      )
    }

    // -------------------------------------------------------- floating panel
    function Tabs() {
      useStoreVersion()
      const tab = store.tab
      const item = (id, label) =>
        h(
          'button',
          {
            type: 'button',
            onClick: () => set({ tab: id }),
            style: {
              height: 30,
              padding: '0 12px',
              border: 'none',
              borderBottom: `2px solid ${tab === id ? T.brand : 'transparent'}`,
              background: 'transparent',
              color: tab === id ? T.text : T.text2,
              fontFamily: FONT,
              fontSize: 12.5,
              cursor: 'pointer'
            }
          },
          label
        )
      return h(
        'div',
        { style: { display: 'flex', gap: 2, padding: '0 10px', borderBottom: `1px solid ${T.border1}`, background: T.layer1 } },
        item('create', t('tab.create')),
        item('load', t('tab.load'))
      )
    }

    function PanelSummary() {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches.length : null
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 14px',
            borderBottom: `1px solid ${T.border1}`,
            fontFamily: FONT,
            fontSize: 11.5,
            color: T.text2,
            overflowWrap: 'anywhere'
          }
        },
        h('span', null, state === null ? t('panel.summaryLoading') : t('panel.project', { name: state.project?.name ?? '—' })),
        h('span', null, batches === null ? '' : t('panel.batches', { count: batches })),
        h('span', { style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            type: 'button',
            onClick: () => void refreshState({}),
            disabled: store.loading,
            style: {
              border: 'none',
              background: 'transparent',
              color: store.loading ? T.text2 : T.brand,
              fontFamily: FONT,
              fontSize: 11.5,
              cursor: store.loading ? 'default' : 'pointer',
              padding: 0
            }
          },
          store.loading ? t('common.refreshing') : t('common.refresh')
        )
      )
    }

    function FloatingPanel() {
      useStoreVersion()
      React.useEffect(() => {
        if (!store.open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closePanel()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [store.open])
      if (!store.open) return null
      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: `1px solid ${T.border1}`,
            background: T.layer1
          }
        },
        h('span', { style: { color: T.brand, display: 'inline-flex' } }, h(HandoffGlyph, { size: 18 })),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontFamily: FONT, fontSize: 13.5, fontWeight: 600 } }, t('app.title')),
          h('div', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } }, t('app.subtitle'))
        ),
        h(LocaleToggle),
        h(
          'button',
          {
            type: 'button',
            'aria-label': t('common.close'),
            onClick: closePanel,
            style: { border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 16, lineHeight: '1', padding: 4 }
          },
          '×'
        )
      )
      const footer = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderTop: `1px solid ${T.border1}`,
            background: T.layer1
          }
        },
        h(Button, { onClick: openWorkbench }, t('common.openWorkbench')),
        h('span', { style: { flex: '1 1 auto' } }),
        h(Button, { onClick: closePanel }, t('common.close'))
      )
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.38)'
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closePanel()
          }
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('app.title'),
            style: {
              width: 'min(680px, calc(100vw - 48px))',
              maxHeight: 'min(84vh, 780px)',
              display: 'flex',
              flexDirection: 'column',
              background: T.overlay,
              color: T.text,
              border: `1px solid ${T.border2}`,
              borderRadius: 12,
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
              overflow: 'hidden',
              fontFamily: FONT
            }
          },
          header,
          h(PanelSummary),
          h(Tabs),
          h(
            'div',
            { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } },
            store.tab === 'load' ? h(LoadTab) : h(CreateTab)
          ),
          footer,
          h(DeleteModal)
        )
      )
    }

    // ------------------------------------------------------------- sidebar icon
    function SidebarIcon(props) {
      return h(HandoffGlyph, { size: typeof props?.size === 'number' ? props.size : 16 })
    }

    // ------------------------------------------- project/session bar (P2-G1)
    /**
     * Explicit project/session selector for the workbench.
     *
     * The workbench is a root-scoped page: with no binding of its own the Host
     * resolves the newest live root session, which made "which project am I
     * reading/writing?" ambiguous (P2-G1). This bar shows what the Host
     * actually resolved and lets the user pin a session explicitly — the
     * project is the session's workspace. Candidate rows are client-local by
     * design: the Host exposes no session/project listing method, and the UI
     * does not invent one; the selection reuses the existing `sessionId` RPC
     * parameter.
     */
    function ProjectSessionBar({ state }) {
      useStoreVersion()
      const pinned = typeof store.sessionId === 'string' ? store.sessionId : ''
      const view = projectSessionView(state)
      const choices = sessionChoices(knownSessions(), pinned, view !== null ? view.sessionId : '')
      const cwd = view === null || view.cwd === '' ? '—' : view.cwd
      const notice =
        view === null
          ? null
          : pinned !== '' && view.sessionId !== '' && view.sessionId !== pinned
            ? t('selector.noticeStale', { pinned: shortSessionId(pinned), resolved: shortSessionId(view.sessionId) })
            : view.fallback
              ? t('selector.noticeFallback', { cwd })
              : pinned === '' && store.loading !== true
                ? t('selector.noticeImplicit', { id: shortSessionId(view.sessionId), cwd })
                : null
      return h(
        'div',
        {
          'data-testid': 'handoff-project-session',
          style: {
            margin: '8px 0 12px',
            padding: '9px 12px',
            border: `1px solid ${T.border1}`,
            borderRadius: 10,
            background: T.layer1,
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            fontFamily: FONT,
            fontSize: 11.5,
            color: T.text2
          }
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, color: T.text } }, t('selector.title')),
          h(
            'select',
            {
              'data-testid': 'handoff-session-select',
              value: pinned,
              disabled: store.loading,
              onChange: (event) => bindSession(event.target.value),
              style: {
                height: 27,
                maxWidth: 360,
                padding: '0 7px',
                borderRadius: 7,
                border: `1px solid ${T.border1}`,
                background: T.base,
                color: T.text,
                fontFamily: FONT,
                fontSize: 12,
                outline: 'none'
              }
            },
            h('option', { value: '' }, t('selector.hostDefault')),
            choices.map((choice) => h('option', { key: choice.id, value: choice.id }, sessionChoiceLabel(choice)))
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          view === null
            ? null
            : h(Badge, {
                text: view.fallback ? t('selector.fallbackBadge') : t('selector.live'),
                color: view.fallback ? T.warn : T.success
              }),
          h(LocaleToggle)
        ),
        h('span', null, t('selector.hint')),
        view === null
          ? h('span', null, store.stateError === null ? t('panel.summaryLoading') : '')
          : h(
              'div',
              { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h(
                'span',
                null,
                t('selector.value', {
                  label: t('selector.project'),
                  value: view.projectKey === '' ? view.projectName : `${view.projectName} (${view.projectKey})`
                })
              ),
              h('span', null, t('selector.value', { label: t('selector.workspace'), value: view.workspace })),
              h(
                'span',
                null,
                t('selector.value', {
                  label: t('selector.session'),
                  value: view.sessionId === '' ? t('workbench.sessionUnbound') : shortSessionId(view.sessionId)
                })
              )
            ),
        notice === null ? null : h('span', { style: { color: T.warn, lineHeight: 1.6 } }, notice),
        view === null || choices.length > 0 ? null : h('span', null, t('selector.knownEmpty'))
      )
    }

    // ---------------------------------------------------------- workbench page
    function WorkbenchPage(props) {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      React.useEffect(() => {
        // P2-G1 binding priority: this tab's explicit pin, then the slot's
        // current session, then the hint recorded by the composer button.
        // Nothing is invented: an empty id simply asks the Host to resolve.
        let sessionId = typeof store.sessionId === 'string' ? store.sessionId : ''
        const slotSessionId =
          props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : ''
        const slotTitle =
          props !== null && props !== undefined && typeof props.sessionTitle === 'string' ? props.sessionTitle : ''
        if (sessionId === '') sessionId = slotSessionId
        if (sessionId === '') {
          const stored = storageGet(storageRef(), SESSION_HINT_KEY)
          if (typeof stored === 'string') sessionId = stored
        }
        if (sessionId !== '') {
          if (store.sessionId !== sessionId) set({ sessionId })
          rememberSession(sessionId, slotTitle !== '' ? slotTitle : store.sessionTitle)
        }
        if (store.state === null && !store.loading) void refreshState({ sessionId })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      React.useEffect(() => {
        if (batches.length === 0) return
        if (store.detailBatchId !== '') return
        const first =
          store.selectedBatchId !== null && batches.some((batch) => batch.batchId === store.selectedBatchId)
            ? store.selectedBatchId
            : batches[0].batchId
        set({ selectedBatchId: first })
        void performDetail(first)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state, store.selectedBatchId])
      const refreshAll = () => {
        void refreshState({}).then(() => {
          if (store.detailBatchId !== '') void performDetail(store.detailBatchId)
        })
      }
      const historyActive =
        state !== null &&
        state !== undefined &&
        state.history !== null &&
        state.history !== undefined &&
        state.history.active === true
      return h(
        'div',
        {
          style: {
            height: '100%',
            minHeight: 0,
            overflowY: 'auto',
            background: T.base,
            color: T.text,
            fontFamily: FONT
          }
        },
        h(
          'div',
          { style: { maxWidth: 1180, margin: '0 auto', padding: '22px 26px 40px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' } },
            h('span', { style: { color: T.brand, display: 'inline-flex' } }, h(HandoffGlyph, { size: 22 })),
            h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 650 } }, t('app.workbenchTitle')),
            h('span', { style: { flex: '1 1 auto' } }),
            h(Button, { onClick: refreshAll, disabled: store.loading }, store.loading ? t('common.refreshing') : t('common.refresh')),
            h(Button, {
              onClick: () => {
                if (store.detailBatchId !== '') void performDetail(store.detailBatchId)
              },
              disabled: store.detailLoading || store.detailBatchId === ''
            }, store.detailLoading ? t('common.verifying') : t('common.verify')),
            h(Button, {
              primary: true,
              onClick: () => {
                set({ tab: 'create' })
                openPanel()
              }
            }, t('tab.create')),
            h(Button, { testId: 'handoff-continue', onClick: () => openContinue('append'), disabled: historyActive, title: historyActive ? t('history.continueDisabled') : undefined }, t('continue.title')),
            h(Button, { onClick: () => selectMainPanel('conversation') }, t('workbench.backToConversation'))
          ),
          h(ProjectSessionBar, { state }),
          h(HistoryNotice, { state }),
          h(
            'p',
            { style: { margin: '2px 0 14px', color: T.text2, fontSize: 12.5, lineHeight: 1.7 } },
            t('workbench.description')
          ),
          h(
            'div',
            {
              style: {
                border: `1px solid ${T.border1}`,
                borderRadius: 12,
                background: T.layer1,
                overflow: 'hidden',
                display: 'grid',
                gridTemplateColumns: 'minmax(220px, 280px) 1fr',
                minHeight: 360
              }
            },
            h(BatchList, { maxHeight: 'calc(100vh - 300px)' }),
            h(
              'div',
              { style: { padding: '12px 18px 18px', overflowY: 'auto', maxHeight: 'calc(100vh - 300px)' } },
              h(DetailView, { detail: store.detail, loading: store.detailLoading, error: store.detailError })
            )
          ),
          h(ContinueModal),
          h(DeleteModal)
        )
      )
    }

    // ---------------------------------------------------------------- plugin
    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        const slots = ctx.slots ?? ctx.get?.('slots')
        if (slots === undefined || slots === null) return () => {}
        if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') return () => {}
        // `inject` fires when the owning shell entry declares the seat: load order
        // between this bundle and the shell plugins does not matter, and a shell
        // that cannot serve the seat leaves the surface simply absent.
        const disposers = [
          // Conversation entry: a compact control at the left of the tool row.
          slots.inject('conversation.input.left', () =>
            slots.register(
              { name: 'conversation.input.left', id: BUTTON_ID, order: BUTTON_ORDER, label: () => t('app.title') },
              ComposerButton
            )
          ),
          // Frame-wide floating layer: the panel itself.
          slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: `${PANEL_ID}.panel`, order: 100 }, FloatingPanel)
          ),
          // Sidebar row + center page share one key.
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => t('app.title') }, SidebarIcon)
          ),
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, WorkbenchPage))
        ]
        return () => {
          pluginCtx = null
          for (const dispose of disposers) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* the slot owner may already be torn down */
            }
          }
        }
      },
      /**
       * Internal surface for the browser-less unit tests (no production code
       * reads it): pure i18n/session helpers plus the shared store, so the
       * language switch and the P2-G1 selector can be tested without React.
       */
      _test: {
        messages: MESSAGES,
        locale: () => currentLocale,
        localeKey: LOCALE_KEY,
        detectLocale,
        setLocale,
        formatMessage,
        t,
        projectSessionView,
        sessionChoices,
        sessionChoiceLabel,
        knownSessions,
        rememberSession,
        shortSessionId,
        bindSession,
        groupBatchesByProject,
        requestDelete,
        closeDelete,
        performDelete,
        store
      }
    }
  }
})
