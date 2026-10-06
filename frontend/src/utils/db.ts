/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 * - v3：双班组（巡检班/外检班）读数来源、断网暂存与合并、标准版本冻结、冲突单
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { Conflict } from '@/types/conflict'
import { deviationPctOf, judgeReading } from '@/utils/range'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs',
  offline: 'gbgaspress:offline-flag'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  conflicts: Conflict[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type ConflictRow = Conflict & Revisioned

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  conflicts!: Table<ConflictRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(2).stores({
      stations: 'id, name, grade, updatedAt',
      devices: 'id, stationId, type, state, updatedAt',
      points: 'id, deviceId, stationId, name, isCritical, updatedAt',
      patrols: 'id, stationId, planDate, state, updatedAt',
      readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
      leaks: 'id, deviceId, stationId, state, handler, updatedAt'
    })

    // v3：双班组录入 + 断网合并 + 标准版本冻结 + 冲突单
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, standardRevision, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings:
          'id, patrolId, pointId, source, syncState, isAbnormal, standardRevision, conflictId, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, blockedByConflict, updatedAt',
        conflicts: 'id, type, status, stationId, deviceId, pointId, patrolId, leakId, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 迁移：点位补标准版本号（历史数据统一为 v1）
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.standardRevision !== 'number') point.standardRevision = 1
          })

        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))

        // 迁移：读数冻结「录入时标准」快照；历史读数一律视为巡检班现场值、已合并
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            const point = pointMap.get(String(reading.pointId))
            const min = point ? point.standardMin : 0
            const max = point ? point.standardMax : 1
            const critical = point ? point.isCritical : false
            const value = Number(reading.value)
            const judgement = point && Number.isFinite(value)
              ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              : { isAbnormal: false, deviationPct: Number.isFinite(value) ? deviationPctOf(value, 0, 1) : 0 }
            reading.source = 'site'
            reading.standardRevision = 1
            reading.standardMinAtEntry = min
            reading.standardMaxAtEntry = max
            reading.isCriticalAtEntry = critical
            reading.batchNo = 1
            reading.syncState = 'synced'
            reading.verifyState = 'none'
            reading.syncedAt = Number(reading.updatedAt) || Date.now()
            reading.lastError = ''
            reading.conflictId = ''
            reading.isAbnormal = judgement.isAbnormal
            reading.deviationPct = judgement.deviationPct
          })

        // 迁移：处置单补冲突拦截字段
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string,unknown>) => {
            if (typeof leak.blockedByConflict !== 'string') leak.blockedByConflict = ''
            if (typeof leak.factReadingId !== 'string') leak.factReadingId = ''
          })
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, standardRevision: 1, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, standardRevision: 2, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, standardRevision: 1, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, standardRevision: 1, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, standardRevision: 1, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, standardRevision: 1, createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, standardRevision: 1, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, standardRevision: 1, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, standardRevision: 1, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, standardRevision: 1, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, standardRevision: 1, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/**
 * 播种读数定义：[id, 巡检, 点位, 读数, 备注, 来源, 合并状态, 核查状态, 冲突id, 失败原因]
 * 历史巡检班读数 rd-1..rd-11 与外检班回传值并存：
 * - rd-ext-3 与现场值一致 → 已合并；
 * - rd-7 / rd-ext-1 同点双值 → 冲突（现场值待核查，外检原值保留）；
 * - rd-11 / rd-ext-2 外检值与处置单 lk-3 记载浓度不一致 → 处置单被拦截；
 * - rd-local-1 为断网暂存、rd-fail-1 为合并失败待重试。
 */
type SeedReadingTuple = [
  string, string, string, number, string,
  Reading['source'], Reading['syncState'], Reading['verifyState'], string, string,
  number
]

