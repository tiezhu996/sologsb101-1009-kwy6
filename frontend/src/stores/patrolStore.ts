/**
 * 巡检任务与读数状态（Zustand）
 * 维护巡检任务列表、两班（巡检班/外检班）读数草稿、断网暂存与异常判定。
 *
 * 关键口径：
 * - 巡检班现场值断网时入合并队列（syncjobs），恢复后按设备/点位合并；外检班原值仅在线直写且冻结。
 * - 读数判级永远使用录入时标准快照（标准改版不翻历史）。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, deletePatrolCascade, type PatrolRow } from '@/utils/db'
import { enqueueFieldReading, submitExternalReading } from '@/utils/sync'
import type { Patrol, PatrolDraft, PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import {
  readingDraftKey,
  snapshotOfReading,
  type Reading,
  type ReadingDraftMap,
  type ReadingSource
} from '@/types/reading'
import type { AbnormalLevel, ReadingJudgement } from '@/utils/range'
import { abnormalLevelOf, abnormalWeight, judgeReading } from '@/utils/range'
import { useStationStore } from '@/stores/stationStore'
import { useSyncStore } from '@/stores/syncStore'

export interface AbnormalRow {
  reading: Reading
  patrol: Patrol | null
  point: Point | null
  level: AbnormalLevel
  weight: number
}

export interface SingleSaveResult {
  ok: boolean
  offlineQueued: boolean
  blocked?: string
}

interface PatrolState_ {
  patrols: Patrol[]
  readings: Reading[]
  /** 读数草稿：`${source}:${patrolId}:${pointId}` → 输入值 */
  readingDraft: ReadingDraftMap
  /** 当前正在录入的巡检 id */
  activePatrolId: string | null
  /** 当前录入班组：巡检班现场值 / 外检班原值 */
  entrySource: ReadingSource
  filter: { stationId: string; states: PatrolState[] }
  ready: boolean
  setActivePatrol: (id: string | null) => void
  setEntrySource: (source: ReadingSource) => void
  patchFilter: (patch: { stationId?: string; states?: PatrolState[] }) => void
  resetFilter: () => void
  createPatrol: (draft: PatrolDraft) => Promise<Patrol>
  updatePatrol: (id: string, patch: Partial<PatrolDraft>) => Promise<void>
  removePatrol: (id: string) => Promise<void>
  generatePlans: (stationIds: string[], planDate: string, patrolman: string) => Promise<number>
  markMissed: (id: string, note: string) => Promise<void>
  completePatrol: (id: string, patrolDate: string, patrolman: string, envNote: string) => Promise<void>
  setReadingDraft: (source: ReadingSource, patrolId: string, pointId: string, value: number) => void
  clearReadingDraft: (patrolId?: string) => void
  seedDraftFromReadings: (patrolId: string, points: Point[], source: ReadingSource) => void
  saveReadingDrafts: (patrolId: string, points: Point[], source: ReadingSource) => Promise<number>
  saveSingleReading: (
    patrolId: string,
    point: Point,
    value: number,
    note: string,
    source: ReadingSource
  ) => Promise<SingleSaveResult>
  updateReadingNote: (reading: Reading, note: string) => Promise<void>
  removeReading: (id: string) => Promise<void>
  judge: (point: Point, value: number) => ReadingJudgement
  /** 按读数自身的录入时标准快照判级 */
  judgeReadingRow: (reading: Reading) => ReadingJudgement
  readingsOfPatrol: (patrolId: string) => Reading[]
  abnormalRows: () => AbnormalRow[]
  filteredPatrols: () => Patrol[]
  /** 点位 id → 该点位所有版本读数（同一点位可能两班各有一版） */
  pointValuesOf: (patrolId: string) => Map<string, Reading[]>
  /** 该巡检下尚未合并的断网暂存任务条数 */
  pendingJobCountOf: (patrolId: string) => number
}

