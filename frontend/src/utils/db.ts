/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 * - v3：读数双来源（巡检班/外检班）、录入时标准快照、断网合并任务、数据冲突
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point, INITIAL_STANDARD_REVISION } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading, ReadingSource, ReadingVerifyStatus } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { DataConflict, SyncJob } from '@/types/sync'
import { judgeReading } from '@/utils/range'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs',
  online: 'gbgaspress:online'
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
  conflicts: DataConflict[]
  syncJobs: SyncJob[]
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
export type ConflictRow = DataConflict & Revisioned
export type SyncJobRow = SyncJob & Revisioned

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  conflicts!: Table<ConflictRow, string>
  syncjobs!: Table<SyncJobRow, string>

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
    this.version(2)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = 2
            })
        }

        // 迁移：点位缺少 stationId 时用所属设备回填
        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
          })

        // 迁移：泄漏处置补 stationId、复检值与病态状态
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.stationId !== 'string' || leak.stationId.length === 0) {
              leak.stationId = stationOfDevice.get(String(leak.deviceId)) ?? ''
            }
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
          })

        // 迁移：读数补 note，并按偏差率重算 isAbnormal / deviationPct
        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            if (point && Number.isFinite(value)) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
            }
          })
      })

    // v3：双来源读数 + 录入时标准快照 + 断网合并任务 + 数据冲突
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings:
          'id, patrolId, pointId, isAbnormal, source, verifyStatus, conflictId, syncJobId, standardRevision, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, conflictId, updatedAt',
        conflicts: 'id, type, status, pointId, deviceId, stationId, leakId, syncJobId, updatedAt',
        syncjobs: 'id, state, stationId, deviceId, pointId, readingId, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of [
          'stations',
          'devices',
          'points',
          'patrols',
          'readings',
          'leaks',
          'conflicts',
          'syncjobs'
        ]) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 点位补标准版本号：v3 之前的点位统一记为第 1 版
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
          standardRevision?: number
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))

        // 读数补来源/核查状态/标准快照：历史读数一律按巡检班已核实，冻结其判级（不重算）
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (reading.source !== '巡检班' && reading.source !== '外检班') reading.source = '巡检班'
            if (!['待核查', '已核实', '未采纳'].includes(String(reading.verifyStatus))) {
              reading.verifyStatus = '已核实'
            }
            if (typeof reading.frozen !== 'boolean') reading.frozen = false
            if (reading.conflictId === undefined) reading.conflictId = null
            if (reading.syncJobId === undefined) reading.syncJobId = null
            const point = pointMap.get(String(reading.pointId))
            if (point) {
              reading.standardMinAtEntry = point.standardMin
              reading.standardMaxAtEntry = point.standardMax
              reading.isCriticalAtEntry = point.isCritical
              reading.standardRevision = point.standardRevision ?? 1
            } else {
              reading.standardMinAtEntry = Number(reading.standardMinAtEntry) || 0
              reading.standardMaxAtEntry = Number(reading.standardMaxAtEntry) || 1
              reading.isCriticalAtEntry = false
              reading.standardRevision = 1
            }
          })

        // 处置单补派单读数与冲突外键
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (leak.sourceReadingId === undefined) leak.sourceReadingId = null
            if (leak.conflictId === undefined) leak.conflictId = null
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

const REV: typeof INITIAL_STANDARD_REVISION = 1

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, standardRevision: REV, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, standardRevision: REV, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, standardRevision: REV, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, standardRevision: REV, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, standardRevision: REV, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, standardRevision: REV, createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, standardRevision: REV, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, standardRevision: REV, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, standardRevision: REV, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, standardRevision: REV, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, standardRevision: REV, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
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
 * 播种读数原始行：
 * [id, 巡检, 点位, 读数, 备注, 来源, 核查状态, 冻结, 冲突id, 合并任务id, 时间偏移]
 */
type SeedReadingTuple = [
  string,
  string,
  string,
  number,
  string,
  ReadingSource,
  ReadingVerifyStatus,
  boolean,
  string | null,
  string | null,
  number
]

