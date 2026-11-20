# 前端参考地图 · 给接手/参考本前端的 Agent

> 用途：另一个 Agent 要参考这套前端的**设计语言 + 代码结构**时，先读本文件，
> 再按下面的精确行号只取需要的片段，不要通读 `index.html` 全文（4692 行 / 380KB，
> 且内嵌一段 base64 字体，整份读会淹没有效信息）。
>
> 文件路径：`<项目根>/wanjie/index.html`（单文件、零外部依赖、可离线双击）

---

## 0. 一句话定位这套前端是什么

单文件 HTML，`<style>` 在第 7–1310 行，DOM 在 1314–1562 行，`<script>` 在 1627–4690 行。
四层结构：**顶栏 + 左侧栏 + 主视图区（4 个可切视图）+ 底部常驻对话框**。
主视图是"神经元网络"（原生 SVG/Canvas 绘制，非第三方库），窄屏降级为竖排列表。
设计语言 = **观测台风格**：近黑底 + 黄铜/低饱和点缀 + 克制动效 + 等宽数字 + "去 AI 味"。

---

## 1. 设计语言（想风格一致，只读这些）

### 1.1 三套主题的设计 token —— 第 11–52 行
两个 `:root`：第 11 行是默认 `dark`（近黑 + 黄铜），第 31 行 `notion`（白底蓝）、第 42 行 `health`（米黄 + 橙）。
关键变量分组：
- 颜色：`--bg/--panel/--panel2/--line/--txt/--dim/--accent/--accent-soft`
- 层级色：`--c0..--c5/--cm`（事实/自我/组织/判断/算法/审计/旁挂）
- 图谱画布：`--map-bg/--map-axon/--map-grid/--map-corner`
- **统一字阶 6 档**：`--fs-1:10 / --fs-2:11.5 / --fs-3:13 / --fs-4:15 / --fs-5:22 / --fs-6:44`（第 24 行）
- 间距：`--sp-1..--sp-5`（4/8/12/16/22px，第 27 行）；缓动 `--ease`（第 28 行）

> **风格精髓**：主题只换变量值，不动结构；图谱恒为深空画布。新项目要换肤，只改 `:root` 变量即可。

### 1.2 "去 AI 味"的第二层 token —— 第 1015–1044 行
第二个 `:root` 定义交互曲线（`--ease-enter/-interact/-exit/-spring`）、节奏（进入慢退出快）、
焦点环（`--ui-focus` 2px+2px）、控件三档高度（28/38/48）、单点 radius、克制双层阴影。
配套：`:focus-visible` 才显示焦点环（1036 行）、禁用态去 hover/动效（1042 行）。

### 1.3 关键组件样式锚点（按需取）
| 组件 | 行号 | 说明 |
|---|---|---|
| 顶栏 `.topbar` / 品牌核 | 63–71 | 品牌用不规则胞体 `border-radius:46% 54%...` |
| 主/侧栏布局 `.layout/.main/.sidebar` | 89–130 | `.main` 可滚，`body.map-view` 时改底部留白 |
| 对话框 `.dock/.dock-card/.dock-row` | 357–410 | 悬浮卡片，去盒化后透明底 |
| 空态引导 `.empty-guide/.eg-card` | 1142–1187 | 左下对齐、方角、磨砂铭牌 |
| 磨砂铭牌（徽标/图例） | 531–539 / 1263 | 近实底 94% + blur + 细边，压住背后节点 |
| 神经标签 `.n-label` | 1199–1212 | 去牌匾，只留文字 + 一道垂线 |
| 发送键 `.dock-send` | 1188–1197 | 方角、有输入才反白点亮（`:has`） |
| 抽屉 `.drawer` | 762 起 | 470px，eyebrow/h2/d-sub 分层排版 |
| 主题切换修复等杂项 | 970–1013 | 字号收敛、刻度块化 |

### 1.4 三条硬性的"别踩"约定
1. **不引 UI 动效库**（shadcn/Aceternity 等要 React+构建链，且效果堆砌更模板化）。质感靠：克制配色、不规则形态、噪点、真实物理交互、等宽数字、清晰字阶。
2. **图谱恒深空**：三主题只改外壳，`--map-*` 在浅色主题下仍给深空或浅色径向渐变，但神经元语言不变。
3. **焦点环只在 `:focus-visible`**：鼠标点不闪环——这是"真人 vs 模板"的分水岭。

---

## 2. 代码结构（想复用骨架，按此索引）

### 2.1 DOM 骨架 —— 第 1314–1562 行
```
.topbar (1314)        顶栏：品牌 + 4 视图 tab + 右侧小图标
.layout (1329)
  .sidebar (1330)     可收缩侧栏（默认收起，☰ 展开）
  main.main (1331)
    #view-map (1334)  主视图·神经元图谱（含 map-shell/canvas/HUD/引导卡）
    #view-board(1409) 审计看板（KPI + 缺口 + 到期队列）
    #view-files(1424) 档案/全文检索
    #view-settings(1438) 设置（含模型中心）
    .drawer (1559)    详情抽屉（点节点/记录弹出）
.dock (1564)          底部常驻对话框（会话条 + 消息流 + 输入行 + 模型下拉）
```
四个视图都是 `<section class="view">`，靠 `setView()`（4145 行）切 `.on` 类。