const SEED_READING_ROWS: SeedReadingTuple[] = [
  ['rd-1', 'pa-1', 'pt-1', 0.41, '', 'site', 'synced', 'none', '', '', stamp(-15)],
  ['rd-2', 'pa-1', 'pt-2', 0.23, '', 'site', 'resolved', 'confirmed', 'cf-3', '', stamp(-15)],
  ['rd-3', 'pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味', 'site', 'synced', 'none', '', '', stamp(-15)],
  ['rd-4', 'pa-2', 'pt-1', 0.38, '', 'site', 'synced', 'none', '', '', stamp(-8)],
  ['rd-5', 'pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度（按录入时 v1 标准判级）', 'site', 'synced', 'none', '', '', stamp(-8)],
  ['rd-6', 'pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹', 'site', 'synced', 'none', '', '', stamp(-8)],
  ['rd-7', 'pa-2', 'pt-5', 55, '法兰处检出微量泄漏', 'site', 'conflict', 'pending', 'cf-1', '', stamp(-8)],
  ['rd-8', 'pa-4', 'pt-7', 0.21, '', 'site', 'synced', 'none', '', '', stamp(-12)],
  ['rd-9', 'pa-4', 'pt-8', 0.145, '', 'site', 'synced', 'none', '', '', stamp(-12)],
  ['rd-10', 'pa-4', 'pt-9', 12, '', 'site', 'synced', 'none', '', '', stamp(-12)],
  ['rd-11', 'pa-4', 'pt-10', 88, '阀体密封处浓度偏高', 'site', 'conflict', 'pending', 'cf-2', '', stamp(-12)],
  ['rd-ext-3', 'pa-1', 'pt-3', 68, '外检班实验室复核，与现场值一致', 'external', 'synced', 'none', '', '', stamp(-14)],
  ['rd-ext-4', 'pa-1', 'pt-2', 0.242, '外检班回传原值', 'external', 'resolved', 'none', 'cf-3', '', stamp(-14)],
  ['rd-ext-1', 'pa-2', 'pt-5', 72, '外检班原值 72 ppm，与现场读数不一致，勿覆盖', 'external', 'conflict', 'none', 'cf-1', '', stamp(-7)],
  ['rd-ext-2', 'pa-4', 'pt-10', 95, '外检班原值 95 ppm，高于处置单记载', 'external', 'conflict', 'none', 'cf-2', '', stamp(-11)],
  ['rd-local-1', 'pa-3', 'pt-1', 0.5, '现场断网暂存，恢复后待合并', 'site', 'local', 'pending', '', '', stamp(-1)],
  ['rd-fail-1', 'pa-3', 'pt-2', 0.3, '上次合并失败，可重试', 'site', 'failed', 'pending', '', '合并超时：外检原值暂不可用，请恢复网络后重试', stamp(-1)]
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', blockedByConflict: '', factReadingId: '', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', blockedByConflict: 'cf-1', factReadingId: '', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', blockedByConflict: 'cf-2', factReadingId: '', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION }
]

const SEED_CONFLICTS: ConflictRow[] = [
  {
    id: 'cf-1',
    type: 'dual-reading',
    status: 'open',
    stationId: 'st-1',
    deviceId: 'dv-2',
    pointId: 'pt-5',
    patrolId: 'pa-2',
    leakId: 'lk-2',
    leakConcentrationPpm: 55,
    sides: [
      { source: 'site', readingId: 'rd-7', value: 55, isAbnormal: true, levelText: '轻微超标', note: '法兰处检出微量泄漏', recordedAt: '2024-06-12' },
      { source: 'external', readingId: 'rd-ext-1', value: 72, isAbnormal: true, levelText: '严重超标', note: '外检班原值 72 ppm，与现场读数不一致，勿覆盖', recordedAt: '2024-06-13' }
    ],
    affectedReadingIds: ['rd-7', 'rd-ext-1'],
    affectedLeakIds: ['lk-2'],
    originText: '巡检班现场值 55 ppm 与外检班原值 72 ppm 同点并存（城东高中压调压站 · 过滤器 GL-80 · 法兰泄漏浓度 · 2024-06-12 巡检），外检原值保留不丢，现场值待核查。',
    chosenSource: '',
    decidedBy: '',
    decidedAt: 0,
    decisionNote: '',
    createdAt: stamp(-7),
    updatedAt: stamp(-7),
    revision: ROW_REVISION
  },
  {
    id: 'cf-2',
    type: 'leak-mismatch',
    status: 'open',
    stationId: 'st-2',
    deviceId: 'dv-4',
    pointId: 'pt-10',
    patrolId: 'pa-4',
    leakId: 'lk-3',
    leakConcentrationPpm: 88,
    sides: [
      { source: 'site', readingId: 'rd-11', value: 88, isAbnormal: true, levelText: '严重超标', note: '阀体密封处浓度偏高', recordedAt: '2024-06-08' },
      { source: 'external', readingId: 'rd-ext-2', value: 95, isAbnormal: true, levelText: '严重超标', note: '外检班原值 95 ppm，高于处置单记载', recordedAt: '2024-06-09' }
    ],
    affectedReadingIds: ['rd-11', 'rd-ext-2'],
    affectedLeakIds: ['lk-3'],
    originText: '外检班原值 95 ppm 与处置单 LK 记载浓度 88 ppm 不一致（西城新区调压站 · 调压器 RTZ-50/0.2 · 阀体泄漏浓度），差异保留，待负责人选择事实来源。',
    chosenSource: '',
    decidedBy: '',
    decidedAt: 0,
    decisionNote: '',
    createdAt: stamp(-11),
    updatedAt: stamp(-11),
    revision: ROW_REVISION
  },
  {
    id: 'cf-3',
    type: 'dual-reading',
    status: 'resolved',
    stationId: 'st-1',
    deviceId: 'dv-1',
    pointId: 'pt-2',
    patrolId: 'pa-1',
    leakId: '',
    leakConcentrationPpm: 0,
    sides: [
      { source: 'site', readingId: 'rd-2', value: 0.23, isAbnormal: false, levelText: '正常', note: '', recordedAt: '2024-06-05' },
      { source: 'external', readingId: 'rd-ext-4', value: 0.242, isAbnormal: false, levelText: '正常', note: '外检班回传原值', recordedAt: '2024-06-06' }
    ],
    affectedReadingIds: ['rd-2', 'rd-ext-4'],
    affectedLeakIds: [],
    originText: '巡检班现场值 0.23 MPa 与外检班原值 0.242 MPa 同点并存（城东高中压调压站 · 调压器 RTZ-80/0.4 · 出口压力）。',
    chosenSource: 'site',
    decidedBy: '王负责人',
    decidedAt: stamp(-13),
    decisionNote: '经复核对仪表，采信巡检班现场值；外检原值留档不删。',
    createdAt: stamp(-14),
    updatedAt: stamp(-13),
    revision: ROW_REVISION
  }
]

