/**
 * 巡检任务与读数状态（Zustand）
 * 维护巡检任务列表、读数草稿与异常判定结果。
 * 读数区分巡检班（现场）/ 外检班（外检原值）来源：
 * - 现场断网时先落「本地暂存」，恢复后由 syncStore 触发按设备+点位合并；
 * - 判级永远取读数录入时冻结的标准快照，标准后续修改不翻历史。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, deletePatrolCascade, putReading, type PatrolRow, type ReadingRow } from '@/utils/db'
import type { Patrol, PatrolDraft, PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading } from '@/types/reading'
import type { ReadingDraftMap } from '@/types/reading'
import type { ReadingSource } from '@/types/source'
import type { AbnormalLevel, ReadingJudgement } from '@/utils/range'
import { abnormalLevelOf, abnormalWeight, judgeReading, levelOfReading } from '@/utils/range'
import { mergePendingReadings } from '@/utils/merge'
import { useStationStore } from '@/stores/stationStore'
import { useSyncStore } from '@/stores/syncStore'

export interface AbnormalRow {
  reading: Reading
  patrol: Patrol | null
  point: Point | null
  level: AbnormalLevel
  weight: number
}

interface PatrolState_ {
  patrols: Patrol[]
  readings: Reading[]
  /** 读数草稿：`${patrolId}:${pointId}:${source}` → 输入值 */
  readingDraft: ReadingDraftMap
  /** 当前正在录入的巡检 id */
  activePatrolId: string | null
  /** 当前录入班组 */
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
  draftKey: (patrolId: string, pointId: string, source?: ReadingSource) => string
  setReadingDraft: (patrolId: string, pointId: string, value: number, source?: ReadingSource) => void
  clearReadingDraft: (patrolId?: string) => void
  seedDraftFromReadings: (patrolId: string, points: Point[]) => void
  saveReadingDrafts: (patrolId: string, points: Point[], source?: ReadingSource) => Promise<number>
  saveSingleReading: (
    patrolId: string,
    point: Point,
    value: number,
    note: string,
    source?: ReadingSource
  ) => Promise<ReadingRow>
  removeReading: (id: string) => Promise<void>
  judge: (point: Point, value: number) => ReadingJudgement
  readingsOfPatrol: (patrolId: string) => Reading[]
  abnormalRows: () => AbnormalRow[]
  filteredPatrols: () => Patrol[]
  pointValuesOf: (patrolId: string) => Map<string, Reading[]>
}

export const usePatrolStore = create<PatrolState_>((set, get) => ({
  patrols: [],
  readings: [],
  readingDraft: {},
  activePatrolId: null,
  entrySource: 'site',
  filter: { stationId: '', states: [] },
  ready: false,

  setActivePatrol(id) {
    set({ activePatrolId: id })
  },

  setEntrySource(source) {
    set({ entrySource: source })
  },

  draftKey(patrolId, pointId, source) {
    return `${patrolId}:${pointId}:${source ?? get().entrySource}`
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

  setReadingDraft(patrolId, pointId, value, source) {
    const key = get().draftKey(patrolId, pointId, source)
    set({ readingDraft: { ...get().readingDraft, [key]: value } })
  },

  clearReadingDraft(patrolId) {
    if (patrolId === undefined) {
      set({ readingDraft: {} })
      return
    }
    const next: ReadingDraftMap = {}
    Object.entries(get().readingDraft).forEach(([key, value]) => {
      if (!key.startsWith(`${patrolId}:`)) next[key] = value
    })
    set({ readingDraft: next })
  },

  seedDraftFromReadings(patrolId, points) {
    const next = { ...get().readingDraft }
    const existing = get().readings.filter((reading) => reading.patrolId === patrolId)
    points.forEach((point) => {
      ;(['site', 'external'] as ReadingSource[]).forEach((source) => {
        const key = get().draftKey(patrolId, point.id, source)
        if (next[key] !== undefined) return
        const found = existing
          .filter((reading) => reading.pointId === point.id && reading.source === source)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        if (found) next[key] = found.value
      })
    })
    set({ readingDraft: next })
  },

  async saveReadingDrafts(patrolId, points, sourceArg) {
    const source = sourceArg ?? get().entrySource
    const draft = get().readingDraft
    // 同班组同点位只保留一条（重复录入覆盖最新值）；另一班组的值不互相覆盖
    const existing = get().readings.filter(
      (reading) => reading.patrolId === patrolId && reading.source === source
    )
    const now = Date.now()
    const offline = useSyncStore.getState().offline
    const queuedIds: string[] = []
    for (const point of points) {
      const key = get().draftKey(patrolId, point.id, source)
      const value = draft[key]
      if (value === undefined || !Number.isFinite(value)) continue
      const found = existing.find((reading) => reading.pointId === point.id)
      // 先落「暂存」：断网时停留 local；在线时立即送合并引擎按设备+点位合并
      const saved = await putReading({
        id: found ? found.id : createId('rd'),
        patrolId,
        pointId: point.id,
        value,
        note: found ? found.note : '',
        source,
        syncState: 'local',
        verifyState: source === 'site' ? 'pending' : 'none',
        createdAt: found ? found.createdAt : now,
        updatedAt: now
      })
      queuedIds.push(saved.id)
    }
    if (!offline && queuedIds.length > 0) {
      await mergePendingReadings(queuedIds)
    }
    return queuedIds.length
  },

  async saveSingleReading(patrolId, point, value, note, sourceArg) {
    const source = sourceArg ?? get().entrySource
    const now = Date.now()
    const offline = useSyncStore.getState().offline
    const found = get().readings.find(
      (reading) =>
        reading.patrolId === patrolId && reading.pointId === point.id && reading.source === source
    )
    // 先暂存再合并：在线时当场合并（含双值/处置单冲突检测），断网时停留本地队列
    const saved = await putReading({
      id: found ? found.id : createId('rd'),
      patrolId,
      pointId: point.id,
      value,
      note,
      source,
      syncState: 'local',
      verifyState: source === 'site' ? 'pending' : 'none',
      createdAt: found ? found.createdAt : now,
      updatedAt: now
    })
    if (!offline) {
      await mergePendingReadings([saved.id])
    }
    return saved
  },

  async removeReading(id) {
    await db.readings.delete(id)
  },

  judge(point, value) {
    // 草稿态尚无冻结快照，按当前标准实时判级；保存落库时冻结
    return judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
  },

  readingsOfPatrol(patrolId) {
    return get().readings.filter((reading) => reading.patrolId === patrolId)
  },

  abnormalRows() {
    const points = useStationStore.getState().points
    return get()
      .readings.filter((reading) => reading.isAbnormal)
      .map((reading) => {
        const point = points.find((item) => item.id === reading.pointId) ?? null
        const patrol = get().patrols.find((item) => item.id === reading.patrolId) ?? null
        // 历史判级：以读数录入时冻结的标准为准，标准后来改过也不翻案
        const level: AbnormalLevel = levelOfReading(reading)
        return {
          reading,
          patrol,
          point,
          level,
          weight: point ? abnormalWeight(level, reading.isCriticalAtEntry) : 20
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
