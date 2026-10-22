# dsh-plugins

<!-- docs-meta: status=current; phase=cross; verified=c275312@2026-10-22; tracks=-; supersedes=-; superseded-by=- -->

DeepSeek Harness（DSH）插件独立仓库。与业务项目（如 `D:\repos\stand`）物理分离：
**插件源码、设计文档、路线图、验收记录全部集中在这里**，业务仓库不再承载插件文件。

## 仓库约定

- 每个插件一个目录：`plugins/<包名>/`；一个 DSH bundle 是一个独立 npm 包
  （`package.json` + `cordis.patch.yml` + `index.js`）。
- 文档：唯一入口 [`docs/README.md`](docs/README.md)（索引 + 状态）；设计/验收在
  `docs/<插件简称>/{design,acceptance}/`；跨插件决策写 `docs/adr/`；历史材料归档到 `docs/archive/`。
- 路线：`ROADMAP.md` 是阶段与状态的**唯一权威**；版本变更记 `CHANGELOG.md`。
- 文档治理：四类文档 + 冻结归档 + `node scripts/docs-check.mjs` 漂移检查
  （见 [ADR-0002](docs/adr/0002-document-governance.md)）。
- 本地 git 提交，**不自动 push**（沿用 stand 仓库既有约定）。

## 插件清单

| 插件 | 阶段 | 版本 | 说明 |
|---|---|---|---|
| `dsh-handoff-kit` | P0–P1 done | 0.2.1 | 会话交接包生成器（HANDOFF.md + manifest@2 + 证据 + 批次血缘），host-only，无 UI；P2 计划对接提示词/UI 工作台 |

## 开发会话约定

DSH 的文件沙箱边界 = **会话工作区**。因此：

- 开发本仓库插件：新开一个 **工作区 = `D:\repos\dsh-plugins`** 的 DSH 会话；
- 业务仓库（stand）的会话只做业务，不写插件代码；
- 插件安装使用绝对目录链接（与工作区无关）：

```
plugin_manager install_bundle  target: D:\repos\dsh-plugins\plugins\dsh-handoff-kit
```

新会话入口：先读 [`ROADMAP.md`](ROADMAP.md) → [`docs/README.md`](docs/README.md)（唯一索引）
→ 当前阶段计划；P0 启动词已归档到 `docs/archive/handoff-kit/START_PROMPT.md`，新阶段启动词由 D4 生成。

## 目录

```
dsh-plugins/
├── README.md / ROADMAP.md / CHANGELOG.md
├── scripts/
│   └── docs-check.mjs           # 文档漂移检查（node scripts/docs-check.mjs）
├── docs/
│   ├── README.md                # 唯一文档索引（入口）
│   ├── WORKSTREAMS.md           # 三线任务协调
│   ├── DOC_CHECKS.md            # docs:check 规格
│   ├── adr/                     # 决策记录（只增不改）
│   ├── archive/                 # 历史材料（只读，不参与现行判断）
│   └── handoff-kit/
│       ├── design/              # P0/P1 基线计划（冻结）
│       ├── acceptance/          # 每阶段验收记录（冻结）
│       └── GAPS.md              # 挂账与边界台账（追加式）
└── plugins/
    └── dsh-handoff-kit/
```
