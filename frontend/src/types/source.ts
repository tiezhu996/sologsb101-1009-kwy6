/**
 * 双班组录入来源：
 * - 巡检班（site）：现场巡检录入，断网时先入本地待同步队列
 * - 外检班（external）：外部检测班回传的检测值（外检原值，不可覆盖丢失）
 */
export type ReadingSource = 'site' | 'external'

export const READING_SOURCES: ReadingSource[] = ['site', 'external']

export const READING_SOURCE_LABEL: Record<ReadingSource, string> = {
  site: '巡检班（现场）',
  external: '外检班（外检原值）'
}

/**
 * 合并 / 同步状态：
 * - local       仅本地（断网暂存，尚未合并）
 * - synced      已合并，无冲突
 * - conflict    同一点位两边都有值，或外检值与处置单冲突，保留两版待裁决
 * - resolved    冲突已由负责人选定事实来源
 * - failed      合并失败，可重试
 */
export type ReadingSyncState = 'local' | 'synced' | 'conflict' | 'resolved' | 'failed'

export const READING_SYNC_STATES: ReadingSyncState[] = ['local', 'synced', 'conflict', 'resolved', 'failed']

export const READING_SYNC_LABEL: Record<ReadingSyncState, string> = {
  local: '本地暂存',
  synced: '已合并',
  conflict: '待核查冲突',
  resolved: '已裁决',
  failed: '合并失败'
}

/** 现场值核查状态：现场值与外检原值并存时，现场值默认待核查 */
export type SiteVerifyState = 'none' | 'pending' | 'confirmed' | 'discarded'

export const SITE_VERIFY_LABEL: Record<SiteVerifyState, string> = {
  none: '无需核查',
  pending: '现场值待核查',
  confirmed: '现场值已采信',
  discarded: '现场值已弃用'
}
