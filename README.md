# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、跟踪漏检。

**双班录入与断网合并**：巡检班（现场值）与外检班（外检原值）各记一份；现场断网时巡检班仍可离线录入并暂存，恢复联网后按「设备 + 点位」合并（失败可重试）。同一点位两班都有值时**两版都保留**、现场值置「待核查」、外检原值只读冻结不丢；外检值与处置单矛盾时保留差异，由负责人在「合并与冲突」中心选择事实来源，**未决前处置单不能复检闭环**。读数一律按**录入时的标准快照**判级，之后改标准只影响新批次，历史异常与已派处置单不翻级。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22809**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Arco Design 2.66 | 表格、表单、Modal、Tag、Badge、Progress |
| 状态管理 | Zustand 4.5 | `stationStore` / `patrolStore` / `leakStore` / `syncStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1009/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbgaspress
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts sync.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts syncStore.ts
        ├── components/common/  # AbnormalTag.tsx SourceTag.tsx OnlineBadge.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx PlanList.tsx SyncCenter.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts sync.ts export.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、Device | 维护点位上下限/单位/关键点标记（草稿 → 逐条/批量提交并重算历史读数）；按模板批量复制标准值 |
| `/patrols` | 巡检录入 | Patrol、Reading、Point、SyncJob | 顶部切换巡检班现场值 / 外检班原值；现场断网可离线暂存；逐点录入并按录入时标准实时判级；两班读数分版本保留；逐点或整批保存；完成巡检、标记漏检 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按录入时快照与关键点权重降序；展示来源/核查状态；外检原值只读不可修正/删除；浓度类点位一键派发泄漏处置单 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading、DataConflict | 派单 → 措施与处置人 → 录入复检浓度判合格闭环；外检值与处置单冲突未裁决时禁止闭环；导出处置台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |
| `/sync` | 断网合并与冲突裁决中心 | SyncJob、DataConflict、Point、Device、Reading、Leak | 联网/断网模拟；恢复后按设备/点位自动合并，失败任务可重试；展示冲突来源与受影响记录（读数/处置单）；负责人裁决两版值或外检与处置单冲突的事实来源 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`conflicts`、`syncjobs`
- **数据结构版本**：`DB_VERSION = 3`
  - `version(1)` → `version(2)`：补 `stationId` 冗余列、读数 `revision`/`note`
  - `version(3)`：读数双来源（`source` 巡检班/外检班）、核查状态（`verifyStatus` 待核查/已核实/未采纳）、外检冻结 `frozen`、录入时标准快照（`standardMinAtEntry`/`standardMaxAtEntry`/`isCriticalAtEntry`/`standardRevision`）、冲突外键 `conflictId`/`syncJobId`；点位补 `standardRevision`；处置单补 `sourceReadingId`/`conflictId`；新增 `conflicts`（两版值 / 外检与处置单冲突）与 `syncjobs`（断网暂存合并任务）两表。升级迁移**不重算历史判级**，仅回填快照
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位 → 6 次巡检 → 两班多版读数（含冻结外检原值）→ 4 张处置单 → 5 条冲突（4 未决 / 1 已裁决）→ 2 个断网合并任务（1 失败可重试 / 1 待同步）的完整链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`、`gbgaspress:online`（断网模拟开关）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

### 双班录入 / 断网合并 / 冲突裁决口径

- **各记一份**：巡检班现场值与外检班原值分开保存，同一点位可同时存在两版（`Reading.source`）。
- **断网录入**：断网模拟下巡检班读数写入 `syncjobs`（状态「待同步」），恢复联网后事务化按设备/点位合并；任务幂等（预定 `readingId`），失败置「合并失败」并保留原因，可在 `/sync` 或顶栏反复重试。外检原值仅允许在线直写。
- **两版并存**：同一点位现场值与外检值差异超阈值即保留两版，现场值「待核查」并挂「两版值冲突」；外检原值 `frozen` 只读，永不被覆盖、删除或修正。
- **标准快照**：读数在录入时固化当时的上下限/关键点/标准版本；点位标准改版（`standardRevision + 1`）只影响之后的新批次，历史异常、已派处置单均不翻级。
- **外检与处置单冲突**：外检原值与同一点位处置单浓度矛盾时生成冲突，处置单挂 `conflictId`；负责人裁决事实来源前，「已处置 → 已复检」的闭环动作被拦截（填写措施不受影响）。裁决只确定事实来源，**不改写任何原始读数/处置单浓度**。
- **页面展示**：`/sync` 列出冲突来源（站点/设备/点位、两版值、处置单快照）与受影响记录（现场读数、外检原值、处置单）；处置单与异常页对未决冲突给出明显标记与跳转入口。

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22809
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

断网合并 / 冲突裁决引擎的运行时冒烟测试（基于 `fake-indexeddb`，需临时安装 devDependencies）：

```bash
npm install --no-save fake-indexeddb tsx tsconfig-paths
node --import tsx --require tsconfig-paths/register scripts/smoke.ts
```

## 七、判定口径

- 判级标准取数：录入瞬间固化的标准快照（`standardMinAtEntry` / `standardMaxAtEntry` / `isCriticalAtEntry`）；标准值之后改版不重算历史读数
- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 两版值差异阈值：浓度 ≥ 1 ppm、压力 ≥ 0.005 MPa、温度 ≥ 0.5 ℃（不同单位分别取阈）即视为需裁决的两版值
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空
