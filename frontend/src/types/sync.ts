/**
 * 断网录入与合并冲突领域模型
 * - SyncJob：现场断网时的录入暂存任务，恢复联网后按设备/点位合并，可重试
 * - DataConflict：同一点位两版值 / 外检值与处置单冲突，由负责人裁决事实来源
 */
import type { ReadingSource, ReadingVerifyStatus } from '@/types/reading'

/** 冲突类型：同一点位两版值；外检原值与处置单不一致 */
export type ConflictType = '两版值冲突' | '外检与处置单冲突'

export const CONFLICT_TYPES: ConflictType[] = ['两版值冲突', '外检与处置单冲突']

/** 冲突状态：未决 → 已裁决 / 已忽略 */
export type ConflictStatus = '未决' | '已裁决' | '已忽略'

export const CONFLICT_STATUSES: ConflictStatus[] = ['未决', '已裁决', '已忽略']

/** 可被选为事实来源的一方 */
export type ConflictParty = '巡检班' | '外检班'

export interface ConflictLeakRef {
  /** 冲突时处置单记录的浓度快照（处置单原值不被改动） */
  leakConcentrationPpm: number
  leakState: string
}

/** 数据冲突：双来源读数差异或外检值与处置单矛盾，保留差异等待裁决 */
export interface DataConflict {
  id: string
  type: ConflictType
  status: ConflictStatus
  pointId: string
  deviceId: string
  stationId: string
  /** 触发冲突的合并任务（两版值冲突时可空） */
  syncJobId: string | null
  /** 巡检班现场读数 id */
  fieldReadingId: string | null
  /** 外检班原值读数 id */
  externalReadingId: string | null
  /** 现场值 */
  fieldValue: number | null
  /** 外检原值 */
  externalValue: number | null
  /** 受影响的处置单 id（外检与处置单冲突） */
  leakId: string | null
  /** 受影响处置单快照 */
  leakRef: ConflictLeakRef | null
  /** 差异量（两版值之差，ppm/同单位） */
  diffValue: number
  /** 负责人裁决选择的事实来源 */
  chosenSource: ConflictParty | null
  /** 裁决负责人 */
  decidedBy: string
  /** 裁决备注 */
  decisionNote: string
  /** 受影响记录的可读描述（页面直接展示冲突来源与影响面） */
  affectedLabel: string
  createdAt: number
  updatedAt: number
  decidedAt: number | null
}

/** 合并任务状态：待联网合并 / 合并失败可重试 / 已合并 */
export type SyncJobState = '待同步' | '合并失败' | '已合并'

export const SYNC_JOB_STATES: SyncJobState[] = ['待同步', '合并失败', '已合并']

/** 现场录入在断网时暂存的载荷，恢复后按设备/点位合并 */
export interface SyncJobPayload {
  patrolId: string
  pointId: string
  stationId: string
  value: number
  note: string
  /** 录入时标准快照 */
  standardMin: number
  standardMax: number
  isCritical: boolean
  standardRevision: number
  /** 录入发生时刻 */
  recordedAt: number
}

/** 断网录入合并任务（巡检班现场值） */
export interface SyncJob {
  id: string
  state: SyncJobState
  /** 预定的读数 id：保证重试幂等，不会写重 */
  readingId: string
  stationId: string
  deviceId: string
  pointId: string
  payload: SyncJobPayload
  attempts: number
  lastError: string
  createdAt: number
  updatedAt: number
  syncedAt: number | null
}

/** 合并引擎的一次处理结果 */
export interface SyncResult {
  ok: boolean
  readingId: string
  /** 本次合并新建/命中的冲突 id（可空） */
  conflictId: string | null
  conflictType: ConflictType | null
  verifyStatus: ReadingVerifyStatus
  error?: string
}

/** 外检录入结果（在线直接落库，不走暂存队列） */
export interface ExternalEntryResult {
  readingId: string
  /** 命中既有两版值冲突时返回其 id */
  conflictId: string | null
  /** 受影响的处置单冲突（可能多张） */
  leakConflictIds: string[]
  verifyStatus: ReadingVerifyStatus
}

export type { ReadingSource }