export const usePatrolStore = create<PatrolState_>((set, get) => ({
  patrols: [],
  readings: [],
  readingDraft: {},
  activePatrolId: null,
  entrySource: '巡检班',
  filter: { stationId: '', states: [] },
  ready: false,

  setActivePatrol(id) {
    set({ activePatrolId: id })
  },

  setEntrySource(source) {
    set({ entrySource: source })
  },

  patchFilter(patch) {
    set({
      filter: {
        stationId: patch.stationId ?? get().filter.stationId,
        states: patch.states ?? get().filter.states
      }
    })
  },

  resetFilter() {
    set({ filter: { stationId: '', states: [] } })
  },

  async createPatrol(draft) {
    const now = Date.now()
    const row: PatrolRow = {
      id: createId('pa'),
      stationId: draft.stationId || '',
      planDate: draft.planDate,
      patrolDate: draft.patrolDate,
      patrolman: draft.patrolman.trim(),
      envNote: draft.envNote.trim(),
      state: draft.state,
      createdAt: now,
      updatedAt: now
    }
    await db.patrols.put(row)
    return row
  },

  async updatePatrol(id, patch) {
    const next: Partial<PatrolRow> = { ...patch, updatedAt: Date.now() }
    if (patch.patrolman !== undefined) next.patrolman = patch.patrolman.trim()
    if (patch.envNote !== undefined) next.envNote = patch.envNote.trim()
    await db.patrols.update(id, next)
  },

  async removePatrol(id) {
    await deletePatrolCascade(id)
    get().clearReadingDraft(id)
    if (get().activePatrolId === id) set({ activePatrolId: null })
  },

  async generatePlans(stationIds, planDate, patrolman) {
    const now = Date.now()
    const existing = get().patrols.filter((patrol) => patrol.planDate === planDate).map((patrol) => patrol.stationId)
    const rows: PatrolRow[] = stationIds
      .filter((stationId) => !existing.includes(stationId))
      .map((stationId) => ({
        id: createId('pa'),
        stationId,
        planDate,
        patrolDate: '',
        patrolman: patrolman.trim(),
        envNote: '',
        state: '待巡检' as PatrolState,
        createdAt: now,
        updatedAt: now
      }))
    if (rows.length > 0) await db.patrols.bulkPut(rows)
    return rows.length
  },

  async markMissed(id, note) {
    await db.patrols.update(id, { state: '漏检', envNote: note.trim() || '超期未执行', updatedAt: Date.now() })
  },

  async completePatrol(id, patrolDate, patrolman, envNote) {
    await db.patrols.update(id, {
      state: '已完成',
      patrolDate,
      patrolman: patrolman.trim() || '未署名',
      envNote: envNote.trim(),
      updatedAt: Date.now()
    })
  },

  setReadingDraft(source, patrolId, pointId, value) {
    set({
      readingDraft: { ...get().readingDraft, [readingDraftKey(source, patrolId, pointId)]: value }
    })
  },

  clearReadingDraft(patrolId) {
    if (patrolId === undefined) {
      set({ readingDraft: {} })
      return
    }
    const next: ReadingDraftMap = {}
    Object.entries(get().readingDraft).forEach(([key, value]) => {
      if (!key.includes(`:${patrolId}:`)) next[key] = value
    })
    set({ readingDraft: next })
  },

  seedDraftFromReadings(patrolId, points, source) {
    const next = { ...get().readingDraft }
    const existing = get()
      .readings.filter((reading) => reading.patrolId === patrolId && reading.source === source)
    points.forEach((point) => {
      const key = readingDraftKey(source, patrolId, point.id)
      if (next[key] !== undefined) return
      const found = existing
        .filter((reading) => reading.pointId === point.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (found) next[key] = found.value
    })
    set({ readingDraft: next })
  },

  async saveReadingDrafts(patrolId, points, source) {
    const draft = get().readingDraft
    let saved = 0
    for (const point of points) {
      const value = draft[readingDraftKey(source, patrolId, point.id)]
      if (value === undefined || !Number.isFinite(value)) continue
      // 外检原值永不覆盖：同点位已有外检值时跳过（界面上可直接追加新版本由单条录入处理）
      if (source === '外检班') {
        const hasExternal = get().readings.some(
          (reading) => reading.patrolId === patrolId && reading.pointId === point.id && reading.source === '外检班'
        )
        if (hasExternal) continue
      }
      const result = await get().saveSingleReading(patrolId, point, value, '', source)
      if (result.ok) saved += 1
    }
    return saved
  },

  async saveSingleReading(patrolId, point, value, note, source) {
    const online = useSyncStore.getState().online
    if (source === '外检班') {
      // 外检原值只能在线直接落库，断网不允许
      if (!online) {
        return { ok: false, offlineQueued: false, blocked: '现场断网，外检班原值暂不能录入；可切换为巡检班现场值离线暂存' }
      }
      await submitExternalReading({ patrolId, point, value, note })
      return { ok: true, offlineQueued: false }
    }
    // 巡检班现场值：断网入队列，联网立即合并
    const { result } = await enqueueFieldReading({ patrolId, point, value, note, online })
    return {
      ok: true,
      offlineQueued: !online || result === null,
      blocked: result && !result.ok ? result.error : undefined
    }
  },

  async updateReadingNote(reading, note) {
    if (reading.frozen) return
    await db.readings.update(reading.id, { note, updatedAt: Date.now() })
  },

  async removeReading(id) {
    const reading = get().readings.find((item) => item.id === id)
    if (reading?.frozen) return
    await db.readings.delete(id)
  },

  judge(point, value) {
    return judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
  },

  judgeReadingRow(reading) {
    const snapshot = snapshotOfReading(reading)
    return judgeReading(reading.value, snapshot.standardMin, snapshot.standardMax, snapshot.isCritical)
  },

  readingsOfPatrol(patrolId) {
    return get().readings.filter((reading) => reading.patrolId === patrolId)
  },

  abnormalRows() {
    const points = useStationStore.getState().points
    return get()
      .readings.filter((reading) => reading.isAbnormal && reading.verifyStatus !== '未采纳')
      .map((reading) => {
        const point = points.find((item) => item.id === reading.pointId) ?? null
        const patrol = get().patrols.find((item) => item.id === reading.patrolId) ?? null
        const snapshot = snapshotOfReading(reading)
        const level: AbnormalLevel = abnormalLevelOf(reading.deviationPct, snapshot.isCritical)
        return {
          reading,
          patrol,
          point,
          level,
          weight: point ? abnormalWeight(level, snapshot.isCritical) : 20
        }
      })
      .sort((a, b) => b.weight - a.weight || b.reading.deviationPct - a.reading.deviationPct)
  },

  filteredPatrols() {
    const { patrols, filter } = get()
    return patrols
      .filter((patrol) => {
        if (filter.stationId && patrol.stationId !== filter.stationId) return false
        if (filter.states.length > 0 && !filter.states.includes(patrol.state)) return false
        return true
      })
      .sort((a, b) => b.planDate.localeCompare(a.planDate))
  },

  pointValuesOf(patrolId) {
    const map = new Map<string, Reading[]>()
    get()
      .readings.filter((reading) => reading.patrolId === patrolId)
      .forEach((reading) => {
        const list = map.get(reading.pointId) ?? []
        list.push(reading)
        map.set(reading.pointId, list)
      })
    return map
  },

  pendingJobCountOf(patrolId) {
    return useSyncStore.getState().syncJobs.filter(
      (job) => job.payload.patrolId === patrolId && job.state !== '已合并'
    ).length
  }
}))

liveQuery(async () =>
  (await db.patrols.toArray()).sort((a, b) => b.planDate.localeCompare(a.planDate))
).subscribe({
  next: (rows) => usePatrolStore.setState({ patrols: rows, ready: true }),
  error: () => usePatrolStore.setState({ ready: true })
})

liveQuery(async () =>
  (await db.readings.toArray()).sort((a, b) => b.deviationPct - a.deviationPct)
).subscribe({
  next: (rows) => usePatrolStore.setState({ readings: rows })
})

export { abnormalLevelOf }
