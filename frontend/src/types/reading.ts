/**
 * 读数来源：巡检班（现场录入，可断网离线暂存）/ 外检班（外检原值，只读不可覆盖）
 */
export type ReadingSource = '巡检班' | '外检班'

export const READING_SOURCES: ReadingSource[] = ['巡检班', '外检班']

/**
 * 核查状态：
 * - 待核查：同一点位存在两版值时，现场（巡检班）值的默认状态
 * - 已核实：唯一来源或已由负责人裁决采纳
 * - 未采纳：双版冲突裁决后，未被选为事实来源的现场值
 */
export type ReadingVerifyStatus = '待核查' | '已核实' | '未采纳'

export const READING_VERIFY_STATUSES: ReadingVerifyStatus[] = ['待核查', '已核实', '未采纳']

/** 读数：某次巡检中某个点位的实测读数 */
export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 */
  deviationPct: number
  note: string
  /** 录入班组：巡检班现场值 / 外检班原值 */
  source: ReadingSource
  /** 现场值核查状态；外检原值固定为「已核实」 */
  verifyStatus: ReadingVerifyStatus
  /** 外检原值冻结：不可被覆盖、删除或修正 */
  frozen: boolean
  /** 关联的未决/已决数据冲突 id（可空） */
  conflictId: string | null
  /** 录入时标准值快照（读数字段判级永远以此为准） */
  standardMinAtEntry: number
  standardMaxAtEntry: number
  /** 录入时关键点标记快照 */
  isCriticalAtEntry: boolean
  /** 录入时点位标准版本（标准值改版只影响新批次） */
  standardRevision: number
  /** 离线暂存读数对应的合并任务 id（在线直接录入为空） */
  syncJobId: string | null
  createdAt: number
  updatedAt: number
}

export interface ReadingDraft {
  patrolId: string
  pointId: string
  value: number
  note: string
}

export const EMPTY_READING_DRAFT: ReadingDraft = {
  patrolId: '',
  pointId: '',
  value: 0,
  note: ''
}

/** 读数草稿表：`${source}:${patrolId}:${pointId}` → 输入值（两班各自记一份） */
export type ReadingDraftMap = Record<string, number>

export function readingDraftKey(source: ReadingSource, patrolId: string, pointId: string): string {
  return `${source}:${patrolId}:${pointId}`
}

/** 读取标准快照的判级输入（历史行缺快照时回退到当前点位标准） */
export interface ReadingStandardSnapshot {
  standardMin: number
  standardMax: number
  isCritical: boolean
}

/** 取一条读数判级应使用的标准：永远优先录入时快照 */
export function snapshotOfReading(reading: Reading, fallback?: ReadingStandardSnapshot | null): ReadingStandardSnapshot {
  if (
    typeof reading.standardMinAtEntry === 'number' &&
    typeof reading.standardMaxAtEntry === 'number' &&
    typeof reading.isCriticalAtEntry === 'boolean'
  ) {
    return {
      standardMin: reading.standardMinAtEntry,
      standardMax: reading.standardMaxAtEntry,
      isCritical: reading.isCriticalAtEntry
    }
  }
  return fallback ?? { standardMin: 0, standardMax: 1, isCritical: false }
}