const SEED_READING_ROWS: SeedReadingTuple[] = [
  // 巡检班现场值（历史批次）
  ['rd-1', 'pa-1', 'pt-1', 0.41, '', '巡检班', '已核实', false, null, null, -15],
  ['rd-2', 'pa-1', 'pt-2', 0.23, '', '巡检班', '已核实', false, null, null, -15],
  ['rd-3', 'pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味', '巡检班', '已核实', false, null, null, -15],
  ['rd-12', 'pa-1', 'pt-3', 120, '现场二次复测，浓度明显升高', '巡检班', '已核实', false, null, null, -15],
  ['rd-4', 'pa-2', 'pt-1', 0.38, '', '巡检班', '已核实', false, null, null, -8],
  ['rd-17', 'pa-2', 'pt-1', 0.4, '现场复测与外检接近', '巡检班', '未采纳', false, 'cf-4', null, -8],
  ['rd-5', 'pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度', '巡检班', '已核实', false, null, null, -8],
  ['rd-6', 'pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹', '巡检班', '已核实', false, null, null, -8],
  ['rd-7', 'pa-2', 'pt-5', 55, '法兰处检出微量泄漏', '巡检班', '已核实', false, null, null, -8],
  ['rd-8', 'pa-4', 'pt-7', 0.21, '', '巡检班', '已核实', false, null, null, -12],
  ['rd-9', 'pa-4', 'pt-8', 0.145, '', '巡检班', '已核实', false, null, null, -12],
  ['rd-10', 'pa-4', 'pt-9', 12, '', '巡检班', '已核实', false, null, null, -12],
  ['rd-11', 'pa-4', 'pt-10', 88, '阀体密封处浓度偏高', '巡检班', '待核查', false, 'cf-1', null, -12],
  // 外检班原值（冻结，只读，永不被覆盖）
  ['rd-13', 'pa-1', 'pt-3', 30, '外检班校准仪测得，未见浓度异常', '外检班', '已核实', true, 'cf-2', null, -15],
  ['rd-14', 'pa-4', 'pt-10', 42, '外检班同期检测，阀区环境浓度合格', '外检班', '已核实', true, 'cf-1', null, -12],
  ['rd-15', 'pa-2', 'pt-5', 18, '外检班检测合格，建议复核现场仪器', '外检班', '已核实', true, 'cf-3', null, -8],
  ['rd-16', 'pa-2', 'pt-1', 0.39, '外检班核对，压力正常', '外检班', '已核实', true, 'cf-4', null, -8]
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', sourceReadingId: 'rd-3', conflictId: 'cf-2', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', sourceReadingId: 'rd-7', conflictId: 'cf-3', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', sourceReadingId: 'rd-11', conflictId: 'cf-5', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'lk-4', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 120, foundTime: '2024-06-05', measure: '加密巡检并安排停压检修', state: '待处置', retestValuePpm: 0, handler: '', sourceReadingId: 'rd-12', conflictId: null, createdAt: stamp(-14), updatedAt: stamp(-13), revision: ROW_REVISION }
]

