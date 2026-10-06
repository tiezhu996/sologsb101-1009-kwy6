/**
 * 断网录入合并与冲突裁决引擎
 *
 * 口径：
 * - 巡检班现场值：断网时先落 syncjobs 暂存，恢复后按「设备 + 点位」合并；任务幂等可重试。
 * - 外检班原值：只能在线直接落库，frozen=true，永不被覆盖/删除。
 * - 同一点位两版都有值：保留两版，现场值置「待核查」，生成「两版值冲突」。
 * - 外检值与处置单矛盾：保留差异，生成「外检与处置单冲突」，处置单挂冲突外键，未决前不能复检闭环。
 * - 判级一律用录入时标准快照（payload / 读数快照），标准值改版不影响历史。
 */
import {
  createId,
  db,
  type ConflictRow,
  type LeakRow,
  type PointRow,
  type ReadingRow,
  type SyncJobRow
} from '@/utils/db'
import { judgeReading, round } from '@/utils/range'
import type { ConflictParty, ConflictType, ExternalEntryResult, SyncResult } from '@/types/sync'
import type { SyncJobPayload } from '@/types/sync'
import type { Reading } from '@/types/reading'

/** 外检合格阈值（与泄漏复检一致，ppm） */
const LEAK_PASS_PPM = 50

/** 绝对差异下限：低于该值（按各单位）视为同一读数，不生成冲突 */
const ABS_DIFF_FLOOR: Record<string, number> = {
  ppm: 1,
  MPa: 0.005,
  kPa: 1,
  '℃': 0.5,
  'm³/h': 1
}

function readingFromPayload(job: SyncJobRow): ReadingRow {
  const p = job.payload
  const judgement = judgeReading(p.value, p.standardMin, p.standardMax, p.isCritical)
  return {
    id: job.readingId,
    patrolId: p.patrolId,
    pointId: p.pointId,
    value: p.value,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    note: p.note,
    source: '巡检班',
    verifyStatus: '已核实',
    frozen: false,
    conflictId: null,
    syncJobId: job.id,
    standardMinAtEntry: p.standardMin,
    standardMaxAtEntry: p.standardMax,
    isCriticalAtEntry: p.isCritical,
    standardRevision: p.standardRevision,
    createdAt: p.recordedAt,
    updatedAt: Date.now(),
    revision: 3
  }
}

/**
 * 两版值是否存在需要裁决的显著差异：
 * 超过按单位设定的绝对差下限（浓度 1 ppm、压力 0.005 MPa 等）即视为两版值，保留两版待核查。
 */
export function isMaterialDiff(a: number, b: number, unit = 'ppm'): boolean {
  const floor = ABS_DIFF_FLOOR[unit] ?? 0.001
  return Math.abs(a - b) >= floor
}

/**
 * 检测外检值与该点位既有处置单的冲突：
 * - 外检合格(≤50) 但存在超标处置单（浓度>50）；或
 * - 外检超标(>50) 但处置单已复检合格闭环。
 * 只检测未决冲突，已裁决冲突不重复生成。
 */
async function detectLeakConflicts(input: {
  point: PointRow
  externalReading: ReadingRow
  existingOpenConflictIds: Set<string>
}): Promise<ConflictRow[]> {
  const { point, externalReading } = input
  const leaks = await db.leaks.where('deviceId').equals(point.deviceId).toArray()
  const externalPass = externalReading.value <= LEAK_PASS_PPM
  const created: ConflictRow[] = []
  const now = Date.now()

  for (const leak of leaks) {
    if (leak.conflictId && input.existingOpenConflictIds.has(leak.conflictId)) continue
    // 仅当处置单源自同一点位时才构成「外检值与处置单冲突」，避免把设备上其他点位的处置单误并入
    if (leak.sourceReadingId) {
      const sourceReading = await db.readings.get(leak.sourceReadingId)
      if (!sourceReading || sourceReading.pointId !== point.id) continue
    }
    const leakPass = leak.concentrationPpm <= LEAK_PASS_PPM
    const closed = leak.state === '已复检'
    const contradict = externalPass ? !leakPass : closed && leakPass
    if (!contradict) continue

    const sourceReading = leak.sourceReadingId ? await db.readings.get(leak.sourceReadingId) : undefined

    const conflict: ConflictRow = {
      id: createId('cf'),
      type: '外检与处置单冲突',
      status: '未决',
      pointId: point.id,
      deviceId: point.deviceId,
      stationId: point.stationId,
      syncJobId: null,
      fieldReadingId: leak.sourceReadingId,
      externalReadingId: externalReading.id,
      fieldValue: sourceReading ? sourceReading.value : leak.concentrationPpm,
      externalValue: externalReading.value,
      leakId: leak.id,
      leakRef: { leakConcentrationPpm: leak.concentrationPpm, leakState: leak.state },
      diffValue: round(Math.abs(externalReading.value - leak.concentrationPpm)),
      chosenSource: null,
      decidedBy: '',
      decisionNote: '',
      affectedLabel: '',
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      revision: 3
    }
    conflict.affectedLabel = buildLeakConflictLabel(point, leak, externalReading.value)
    created.push(conflict)
  }
  return created
}

