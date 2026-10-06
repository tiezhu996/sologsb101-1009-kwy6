# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。**巡检班（现场）与外检班各记一份读数，断网时本地暂存、恢复后按设备+点位合并；标准值版本化冻结，历史判级不翻案；双值/处置单差异保留两版由负责人裁决。**核心动作：建站与设备、配巡检点位标准值、双班组录巡检读数、判异常分级、派处置单复检、跟踪漏检、断网合并与冲突裁决。

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
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts source.ts conflict.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts syncStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx SourceTag.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx SyncCenter.tsx PlanList.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts merge.ts export.ts
        ├── scripts/verify-merge.ts  # 合并/冲突/标准冻结逻辑断言（npm run verify:merge）
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、Device | 维护点位上下限/单位/关键点标记（草稿 → 逐条/批量提交并重算历史读数）；按模板批量复制标准值 |
| `/patrols` | 巡检录入（双班组） | Patrol、Reading、Point | 切换巡检班/外检班逐点各录一份，实时偏差率与异常级别；断网本地暂存；同点双值红框提示 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按关键点权重降序排列；展示录入班组、冻结标准版本；勾选批量确认；浓度类点位一键派发泄漏处置单 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 填写处置措施与处置人 → 录入复检浓度判合格闭环；外检值冲突未决时拦截完成；导出处置台账 CSV |
| `/sync` | 断网暂存 · 双班合并 · 冲突裁决 | Reading、Conflict、Leak | 模拟断网/恢复；一键合并与失败重试；冲突清单展示来源与受影响记录；负责人选择事实来源；导出冲突台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`conflicts`
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(3)` 的索引变更与 `upgrade()` 迁移
  - v2：补齐 `revision`、回填点位与处置单 `stationId` 冗余列、按标准区间重算历史读数
  - v3：读数新增 `source`（site 巡检班 / external 外检班）、`syncState`、`verifyState`、标准冻结快照（`standardRevision` / `standardMinAtEntry` / `standardMaxAtEntry` / `isCriticalAtEntry` / `batchNo`）、`conflictId`；点位新增 `standardRevision`；处置单新增 `blockedByConflict` / `factReadingId`；新增 `conflicts` 冲突单表
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位 → 6 次巡检 → 17 条双班组读数 → 3 张泄漏处置单（2 张被冲突拦截）→ 3 张冲突单（2 未决 / 1 已裁决）的完整链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`、`gbgaspress:offline-flag`（断网模拟）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22809
npm run build        # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run verify:merge # 双班组合并/冲突/标准冻结逻辑断言（fake-indexeddb）
npm run preview      # 本地预览构建产物
```

## 七、判定口径

- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空

## 八、双班组录入、标准版本与冲突口径

- **两班各一份**：`readings.source` 区分 `site`（巡检班现场值）/ `external`（外检班原值）。同一点位两版独立保存，互不覆盖；合并键为「巡检任务 + 点位」（即设备与点位维度）。
- **断网录入**：断网（`/sync` 页模拟开关，持久化于 `gbgaspress:offline-flag`）时读数先落 `syncState=local` 本地暂存；恢复后在 `/sync` 或录入页一键送合并引擎（`utils/merge.ts`），失败置 `failed` 并保留原因，可逐条重试，数据不丢。
- **同点双值**：两边都有值且不一致 → 建 `dual-reading` 冲突单，两版读数均保留，现场值 `verifyState=pending` 待核查，外检原值原样保留；关联未闭环处置单同步拦截。
- **标准版本冻结**：点位每次修改上下限/关键点 `standardRevision` 自增；读数录入时把版本号、上下限、关键点快照到行内，永远按录入时标准判级。后来改标准只影响新批次（`batchNo`），历史异常与已派处置单不跟着翻（v2 中"改标准重算历史读数"的行为已废止）。
- **外检值 vs 处置单**：外检 ppm 值与同设备处置单记载浓度不一致 → 建 `leak-mismatch` 冲突，处置单 `blockedByConflict` 非空，`advance` / 复检提交均被拦截，未决前不能完成。
- **负责人裁决**：在 `/sync` 选择事实来源（现场值 / 外检原值 / 处置单记载）并填写负责人与依据；两版记录全部保留，处置单按采信值更新并解除拦截。冲突单记录冲突来源（`originText`）与受影响读数 / 处置单 id。
- **验证**：`npm run verify:merge`（fake-indexeddb 中跑暂存→合并→冲突→裁决→拦截→标准冻结 21 项断言）。