const SEED_CONFLICTS: ConflictRow[] = [
  {
    id: 'cf-1',
    type: '两版值冲突',
    status: '未决',
    pointId: 'pt-10',
    deviceId: 'dv-4',
    stationId: 'st-2',
    syncJobId: null,
    fieldReadingId: 'rd-11',
    externalReadingId: 'rd-14',
    fieldValue: 88,
    externalValue: 42,
    leakId: null,
    leakRef: null,
    diffValue: 46,
    chosenSource: null,
    decidedBy: '',
    decisionNote: '',
    affectedLabel:
      '西城新区调压站 / 调压器 RTZ-50/0.2 / 阀体泄漏浓度：现场值 88 ppm 与外检原值 42 ppm 并存，现场值待核查（受影响读数 2 条）',
    createdAt: stamp(-12),
    updatedAt: stamp(-12),
    decidedAt: null,
    revision: ROW_REVISION
  },
  {
    id: 'cf-2',
    type: '外检与处置单冲突',
    status: '未决',
    pointId: 'pt-3',
    deviceId: 'dv-1',
    stationId: 'st-1',
    syncJobId: null,
    fieldReadingId: 'rd-3',
    externalReadingId: 'rd-13',
    fieldValue: 68,
    externalValue: 30,
    leakId: 'lk-1',
    leakRef: { leakConcentrationPpm: 68, leakState: '已复检' },
    diffValue: 38,
    chosenSource: null,
    decidedBy: '',
    decisionNote: '',
    affectedLabel:
      '城东高中压调压站 / 调压器 RTZ-80/0.4 / 阀体泄漏浓度：外检原值 30 ppm 与处置单（68 ppm · 已复检）矛盾，保留差异，未裁决前不得继续闭环（受影响处置单 1 张、读数 2 条）',
    createdAt: stamp(-13),
    updatedAt: stamp(-13),
    decidedAt: null,
    revision: ROW_REVISION
  },
  {
    id: 'cf-3',
    type: '外检与处置单冲突',
    status: '未决',
    pointId: 'pt-5',
    deviceId: 'dv-2',
    stationId: 'st-1',
    syncJobId: null,
    fieldReadingId: 'rd-7',
    externalReadingId: 'rd-15',
    fieldValue: 55,
    externalValue: 18,
    leakId: 'lk-2',
    leakRef: { leakConcentrationPpm: 55, leakState: '已处置' },
    diffValue: 37,
    chosenSource: null,
    decidedBy: '',
    decisionNote: '',
    affectedLabel:
      '城东高中压调压站 / 过滤器 GL-80 / 法兰泄漏浓度：外检原值 18 ppm 与处置单（55 ppm · 已处置）矛盾，复检闭环需等负责人裁决（受影响处置单 1 张、读数 2 条）',
    createdAt: stamp(-7),
    updatedAt: stamp(-7),
    decidedAt: null,
    revision: ROW_REVISION
  },
  {
    id: 'cf-5',
    type: '外检与处置单冲突',
    status: '未决',
    pointId: 'pt-10',
    deviceId: 'dv-4',
    stationId: 'st-2',
    syncJobId: null,
    fieldReadingId: 'rd-11',
    externalReadingId: 'rd-14',
    fieldValue: 88,
    externalValue: 42,
    leakId: 'lk-3',
    leakRef: { leakConcentrationPpm: 88, leakState: '待处置' },
    diffValue: 46,
    chosenSource: null,
    decidedBy: '',
    decisionNote: '',
    affectedLabel:
      '西城新区调压站 / 调压器 RTZ-50/0.2 / 阀体泄漏浓度：外检原值 42 ppm 与待处置单（88 ppm）矛盾，未裁决前不能完成闭环（受影响处置单 1 张、读数 2 条）',
    createdAt: stamp(-11),
    updatedAt: stamp(-11),
    decidedAt: null,
    revision: ROW_REVISION
  },
  {
    id: 'cf-4',
    type: '两版值冲突',
    status: '已裁决',
    pointId: 'pt-1',
    deviceId: 'dv-1',
    stationId: 'st-1',
    syncJobId: null,
    fieldReadingId: 'rd-17',
    externalReadingId: 'rd-16',
    fieldValue: 0.4,
    externalValue: 0.39,
    leakId: null,
    leakRef: null,
    diffValue: 0.01,
    chosenSource: '外检班',
    decidedBy: '王强',
    decisionNote: '外检仪器刚完成年度校准，以 0.39 MPa 为事实来源；现场值保留但标记未采纳。',
    affectedLabel:
      '城东高中压调压站 / 调压器 RTZ-80/0.4 / 进口压力：现场值 0.4 MPa 与外检原值 0.39 MPa，负责人已裁决以外检班为准（两版读数均保留）',
    createdAt: stamp(-8),
    updatedAt: stamp(-3),
    decidedAt: stamp(-3),
    revision: ROW_REVISION
  }
]

/** 断网暂存任务：一条合并失败可重试，一条待联网合并（均未生成读数） */
const SEED_SYNC_JOBS: SyncJobRow[] = [
  {
    id: 'jb-1',
    state: '合并失败',
    readingId: 'rd-job1',
    stationId: 'st-1',
    deviceId: 'dv-1',
    pointId: 'pt-2',
    payload: {
      patrolId: 'pa-3',
      pointId: 'pt-2',
      stationId: 'st-1',
      value: 0.3,
      note: '断网期间现场测得，出口压力偏高',
      standardMin: 0.18,
      standardMax: 0.25,
      isCritical: true,
      standardRevision: 1,
      recordedAt: stamp(-1)
    },
    attempts: 1,
    lastError: '上次恢复联网时本地写入被中断，合并未完成（点击重试）',
    createdAt: stamp(-1),
    updatedAt: stamp(-1),
    syncedAt: null,
    revision: ROW_REVISION
  },
  {
    id: 'jb-2',
    state: '待同步',
    readingId: 'rd-job2',
    stationId: 'st-2',
    deviceId: 'dv-4',
    pointId: 'pt-7',
    payload: {
      patrolId: 'pa-6',
      pointId: 'pt-7',
      stationId: 'st-2',
      value: 0.16,
      note: '断网录入，进口压力略低于下限',
      standardMin: 0.15,
      standardMax: 0.25,
      isCritical: true,
      standardRevision: 1,
      recordedAt: stamp(0) - 3600000
    },
    attempts: 0,
    lastError: '',
    createdAt: stamp(-1),
    updatedAt: stamp(-1),
    syncedAt: null,
    revision: ROW_REVISION
  }
]