function buildLeakConflictLabel(point: PointRow, leak: LeakRow, externalValue: number): string {
  return `${point.name}：外检原值 ${externalValue} ppm 与处置单（${leak.concentrationPpm} ppm · ${leak.state}）矛盾，保留差异，未裁决前不能完成闭环（受影响处置单 1 张）`
}

function buildDoubleValueLabel(point: PointRow, fieldValue: number, externalValue: number): string {
  return `${point.name}：现场值 ${fieldValue} 与外检原值 ${externalValue} 并存，现场值待核查，外检原值保留（受影响读数 2 条）`
}

/* ====================== 巡检班：断网暂存 → 恢复合并 ====================== */

/** 现场录入入队：断网暂存为待同步任务；联网时立即合并。readingId 在入队时确定（幂等）。 */
export async function enqueueFieldReading(input: {
  patrolId: string
  point: PointRow
  value: number
  note: string
  online: boolean
}): Promise<{ job: SyncJobRow; result: SyncResult | null }> {
  const now = Date.now()
  const job: SyncJobRow = {
    id: createId('jb'),
    state: '待同步',
    readingId: createId('rd'),
    stationId: input.point.stationId,
    deviceId: input.point.deviceId,
    pointId: input.point.id,
    payload: {
      patrolId: input.patrolId,
      pointId: input.point.id,
      stationId: input.point.stationId,
      value: input.value,
      note: input.note,
      standardMin: input.point.standardMin,
      standardMax: input.point.standardMax,
      isCritical: input.point.isCritical,
      standardRevision: input.point.standardRevision,
      recordedAt: now
    },
    attempts: 0,
    lastError: '',
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
    revision: 3
  }
  await db.syncjobs.put(job)
  if (!input.online) {
    return { job, result: null }
  }
  const result = await processSyncJob(job.id)
  return { job, result }
}

/**
 * 执行一次合并任务（可对失败任务重试）。
 * 事务内：幂等写入读数 → 双版值冲突 → 外检与处置单冲突 → 任务置已合并。
 */
