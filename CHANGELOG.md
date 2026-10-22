# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本按 [ROADMAP](ROADMAP.md) 阶段映射（P0 = 0.1.x）。

## [Unreleased]

### Added

- 仓库初始化：插件仓库与业务仓库（stand）分离。
- `ROADMAP.md`（P0–P3 单一权威路线）、`docs/adr/` 决策记录。
- 迁入 3 份 handoff-kit 历史设计文档；新增 `P0_implementation_plan.md`（现行权威）。
- `docs/handoff-kit/START_PROMPT.md`：新会话实施 P0 的启动提示词。
- `docs/handoff-kit/design/P1_plan.md`：P1（0.2.x）实施计划（2026-10-22 已评审通过；
  M1 消费闭环 / M2 workspaceChanges+血缘 / M3 仅接口与文档；Q1–Q5 决议见文档 §10）。
  不改变已发布 0.1.0 行为。

## [0.1.0] - 2026-10-22

P0「手动生成 + 校验闭环」完成。验收证据见
[docs/handoff-kit/acceptance/P0.md](docs/handoff-kit/acceptance/P0.md)。

### Added

- `dsh-handoff-kit` host-only bundle（`plugins/dsh-handoff-kit/`，零运行时依赖、无 UI/Client 半区）：
  - `handoff_pack` 工具：`scan` / `create` / `verify` / `list`（raw JSON Schema + 参数自校验）；
  - `/handoff` 人类命令（默认 create，支持 `--target/--title/--batch/--force/--all/--copy-files`）；
  - `handoff-pack` bundled 技能（rank 600、source bundled、目录 resourceBase）；
  - 默认用户级输出 `$DSH_HOME/handoff/<project-key>/<batch-id>/`，显式 `target=workspace` 降级；
    无 auto 静默回退，权限拒绝返回结构化错误与两条修法。
- 确定性数据契约：`HANDOFF.md`（H0–H9 + 覆盖说明）、`manifest.json`（schemaVersion 1，最后写入）、
  `SHA256SUMS`（覆盖 HANDOFF.md + evidence/*）、`evidence/{git,files,session,redactions}.json`、
  可选 `evidence/files/`（copyFiles，≤20 文件 / 256 KiB / 2 MiB，复制前脱敏）。
- 证据来源：`.git` 解析（HEAD/loose refs/packed-refs/reflog/config/index，无 git status、无子进程）+
  文件 sha256 + 当前会话 `tool/call` 元数据（路径/命令计数，脱敏+截断，不含消息正文）。
- 脱敏：7 类规则（env/generic assignment、bearer、cloud-key、private-key-block、url-credentials、
  conn-string-password）+ 文件级 denylist + 写盘前终检（命中即整批不写）。
- 测试与文档：14 个测试文件 179 个 `node:test` 用例；`docs/handoff-kit/design/P0_module_interfaces.md`
  模块接口规格；`docs/handoff-kit/acceptance/P0.md` 验收记录。

### Changed

- `generic-assignment` 脱敏规则收紧：裸 `key`/`keys`、点分命名空间 `project.key`、普通 prose
  （如 `target=user …`、`project-key = basename(...)`）不再误报；`env-assignment` 仅匹配大写环境变量名。
  复合密钥名（`api_key`/`privateKey`/…）与真实密钥仍命中。
- `handoff-pack` 技能补充消费提示：Windows/PowerShell 读取 `manifest.json` / `HANDOFF.md` 时需显式 UTF-8
  （`[System.IO.File]::ReadAllText(..., UTF8)` 或 `Get-Content -Encoding utf8`），避免默认 ANSI 解码导致
  中文乱码与 JSON 解析失败（新会话消费实测踩坑，技能 provider 逐次读文件，修改即时生效）。

### Fixed

- 修复验收中发现的调用方文本误脱敏（HANDOFF concepts 被占位符替换）；
- 修复 verify 把 `SHA256SUMS` 自身误判为「应从 SHA256SUMS 覆盖」的问题；
- 修复 verify `SOURCE_FILE_*` 对未哈希/已跳过证据文件的误报；
- 修复 `manifest.json` 未记录 `target` 导致 H0 无法如实声明输出目标的问题。

### Known limitations（P0 如实声明）

- 无 `git status`（P0 禁子进程）、无 mtime（fs 无此 API）、无删除原语（失败留下不完整批次）；
- linked bundle 改 JavaScript 需重启 Desktop 或 `remove_bundle` + `install_bundle` 重装；
- `read-only` / `workspace-write` 真实权限链路未实测（fake 策略单测覆盖，见验收缺口 G5）；
- `/handoff` 命令的 Web UI 键入未驱动验证（注册有单测，见验收缺口 G8）；
- 错误码以 message 前缀 + `error.code` 暴露（注册表只对内置 `HarnessError` 保留结构化 info）。
