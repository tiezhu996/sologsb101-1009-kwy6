/**
 * 断网暂存 / 双班合并 / 冲突裁决状态（Zustand）
 * - 维护在线状态、暂存/失败读数计数、冲突单列表
 * - 恢复网络后触发合并引擎，失败可重试
 * - 冲突由负责人裁决，未决处置单不能完成
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  db,
  readOfflineFlag,
  writeOfflineFlag,
  type ConflictRow,
  type ReadingRow
} from '@/utils/db'
import type { Conflict } from '@/types/conflict'
import { mergePendingReadings, resolveConflict, failWhenOffline, type MergeResult, type ResolveConflictInput } from '@/utils/merge'

interface SyncState_ {
  offline: boolean
  conflicts: Conflict[]
  pendingReadings: ReadingRow[]
  ready: boolean
  setOffline: (offline: boolean) => void
  /** 恢复网络后立即合并全部暂存/失败读数 */
  syncAll: () => Promise<MergeResult>
  /** 单条 / 多条重试（合并失败后重试） */
  retry: (readingIds: string[]) => Promise<MergeResult>
  resolveConflict: (input: ResolveConflictInput) => Promise<Conflict>
  openConflicts: () => Conflict[]
  conflictOf: (id: string) => Conflict | undefined
  pendingCount: () => number
  failedCount: () => number
  conflictBlockedLeakIds: () => string[]
}

export const useSyncStore = create<SyncState_>((set, get) => ({
  offline: readOfflineFlag(),
  conflicts: [],
  pendingReadings: [],
  ready: false,

  setOffline(offline) {
    writeOfflineFlag(offline)
    set({ offline })
  },

  async syncAll() {
    // 恢复网络后再合并；仍断网时引擎会把条目标记为 failed 供恢复后重试
    const result = await mergePendingReadings([], failWhenOffline(get().offline))
    return result
  },

  async retry(readingIds) {
    // 手动重试一律视为当前网络可用；若仍断网则重新落 failed（保留原因，可再试）
    const result = await mergePendingReadings(readingIds, failWhenOffline(get().offline))
    return result
  },

  async resolveConflict(input) {
    return resolveConflict(input)
  },

  openConflicts() {
    return get().conflicts.filter((conflict) => conflict.status === 'open')
  },

  conflictOf(id) {
    return get().conflicts.find((conflict) => conflict.id === id)
  },

  pendingCount() {
    return get().pendingReadings.length
  },

  failedCount() {
    return get().pendingReadings.filter((reading) => reading.syncState === 'failed').length
  },

  conflictBlockedLeakIds() {
    return [
      ...new Set(
        get()
          .openConflicts()
          .flatMap((conflict) => conflict.affectedLeakIds)
      )
    ]
  }
}))

liveQuery(async () =>
  (await db.conflicts.toArray()).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
).subscribe({
  next: (rows: ConflictRow[]) => useSyncStore.setState({ conflicts: rows, ready: true }),
  error: () => useSyncStore.setState({ ready: true })
})

liveQuery(async () =>
  (await db.readings.where('syncState').anyOf('local', 'failed').toArray()).sort((a, b) => b.updatedAt - a.updatedAt)
).subscribe({
  next: (rows: ReadingRow[]) => useSyncStore.setState({ pendingReadings: rows })
})
