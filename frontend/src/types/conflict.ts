/**
 * 冲突单：双班组合并 / 外检值与处置单不一致时，保留两版差异，
 * 由负责人选择事实来源；未决前相关处置单不能完成闭环。
 */
import type { ReadingSource } from '@/types/source'

/**
 * 冲突类型：
 * - dual-reading   同一点位巡检班与外检班两边都有值（现场值待核查，外检原值保留）
 * - leak-mismatch  外检值与已派泄漏处置单记载浓度不一致
 */
export type ConflictType = 'dual-reading' | 'leak-mismatch'

export const CONFLICT_TYPE_LABEL: Record<ConflictType, string> = {
  'dual-reading': '同点双值',
  'leak-mismatch': '外检值与处置单冲突'
}

/**
 * 冲突裁决状态：
 * - open      未决：保留两版差异，等待负责人选择事实来源
 * - resolved  已决：负责人已选定事实来源
 */
export type ConflictStatus = 'open' | 'resolved'

export interface ConflictSide {
  /** 来源班组 */
  source: ReadingSource
  /** 读数 id */
  readingId: string
  value: number
  /** 该读数录入时冻结的判级结论 */
  isAbnormal: boolean
  levelText: string
  note: string
  recordedAt: string
}

export interface Conflict {
  id: string
  type: ConflictType
  status: ConflictStatus
  stationId: string
  deviceId: string
  pointId: string
  patrolId: string
  /** 关联处置单 id（leak-mismatch 时有值；dual-reading 若已派单也回填） */
  leakId: string
  /** 处置单记载浓度（ppm，leak-mismatch 时用于差异对照） */
  leakConcentrationPpm: number
  /** 差异双方（双值时为巡检班/外检班两版；与处置单冲突时外检版 + 处置单版） */
  sides: ConflictSide[]
  /** 受影响记录：读数 / 处置单 id 列表，页面据此提示波及范围 */
  affectedReadingIds: string[]
  affectedLeakIds: string[]
  /** 冲突来源说明（页面展示） */
  originText: string
  /** 负责人裁决选定的事实来源 */
  chosenSource: ReadingSource | 'leak' | ''
  decidedBy: string
  decidedAt: number
  decisionNote: string
  createdAt: number
  updatedAt: number
}

export interface ConflictDraft {
  decidedBy: string
  decisionNote: string
}

export const EMPTY_CONFLICT_DRAFT: ConflictDraft = {
  decidedBy: '',
  decisionNote: ''
}