export async function processSyncJob(jobId: string): Promise<SyncResult> {
  const job = await db.syncjobs.get(jobId)
  if (!job) {
    return { ok: false, readingId: '', conflictId: null, conflictType: null, verifyStatus: '已核实', error: '合并任务不存在' }
  }
  if (job.state === '已合并') {
    const existed = await db.readings.get(job.readingId)
    return {
      ok: true,
      readingId: job.readingId,
      conflictId: existed?.conflictId ?? null,
      conflictType: null,
      verifyStatus: existed?.verifyStatus ?? '已核实'
    }
  }

  try {
    const result = await db.transaction(
      'rw',
      [db.syncjobs, db.points, db.patrols, db.readings, db.leaks, db.conflicts],
      async (): Promise<SyncResult> => {
        const liveJob = await db.syncjobs.get(jobId)
        if (!liveJob) throw new Error('合并任务已被删除')
        const point = await db.points.get(liveJob.pointId)
        if (!point) throw new Error('点位已删除，无法按设备/点位合并')
        const patrol = await db.patrols.get(liveJob.payload.patrolId)
        if (!patrol) throw new Error('巡检任务已删除，无法归并现场读数')

        // 幂等：读数已存在则不重复写
        let reading = await db.readings.get(liveJob.readingId)
        let conflictId: string | null = null
        let conflictType: ConflictType | null = null
        let verifyStatus: Reading['verifyStatus'] = '已核实'

        // 同一点位已冻结的外检原值（取最近一条）
        const external = (
          await db.readings.where('pointId').equals(point.id).toArray()
        )
          .filter((r) => r.source === '外检班' && r.frozen && r.id !== liveJob.readingId)
          .sort((a, b) => b.createdAt - a.createdAt)[0]

        if (!reading) {
          reading = readingFromPayload(liveJob)
          const now = Date.now()
          if (external && isMaterialDiff(liveJob.payload.value, external.value, point.unit)) {
            verifyStatus = '待核查'
            reading.verifyStatus = '待核查'
            const conflict: ConflictRow = {
              id: createId('cf'),
              type: '两版值冲突',
              status: '未决',
              pointId: point.id,
              deviceId: point.deviceId,
              stationId: point.stationId,
              syncJobId: liveJob.id,
              fieldReadingId: reading.id,
              externalReadingId: external.id,
              fieldValue: reading.value,
              externalValue: external.value,
              leakId: null,
              leakRef: null,
              diffValue: round(Math.abs(reading.value - external.value)),
              chosenSource: null,
              decidedBy: '',
              decisionNote: '',
              affectedLabel: buildDoubleValueLabel(point, reading.value, external.value),
              createdAt: now,
              updatedAt: now,
              decidedAt: null,
              revision: 3
            }
            await db.conflicts.put(conflict)
            reading.conflictId = conflict.id
            conflictId = conflict.id
            conflictType = conflict.type
          }
          await db.readings.put(reading)
        } else {
          conflictId = reading.conflictId
          verifyStatus = reading.verifyStatus
        }

        // 外检与处置单冲突（本现场读数派生出的处置单也纳入）
        if (external) {
          const openConflicts = (await db.conflicts.where('status').equals('未决').toArray())
            .filter((c) => c.leakId)
          const openLeakConflictIds = new Set(openConflicts.map((c) => c.leakId as string))
          const leakConflicts = await detectLeakConflicts({
            point,
            externalReading: external,
            existingOpenConflictIds: openLeakConflictIds
          })
          for (const conflict of leakConflicts) {
            await db.conflicts.put(conflict)
            if (conflict.leakId) {
              await db.leaks.update(conflict.leakId, { conflictId: conflict.id, updatedAt: Date.now() })
            }
          }
        }

        await db.syncjobs.update(liveJob.id, {
          state: '已合并',
          attempts: liveJob.attempts + 1,
          lastError: '',
          syncedAt: Date.now(),
          updatedAt: Date.now()
        })

        return { ok: true, readingId: reading.id, conflictId, conflictType, verifyStatus }
      }
    )
    return result
  } catch (error) {
    // 事务已整体回滚；在独立写入中保留「合并失败」状态与原因，保证失败任务可重试
    const message = error instanceof Error ? error.message : '合并失败，可重试'
    const prev = await db.syncjobs.get(jobId)
    if (prev) {
      await db.syncjobs.update(jobId, {
        state: '合并失败',
        attempts: (prev.attempts ?? 0) + 1,
        lastError: message,
        updatedAt: Date.now()
      })
    }
    return {
      ok: false,
      readingId: job.readingId,
      conflictId: null,
      conflictType: null,
      verifyStatus: '已核实',
      error: message
    }
  }
}

/** 恢复联网后排空队列：先对待同步/失败任务逐条合并，返回处理条数 */
export async function flushSyncJobs(): Promise<{ processed: number; failed: number; results: SyncResult[] }> {
  const jobs = (await db.syncjobs.toArray())
    .filter((job) => job.state === '待同步' || job.state === '合并失败')
    .sort((a, b) => a.createdAt - b.createdAt)
  const results: SyncResult[] = []
  let failed = 0
  for (const job of jobs) {
    const result = await processSyncJob(job.id)
    results.push(result)
    if (!result.ok) failed += 1
  }
  return { processed: jobs.length, failed, results }
}

