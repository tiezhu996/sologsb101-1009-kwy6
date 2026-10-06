/**
 * 断网合并与冲突裁决状态（Zustand）
 * - 维护联网/断网（断网模拟）开关、合并任务队列、数据冲突清单
 * - 恢复联网自动排空暂存队列；失败任务可重试
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, readOnlineFlag, writeOnlineFlag, type ConflictRow, type SyncJobRow } from '@/utils/db'
import {
  decideConflict as decideConflictEngine,
  discardSyncJob,
  flushSyncJobs,
  ignoreConflict as ignoreConflictEngine,
  processSyncJob,
  reopenConflict as reopenConflictEngine
} from '@/utils/sync'
import type { ConflictParty, ConflictStatus, ConflictType, SyncResult } from '@/types/sync'

interface SyncState {
  online: boolean
  conflicts: ConflictRow[]
  syncJobs: SyncJobRow[]
  ready: boolean
  flushing: boolean
  setOnline: (online: boolean) => Promise<void>
  retryJob: (jobId: string) => Promise<SyncResult>
  flushAll: () => Promise<{ processed: number; failed: number }>
  decideConflict: (input: {
    conflictId: string
    chosenSource: ConflictParty
    decidedBy: string
    decisionNote: string
  }) => Promise<void>
  ignoreConflict: (conflictId: string, decidedBy: string) => Promise<void>
  reopenConflict: (conflictId: string) => Promise<void>
  removeJob: (jobId: string) => Promise<void>
  pendingCount: () => number
  failedCount: () => number
  openConflictCount: () => number
  /** 处置单是否被未决冲突阻塞（未决前不能复检闭环） */
  isLeakBlocked: (leakId: string) => boolean
  openConflictOfLeak: (leakId: string) => ConflictRow | null
  openConflictOfReading: (readingId: string) => ConflictRow | null
  conflictOf: (conflictId: string | null) => ConflictRow | null
  conflictsOfType: (type: ConflictType) => ConflictRow[]
}

export const useSyncStore = create<SyncState>((set, get) => ({
  online: readOnlineFlag(),
  conflicts: [],
  syncJobs: [],
  ready: false,
  flushing: false,

  async setOnline(online) {
    writeOnlineFlag(online)
    set({ online })
    if (online) {
      set({ flushing: true })
      try {
        await flushSyncJobs()
      } finally {
        set({ flushing: false })
      }
    }
  },

  async retryJob(jobId) {
    set({ flushing: true })
    try {
      return await processSyncJob(jobId)
    } finally {
      set({ flushing: false })
    }
  },

  async flushAll() {
    set({ flushing: true })
    try {
      const result = await flushSyncJobs()
      return { processed: result.processed, failed: result.failed }
    } finally {
      set({ flushing: false })
    }
  },

  async decideConflict(input) {
    await decideConflictEngine(input)
  },

  async ignoreConflict(conflictId, decidedBy) {
    await ignoreConflictEngine(conflictId, decidedBy)
  },

  async reopenConflict(conflictId) {
    await reopenConflictEngine(conflictId)
  },

  async removeJob(jobId) {
    await discardSyncJob(jobId)
  },

  pendingCount() {
    return get().syncJobs.filter((job) => job.state === '待同步').length
  },

  failedCount() {
    return get().syncJobs.filter((job) => job.state === '合并失败').length
  },

  openConflictCount() {
    return get().conflicts.filter((conflict) => conflict.status === '未决').length
  },

  isLeakBlocked(leakId) {
    return get().conflicts.some((conflict) => conflict.status === '未决' && conflict.leakId === leakId)
  },

  openConflictOfLeak(leakId) {
    return get().conflicts.find((conflict) => conflict.status === '未决' && conflict.leakId === leakId) ?? null
  },

  openConflictOfReading(readingId) {
    return (
      get().conflicts.find(
        (conflict) =>
          conflict.status === '未决' &&
          (conflict.fieldReadingId === readingId || conflict.externalReadingId === readingId)
      ) ?? null
    )
  },

  conflictOf(conflictId) {
    if (!conflictId) return null
    return get().conflicts.find((conflict) => conflict.id === conflictId) ?? null
  },

  conflictsOfType(type) {
    return get().conflicts.filter((conflict) => conflict.type === type)
  }
}))

liveQuery(async () => (await db.conflicts.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)).subscribe({
  next: (rows) => useSyncStore.setState({ conflicts: rows, ready: true }),
  error: () => useSyncStore.setState({ ready: true })
})

liveQuery(async () => (await db.syncjobs.toArray()).sort((a, b) => a.createdAt - b.createdAt)).subscribe({
  next: (rows) => useSyncStore.setState({ syncJobs: rows })
})

export const CONFLICT_STATUS_TONE: Record<ConflictStatus, string> = {
  未决: 'red',
  已裁决: 'green',
  已忽略: 'gray'
}