/** 由原始行派生偏差率与异常标记，判级一律使用录入时标准快照 */
function buildSeedReadings(): ReadingRow[] {
  return SEED_READING_ROWS.map(
    ([id, patrolId, pointId, value, note, source, verifyStatus, frozen, conflictId, syncJobId, offset]) => {
      const point = SEED_POINTS.find((item) => item.id === pointId)
      const judgement = point
        ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
        : { isAbnormal: false, deviationPct: 0 }
      return {
        id,
        patrolId,
        pointId,
        value,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        note,
        source,
        verifyStatus,
        frozen,
        conflictId,
        syncJobId,
        standardMinAtEntry: point ? point.standardMin : 0,
        standardMaxAtEntry: point ? point.standardMax : 1,
        isCriticalAtEntry: point ? point.isCritical : false,
        standardRevision: point ? point.standardRevision : 1,
        createdAt: stamp(offset),
        updatedAt: stamp(offset),
        revision: ROW_REVISION
      }
    }
  )
}

export async function seedDatabase(): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.conflicts,
        db.syncjobs
      ],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut(buildSeedReadings())
    await db.leaks.bulkPut(SEED_LEAKS)
    await db.conflicts.bulkPut(SEED_CONFLICTS)
    await db.syncjobs.bulkPut(SEED_SYNC_JOBS)
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
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.conflicts,
        db.syncjobs
      ],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.conflicts.where('stationId').equals(stationId).delete()
    await db.syncjobs.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.conflicts,
        db.syncjobs
      ],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.conflicts,
        db.syncjobs
      ],
      async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.conflicts.where('pointId').equals(pointId).delete()
    await db.syncjobs.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.conflicts,
        db.syncjobs
      ],
      async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    const jobs = await db.syncjobs.toArray()
    await Promise.all(
      jobs.filter((job) => job.payload.patrolId === patrolId).map((job) => db.syncjobs.delete(job.id))
    )
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
  await db.conflicts.where('deviceId').anyOf(deviceIds).delete()
  await db.syncjobs.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入 ============================ */

export interface PutReadingInput {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
  source?: ReadingSource
  verifyStatus?: ReadingVerifyStatus
  frozen?: boolean
  conflictId?: string | null
  syncJobId?: string | null
  /** 判级标准：传入即用录入时快照；省略则回退到当前点位标准 */
  standard?: {
    standardMin: number
    standardMax: number
    isCritical: boolean
    standardRevision: number
  }
}

/** 写入读数：优先按录入时标准快照判级；外检原值可标记 frozen */
export async function putReading(row: PutReadingInput): Promise<ReadingRow> {
  const point = await db.points.get(row.pointId)
  const standard =
    row.standard ??
    (point
      ? {
          standardMin: point.standardMin,
          standardMax: point.standardMax,
          isCritical: point.isCritical,
          standardRevision: point.standardRevision
        }
      : { standardMin: 0, standardMax: 1, isCritical: false, standardRevision: 1 })
  const judgement = judgeReading(row.value, standard.standardMin, standard.standardMax, standard.isCritical)
  const next: ReadingRow = {
    id: row.id,
    patrolId: row.patrolId,
    pointId: row.pointId,
    value: row.value,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    note: row.note,
    source: row.source ?? '巡检班',
    verifyStatus: row.verifyStatus ?? '已核实',
    frozen: row.frozen ?? false,
    conflictId: row.conflictId ?? null,
    syncJobId: row.syncJobId ?? null,
    standardMinAtEntry: standard.standardMin,
    standardMaxAtEntry: standard.standardMax,
    isCriticalAtEntry: standard.isCritical,
    standardRevision: standard.standardRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/* ============================ 整库导入导出 ============================ */

const ALL_TABLES = [
  'stations',
  'devices',
  'points',
  'patrols',
  'readings',
  'leaks',
  'conflicts',
  'syncjobs'
] as const

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, conflicts, syncJobs] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.conflicts.count(),
    db.syncjobs.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, conflicts, syncJobs }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, conflicts, syncJobs] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.conflicts.toArray(),
    db.syncjobs.toArray()
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
    conflicts: conflicts.map(strip),
    syncJobs: syncJobs.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.conflicts,
        db.syncjobs
      ],
      async () => {
    await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()))
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.conflicts.bulkPut((payload.conflicts ?? []).map(rev))
    await db.syncjobs.bulkPut((payload.syncJobs ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.conflicts,
        db.syncjobs
      ],
      async () => {
    await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()))
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

/** 断网模拟开关（本地持久化），默认联网 */
export function readOnlineFlag(): boolean {
  return localStorage.getItem(LS_KEYS.online) !== '0'
}

export function writeOnlineFlag(online: boolean): void {
  localStorage.setItem(LS_KEYS.online, online ? '1' : '0')
}