/* ====================== 外检班：在线直接录入（原值冻结） ====================== */

/**
 * 外检班录入：只能在线调用。外检原值 frozen，永不覆盖既有外检值（同点位同日直接追加一条新版本）。
 * 若同点位已有现场值则生成两版值冲突；同时检测与既有处置单的冲突。
 */
export async function submitExternalReading(input: {
  patrolId: string
  point: PointRow
  value: number
  note: string
  foundDate?: string
}): Promise<ExternalEntryResult> {
  const { point } = input
  const now = Date.now()
  const judgement = judgeReading(input.value, point.standardMin, point.standardMax, point.isCritical)

  return db.transaction(
    'rw',
    [db.readings, db.points, db.patrols, db.leaks, db.conflicts],
    async (): Promise<ExternalEntryResult> => {
      const readingId = createId('rd')
      // 同点位现场值（取最近一条）
      const field = (
        await db.readings.where('pointId').equals(point.id).toArray()
      )
        .filter((r) => r.source === '巡检班')
        .sort((a, b) => b.createdAt - a.createdAt)[0]

      let verifyStatus: Reading['verifyStatus'] = '已核实'
      let conflictId: string | null = null

      const reading: ReadingRow = {
        id: readingId,
        patrolId: input.patrolId,
        pointId: point.id,
        value: input.value,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        note: input.note,
        source: '外检班',
        verifyStatus,
        frozen: true,
        conflictId: null,
        syncJobId: null,
        standardMinAtEntry: point.standardMin,
        standardMaxAtEntry: point.standardMax,
        isCriticalAtEntry: point.isCritical,
        standardRevision: point.standardRevision,
        createdAt: now,
        updatedAt: now,
        revision: 3
      }
      await db.readings.put(reading)

      // 两版值冲突：现场值与新外检值显著不同，且该现场值没有未决两版冲突
      if (field && isMaterialDiff(field.value, input.value, point.unit)) {
        const hasOpenDouble = (await db.conflicts.where('status').equals('未决').toArray()).some(
          (c) => c.type === '两版值冲突' && c.fieldReadingId === field.id
        )
        if (!hasOpenDouble) {
          verifyStatus = '已核实'
          const conflict: ConflictRow = {
            id: createId('cf'),
            type: '两版值冲突',
            status: '未决',
            pointId: point.id,
            deviceId: point.deviceId,
            stationId: point.stationId,
            syncJobId: null,
            fieldReadingId: field.id,
            externalReadingId: reading.id,
            fieldValue: field.value,
            externalValue: reading.value,
            leakId: null,
            leakRef: null,
            diffValue: round(Math.abs(field.value - reading.value)),
            chosenSource: null,
            decidedBy: '',
            decisionNote: '',
            affectedLabel: buildDoubleValueLabel(point, field.value, reading.value),
            createdAt: now,
            updatedAt: now,
            decidedAt: null,
            revision: 3
          }
          await db.conflicts.put(conflict)
          await db.readings.update(field.id, {
            verifyStatus: '待核查',
            conflictId: conflict.id,
            updatedAt: now
          })
          await db.readings.update(reading.id, { conflictId: conflict.id, updatedAt: now })
          conflictId = conflict.id
        }
      }

      // 外检与处置单冲突（始终以本次录入的新外检原值为准检测）
      const openConflicts = (await db.conflicts.where('status').equals('未决').toArray()).filter((c) => c.leakId)
      const openLeakConflictIds = new Set(openConflicts.map((c) => c.leakId as string))
      const leakConflicts = await detectLeakConflicts({
        point,
        externalReading: reading,
        existingOpenConflictIds: openLeakConflictIds
      })
      const leakConflictIds: string[] = []
      for (const conflict of leakConflicts) {
        conflict.externalReadingId = reading.id
        conflict.externalValue = reading.value
        await db.conflicts.put(conflict)
        if (conflict.leakId) {
          await db.leaks.update(conflict.leakId, { conflictId: conflict.id, updatedAt: now })
          leakConflictIds.push(conflict.id)
        }
      }

      return { readingId, conflictId, leakConflictIds, verifyStatus }
    }
  )
}