### 2.2 JS 模块地图（顶层函数按职责分段，行号为起点）
| 职责 | 关键函数 / 行号 |
|---|---|
| 数据层与迁移 | `KEY/seed/normalizeDB/load/save` 1709–1926 |
| 存储适配器 | `STORE`（同源探测/本地降级）1819；备份/回滚 1866–1901；配额 1892–1901 |
| 记录主键/证据链 | `recKey/findRecord/evOf/evLabel` 1927–1949 |
| **硬规则校验** | `validate()` **1981–2033**（核心，见 §3） |
| 统计/健康度 | `dueList/daysLate/brierStats/healthStats` 2041–2098 |
| 提示词组装 | `buildPrompt` 2099；`buildContext` 2315（注入工作记忆+档案召回） |
| **草稿→落盘协议** | `normalizeDraft` 2124；`draft()` **4006**；`commit()` **4054** |
| Agent 对话 | `classifyIntent` 2359；`localAgent` 2537；`localChat` 2381 |
| **读路径（召回）** | `archiveRecall` 2224（中文 bigram）；`semanticRecall` 2266；`fuseRecall` 2305 |
| 会话/记忆 | `sessions/memoryBlockText/maybeCompact` 2217/2338；会话面板 2420–2470 |
| 侧栏/图谱渲染 | `renderSidebar` 2767；`NEURO/DEFAULT_POS` 2808/2819；`renderMap` 2945 |
| 神经元卡片/拖动 | `renderNeuroCard` 2994；`initNodeDrag` 3201；坐标持久化 2828–2846 |
| 轴突与光点动画 | `AXONS/buildAxons/pulseFrame` 3071–3182 |
| 提醒/体检 | `systemAlerts` 3309；`auditTodo` 3397；`cognitiveCheckup` 3430 |
| 看板/检索/设置 | `renderBoard` 3549；`searchRecords/renderSearch` 3635/3670；模型中心 `MC` 3713–3925 |
| 统一渲染入口 | `renderAll()` **3982**；`setView` 4145；主题 4141 |

### 2.3 数据模型 —— `seed()` 第 1710–1744 行
`DB` 结构：`meta` + 13 个模块数组（`L0/L1/VERIFY/L2O/L2W/D/POOL/L3A/L3B/L4A/L4B/C/L5`）
+ `sessions[]`/`memory`/`activeSession` + `settings` + `health`。
每条记录用 `ev:[{m,k}]` 挂证据链（k = 源记录主键），`normalizeDraft` 只认真实存在的引用。
`INBOX` 不上图谱，是收件箱前哨。

### 2.4 支撑文件（后端/部署，参考时别漏）
- `ai-proxy.js`：零依赖 Node，静态托管 + 多模型网关 + `/data` 原子写；`test/run-tests.js`：143 项测试。
- `Dockerfile` / `docker-compose.yml`：本地 Docker 部署，数据挂 `./data` 卷。
- 数据方案：服务端 `data/db.json` 持久化（localStorage 降级）；密钥只在服务端环境变量，绝不进前端。

---

## 3. 不可破的硬规则（改前端时别把这些写没了）

来源：`validate()` 第 1981–2033 行 + `PLAN.md` / `README.md`。规则是这套系统的灵魂，前端交互必须服务于它：

1. **AI 只起草 → 规则校验 → 用户点头 → 才落盘**（架构铁律）。`draft()` 生成草稿、`commit()` 才写入；低风险可批勾、高风险逐条精审，但仍需用户确认。
2. L0 原因 ≤12 字且含「然后/后来/接着」判给 D 日记；L3-b 押注必须三样齐（到期日/那个数在哪/具名反方）。
3. L2-W 外部事实必带来源；L3-a 复盘必有「假设 + 验收标准」；L4 同类 ≥3 条才允许提炼。
4. C 共识（结论档）需 2 个出处 + 冷却 7 天 + 确认日，L→C 单向；残片档不可当依据。
5. 超期 14 天标红但不删除；外部验收人必须具名真人（不能是 AI 或自己）。
6. 固定 13 模块 + 证据链，用户和 AI 都不能增删模块。

---

## 4. 给接手 Agent 的读法建议

- **要风格一致**：读 §1（尤其 1.1/1.2 token）+ `docs/*.png` 截图，抄变量和组件范式，别抄 4600 行逻辑。
- **要结构照搬**：读 §2 的 DOM 骨架 + JS 模块地图，按行号跳读，重点 `validate / draft / commit / buildContext / renderMap`。
- **要接入同一后端**：读 §2.4 + `ai-proxy.js` + `README.md`，注意密钥只在服务端。
- **改任何写入逻辑前**：先读 §3 全节，别把硬规则写没了——这是回归测试（143 项）重点守的东西。
- **验证方式**：`npm test`；改样式用浏览器截图，注意高 DPR 环境会超 10MB，用 `--force-device-scale-factor=1`。

---

## 5. 快速事实卡

- 版本：v1.1.0；License MIT；线上：https://momoximing.github.io/wanjie-system/
- 设计语言关键词：观测台 / 深空神经元 / 黄铜低饱和 / 去 AI 味 / 克制动效 / 等宽数字 / 焦点环只在键盘
- 依赖：前端零依赖；后端零依赖 Node；无 React/Vue/构建链
- 三主题：`dark`（默认）/ `notion` / `health`，URL 加 `?theme=dark|notion|health` 可直切
