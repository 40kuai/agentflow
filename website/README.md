# AgentFlow 项目官网

AgentFlow（多 Agent 开发流程编排平台）的对外第一阅读入口：**单页中文静态落地页**。

## 怎么打开

无需安装、无需构建、无需联网。任选其一：

```bash
# 方式一：直接打开文件
open website/index.html

# 方式二：起一个本地静态服务器（可选，便于验证相对路径）
python3 -m http.server 8080 --directory website
# 然后访问 http://127.0.0.1:8080
```

## 交付约束（与需求逐条对应）

| 约束 | 落地方式 |
| --- | --- |
| 纯静态、零依赖、零构建 | 只有 `index.html` + `assets/style.css` + `assets/app.js`（原生 JS） |
| 不使用 npm 依赖与 CDN 资源 | 无 `<script src="http...">`、无外链字体、无构建产物 |
| 断网可直接打开 | 所有资源为相对路径的本地文件 |
| 不污染其他文件 | 本次交付只新增 `website/` 目录，未修改仓库任何既有文件 |
| 内容 100% 可溯源 | 事实均取自 `docs/` 下设计文档与实现计划、`记录.md` |
| 如实标注进度 | Phase 0/1 标「已完成」，Phase 2+ 标「规划中」；Phase 1 的实现边界单列说明 |

## 页面结构

Hero（项目定位）→ 真实痛点（6 条）→ 三条决定性设计原则 → 核心机制（事件存储唯一真相 /
结构化产物零自由对话 / 工作包并行 / G0–G3 卡点 / 三档 profile / 可观测）→ 架构分层
（观测前端 / 编排内核 / Runner / 存储）→ 角色组织（12 角色 + 交叉引擎评审）→ 技术栈 →
Phase 0–5 路线图 → 快速开始 → 页脚（内容溯源）。

## 目录

```
website/
├── index.html          # 单页全部内容
├── assets/
│   ├── style.css       # 全部样式（含响应式与打印样式）
│   └── app.js          # 仅导航高亮（渐进增强，禁用后页面依旧完整）
└── README.md
```

## 与仓库其他部分的关系

- 本目录是**对外介绍入口**，不替代 `docs/` 文档站，也不是观测面板（那是 `web/` 的职责）。
- 站点内容随架构演进需要人工同步；事实性数字（角色数、Phase 进度、环境变量）请以
  `docs/superpowers/specs/2026-09-18-multi-agent-dev-orchestration-design.md`
  与 `docs/superpowers/plans/2026-09-18-agentflow-phase0-phase1.md` 为准。