/* ====================== 负责人裁决 ====================== */

/**
 * 负责人裁决冲突，选择事实来源。
 * - 两版值冲突：被采纳读数置「已核实」，未采纳现场读数置「未采纳」；读数两版均保留。
 * - 外检与处置单冲突：不改任何浓度原值，只记录裁决来源并解除处置单闭环阻塞。
 */
export async function decideConflict(input: {
  conflictId: string
  chosenSource: ConflictParty
  decidedBy: string
  decisionNote: string
}): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.readings, db.leaks], async () => {
    const conflict = await db.conflicts.get(input.conflictId)
    if (!conflict) throw new Error('冲突不存在或已被删除')
    if (conflict.status !== '未决') throw new Error('该冲突已裁决，不能重复操作')
    const now = Date.now()

    await db.conflicts.update(conflict.id, {
      status: '已裁决',
      chosenSource: input.chosenSource,
      decidedBy: input.decidedBy.trim() || '未署名',
      decisionNote: input.decisionNote.trim(),
      decidedAt: now,
      updatedAt: now
    })

    if (conflict.type === '两版值冲突') {
      const adopted = input.chosenSource === '巡检班' ? conflict.fieldReadingId : conflict.externalReadingId
      const rejected = input.chosenSource === '巡检班' ? conflict.externalReadingId : conflict.fieldReadingId
      if (adopted) {
        await db.readings.update(adopted, { verifyStatus: '已核实', conflictId: conflict.id, updatedAt: now })
      }
      if (rejected) {
        const rejectedReading = await db.readings.get(rejected)
        // 外检原值永不改状态/不删除，仅现场值可标未采纳
        if (rejectedReading && rejectedReading.source === '巡检班') {
          await db.readings.update(rejected, { verifyStatus: '未采纳', conflictId: conflict.id, updatedAt: now })
        }
      }
    } else if (conflict.type === '外检与处置单冲突' && conflict.leakId) {
      // 解除处置单闭环阻塞，处置单与读数原值均保留不变
      await db.leaks.update(conflict.leakId, { updatedAt: now })
    }
  })
}

/** 忽略冲突（保留差异但暂不裁决）；同样解除处置单闭环阻塞，仍可在事后重新打开 */
export async function ignoreConflict(conflictId: string, decidedBy: string): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.leaks], async () => {
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict) throw new Error('冲突不存在')
    if (conflict.status !== '未决') throw new Error('该冲突已处理')
    await db.conflicts.update(conflictId, {
      status: '已忽略',
      decidedBy: decidedBy.trim() || '未署名',
      decidedAt: Date.now(),
      updatedAt: Date.now()
    })
  })
}

/** 重新打开已裁决/已忽略冲突（恢复未决）；处置单重新进入阻塞 */
export async function reopenConflict(conflictId: string): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.readings, db.leaks], async () => {
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict || conflict.status === '未决') return
    const now = Date.now()
    await db.conflicts.update(conflictId, {
      status: '未决',
      chosenSource: null,
      decidedBy: '',
      decisionNote: '',
      decidedAt: null,
      updatedAt: now
    })
    if (conflict.type === '两版值冲突') {
      if (conflict.fieldReadingId) {
        await db.readings.update(conflict.fieldReadingId, {
          verifyStatus: '待核查',
          conflictId,
          updatedAt: now
        })
      }
      if (conflict.externalReadingId) {
        await db.readings.update(conflict.externalReadingId, { conflictId, updatedAt: now })
      }
    } else if (conflict.leakId) {
      await db.leaks.update(conflict.leakId, { conflictId, updatedAt: now })
    }
  })
}

/** 删除一条合并失败/待同步的暂存任务（已合并任务保留作审计，不允许删） */
export async function discardSyncJob(jobId: string): Promise<void> {
  const job = await db.syncjobs.get(jobId)
  if (!job) return
  if (job.state === '已合并') return
  await db.syncjobs.delete(jobId)
}

export type { SyncJobPayload }
