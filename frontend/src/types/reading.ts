/** 读数：某次巡检中某个点位的实测读数 */
import type { ReadingSource, ReadingSyncState, SiteVerifyState } from '@/types/source'

export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 */
  deviationPct: number
  note: string
  /**
   * 录入班组来源：巡检班现场值 / 外检班原值。
   * 历史数据缺省视为巡检班现场值。
   */
  source: ReadingSource
  /**
   * 判级时冻结的点位标准版本（标准上下限 / 关键点）。
   * 读数永远按「录入时标准」判级，后续改标准只影响新批次。
   */
  standardRevision: number
  standardMinAtEntry: number
  standardMaxAtEntry: number
  isCriticalAtEntry: boolean
  /** 录入批次（标准版本 + 录入顺序），改标准后新读数归入新批次 */
  batchNo: number
  /** 双班组合并 / 同步状态 */
  syncState: ReadingSyncState
  /** 现场值核查状态（仅现场值在双值冲突时有意义） */
  verifyState: SiteVerifyState
  /** 断网暂存后最近一次合并时间（ms），未合并为 0 */
  syncedAt: number
  /** 合并失败原因（syncState = failed 时回填），同时用于页面展示冲突来源 */
  lastError: string
  /** 关联冲突单 id（若该读数卷入冲突） */
  conflictId: string
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

/** 读数草稿表：`${patrolId}:${pointId}` → 输入值 */
export type ReadingDraftMap = Record<string, number>