/** 由播种定义派生冻结标准快照与偏差率/异常标记 */
function buildSeedReadings(): ReadingRow[] {
  return SEED_READING_ROWS.map(([id, patrolId, pointId, value, note, source, syncState, verifyState, conflictId, lastError, savedAt]) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const judgement = point
      ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    return {
      id,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      source,
      standardRevision: point ? point.standardRevision : 1,
      standardMinAtEntry: point ? point.standardMin : 0,
      standardMaxAtEntry: point ? point.standardMax : 1,
      isCriticalAtEntry: point ? point.isCritical : false,
      batchNo: point ? point.standardRevision : 1,
      syncState,
      verifyState,
      syncedAt: syncState === 'local' || syncState === 'failed' ? 0 : savedAt,
      lastError,
      conflictId,
      createdAt: savedAt,
      updatedAt: savedAt,
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut(buildSeedReadings())
    await db.leaks.bulkPut(SEED_LEAKS)
    await db.conflicts.bulkPut(SEED_CONFLICTS)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.conflicts.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async () => {
    const conflictIds = (await db.conflicts.where('pointId').equals(pointId).primaryKeys()) as string[]
    await unblockLeaksByConflicts(conflictIds)
    await db.conflicts.where('pointId').equals(pointId).delete()
    await db.readings.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async () => {
    const conflictIds = (await db.conflicts.where('patrolId').equals(patrolId).primaryKeys()) as string[]
    await unblockLeaksByConflicts(conflictIds)
    await db.conflicts.where('patrolId').equals(patrolId).delete()
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  const points = await db.points.where('deviceId').anyOf(deviceIds).toArray()
  const pointIds = points.map((point) => point.id)
  const conflicts = pointIds.length > 0 ? await db.conflicts.where('pointId').anyOf(pointIds).toArray() : []
  await unblockLeaksByConflicts(conflicts.map((conflict) => conflict.id))
  if (conflicts.length > 0) await db.conflicts.bulkDelete(conflicts.map((conflict) => conflict.id))
  if (pointIds.length > 0) await db.readings.where('pointId').anyOf(pointIds).delete()
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
}

/** 解除一批冲突对处置单的拦截（冲突记录被级联删除时调用） */
async function unblockLeaksByConflicts(conflictIds: string[]): Promise<void> {
  if (conflictIds.length === 0) return
  const leaks = await db.leaks.filter((leak) => conflictIds.includes(leak.blockedByConflict)).toArray()
  for (const leak of leaks) {
    await db.leaks.update(leak.id, { blockedByConflict: '', updatedAt: Date.now() })
  }
}

/* ============================ 读数写入 ============================ */

/**
 * 写入读数：按「当前点位标准」判级并冻结标准快照（standardRevision/区间/关键点）。
 * 历史读数永不因标准变更重算——改标准只影响此后录入的新批次。
 */
export async function putReading(row: {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  source: Reading['source']
  syncState?: Reading['syncState']
  verifyState?: Reading['verifyState']
  createdAt: number
  updatedAt: number
}): Promise<ReadingRow> {
  const point = await db.points.get(row.pointId)
  const standardMin = point ? point.standardMin : 0
  const standardMax = point ? point.standardMax : 1
  const isCritical = point ? point.isCritical : false
  const standardRevision = point ? point.standardRevision : 1
  const judgement = judgeReading(row.value, standardMin, standardMax, isCritical)
  const next: ReadingRow = {
    id: row.id,
    patrolId: row.patrolId,
    pointId: row.pointId,
    value: row.value,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    note: row.note,
    source: row.source,
    standardRevision,
    standardMinAtEntry: standardMin,
    standardMaxAtEntry: standardMax,
    isCriticalAtEntry: isCritical,
    batchNo: standardRevision,
    syncState: row.syncState ?? 'synced',
    verifyState: row.verifyState ?? 'none',
    syncedAt: row.syncState === 'local' || row.syncState === 'failed' ? 0 : row.updatedAt,
    lastError: '',
    conflictId: '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, conflicts] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.conflicts.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, conflicts }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, conflicts] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.conflicts.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    conflicts: conflicts.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.conflicts.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.conflicts.bulkPut((payload.conflicts ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.conflicts.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}

/** 断网模拟开关（纯前端应用中以本地标志模拟现场网络中断） */
export function readOfflineFlag(): boolean {
  return localStorage.getItem(LS_KEYS.offline) === '1'
}

export function writeOfflineFlag(offline: boolean): void {
  localStorage.setItem(LS_KEYS.offline, offline ? '1' : '0')
}
