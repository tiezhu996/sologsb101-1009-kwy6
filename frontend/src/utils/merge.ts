/**
 * 双班组读数合并引擎（断网恢复后调用）
 *
 * 规则：
 * 1. 巡检班 / 外检班各记一份，断网时读数以 local/failed 暂存本地，恢复网络后重试合并。
 * 2. 按「设备 + 点位」（同一巡检任务内）合并：
 *    - 仅一个班组有值 → synced；
 *    - 同一点位两边都有值且数值不同 → 保留两版，建 dual-reading 冲突，现场值 pending 待核查，外检原值不动；
 *      数值一致 → 两版均 synced。
 * 3. 外检值与已派处置单记载浓度不一致 → 建 leak-mismatch 冲突并拦截处置单，未决前不能完成。
 * 4. 合并失败（模拟）保留 failed + 原因，可原样重试，不丢数据。
 */
import { createId, db, type ConflictRow, type ReadingRow } from '@/utils/db'
import type { Conflict, ConflictSide, ConflictType } from '@/types/conflict'
import type { ReadingSource } from '@/types/source'
import { abnormalLevelOf, concentrationGapPpm, isValueConflict } from '@/utils/range'

/** ppm 点位外检值与处置单浓度差异超过该阈值视为冲突 */
export const LEAK_MISMATCH_TOLERANCE_PPM = 0

export interface MergeItemResult {
  readingId: string
  state: ReadingRow['syncState']
  conflictId: string
  error: string
}

export interface MergeResult {
  merged: number
  conflicts: number
  failed: number
  items: MergeItemResult[]
  conflictIds: string[]
}

/** 断网时：保存失败 → local（暂存待合并）；在线时读数直接落 synced */
export function shouldQueueOffline(offline: boolean): boolean {
  return offline
}

function sideOf(reading: ReadingRow): ConflictSide {
  return {
    source: reading.source,
    readingId: reading.id,
    value: reading.value,
    isAbnormal: reading.isAbnormal,
    levelText: abnormalLevelOf(reading.deviationPct, reading.isCriticalAtEntry),
    note: reading.note,
    recordedAt: new Date(reading.createdAt).toISOString().slice(0, 10)
  }
}

function groupKey(reading: ReadingRow): string {
  return `${reading.patrolId}#${reading.pointId}`
}

/** 模拟合并失败：调用方可注入失败条件（如仍处于断网） */
export type MergeFailureSimulator = (reading: ReadingRow) => string

export const failWhenOffline =
  (offline: boolean): MergeFailureSimulator =>
  () =>
    offline ? '现场网络仍中断，合并未完成；网络恢复后可重试，暂存读数不会丢失' : ''

/**
 * 合并一批暂存读数（local / failed）。
 * @param readingIds 指定要合并的读数；为空时合并全部 local/failed。
 * @param simulateFailure 失败条件模拟，返回非空错误信息则该条标记 failed。
 */
export async function mergePendingReadings(
  readingIds: string[] = [],
  simulateFailure: MergeFailureSimulator = () => ''
): Promise<MergeResult> {
  const pendingAll = await db.readings
    .where('syncState')
    .anyOf('local', 'failed')
    .toArray()
  const pending = readingIds.length > 0 ? pendingAll.filter((row) => readingIds.includes(row.id)) : pendingAll
  const now = Date.now()

  const result: MergeResult = { merged: 0, conflicts: 0, failed: 0, items: [], conflictIds: [] }
  if (pending.length === 0) return result

  // 同组内已落库的两班读数（含历史 synced / conflict / resolved），用于检测另一边是否已有值
  const groups = new Map<string, ReadingRow[]>()
  const allOfPatrols = await db.readings
    .where('patrolId')
    .anyOf([...new Set(pending.map((row) => row.patrolId))])
    .toArray()
  allOfPatrols.forEach((row) => {
    const key = groupKey(row)
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  })

  // 已经打开的冲突，避免重复建单
  const openConflicts = await db.conflicts.where('status').equals('open').toArray()

  for (const incoming of pending) {
    const failureReason = simulateFailure(incoming)
    if (failureReason) {
      await db.readings.update(incoming.id, {
        syncState: 'failed',
        lastError: failureReason,
        updatedAt: now
      })
      result.failed += 1
      result.items.push({ readingId: incoming.id, state: 'failed', conflictId: '', error: failureReason })
      continue
    }

    const siblings = (groups.get(groupKey(incoming)) ?? []).filter(
      (row) => row.id !== incoming.id
    )

    // 已裁决组：同班组原值更新（修正读数）保持已裁决，不把历史冲突翻回未决
    const resolvedConflict = (await db.conflicts
      .where('pointId')
      .equals(incoming.pointId)
      .toArray())
      .filter((conflict) => conflict.status === 'resolved')
      .find(
        (conflict) =>
          conflict.patrolId === incoming.patrolId &&
          conflict.affectedReadingIds.some((id) => siblings.some((sibling) => sibling.id === id))
      )
    if (resolvedConflict) {
      await db.readings.update(incoming.id, {
        syncState: 'resolved',
        verifyState: incoming.source === 'site' ? resolvedConflict.chosenSource === 'site' ? 'confirmed' : 'discarded' : 'none',
        conflictId: resolvedConflict.id,
        syncedAt: now,
        lastError: '',
        updatedAt: now
      })
      result.merged += 1
      result.items.push({ readingId: incoming.id, state: 'resolved', conflictId: resolvedConflict.id, error: '' })
      continue
    }

    // 已存在未决冲突且卷入该组 → 新读数并入该冲突，不再重复建单
    const existingOpen = openConflicts.find(
      (conflict) =>
        conflict.status === 'open' &&
        conflict.pointId === incoming.pointId &&
        (conflict.patrolId === incoming.patrolId ||
          siblings.some((s) => conflict.affectedReadingIds.includes(s.id)))
    )

    // 同点另一班的值（不含同班组重复值）
    const otherSide = siblings.find((row) => row.source !== incoming.source)

    let nextState: ReadingRow['syncState'] = 'synced'
    let nextVerify = incoming.verifyState
    let conflictId = ''

    if (existingOpen) {
      conflictId = existingOpen.id
      nextState = 'conflict'
      nextVerify = incoming.source === 'site' ? 'pending' : 'none'
    } else if (otherSide && isValueConflict(otherSide.value, incoming.value)) {
      const siteReading = incoming.source === 'site' ? incoming : otherSide.source === 'site' ? otherSide : null
      const externalReading = incoming.source === 'external' ? incoming : otherSide.source === 'external' ? otherSide : null
      if (siteReading && externalReading) {
        const conflict = await createDualReadingConflict(siteReading, externalReading, now)
        conflictId = conflict.id
        nextState = 'conflict'
        nextVerify = incoming.source === 'site' ? 'pending' : 'none'
        openConflicts.push(conflict)
        result.conflictIds.push(conflict.id)
        result.conflicts += 1
      }
    }

    // 外检浓度与处置单记载比对（仅 ppm 点位、外检班值）；
    // 即便已经卷入同点双值冲突，与处置单的差异仍要单独建单保留
    if (incoming.source === 'external') {
      const leakConflict = await detectLeakMismatch(incoming, siblings, now)
      if (leakConflict) {
        conflictId = leakConflict.id
        nextState = 'conflict'
        openConflicts.push(leakConflict)
        result.conflictIds.push(leakConflict.id)
        result.conflicts += 1
      }
    }

    await db.readings.update(incoming.id, {
      syncState: nextState,
      verifyState: nextVerify,
      conflictId,
      syncedAt: now,
      lastError: '',
      updatedAt: now
    })
    if (nextState === 'synced') result.merged += 1
    result.items.push({ readingId: incoming.id, state: nextState, conflictId, error: '' })
  }

  return result
}

async function createDualReadingConflict(
  site: ReadingRow,
  external: ReadingRow,
  now: number
): Promise<ConflictRow> {
  const point = await db.points.get(site.pointId)
  const device = point ? await db.devices.get(point.deviceId) : undefined
  const leak = device
    ? (await db.leaks
        .where('deviceId')
        .equals(device.id)
        .toArray())
        .find((item) => item.state !== '已复检')
    : undefined

  const conflict: ConflictRow = {
    id: createId('cf'),
    type: 'dual-reading',
    status: 'open',
    stationId: point?.stationId ?? '',
    deviceId: site.pointId ? point?.deviceId ?? '' : '',
    pointId: site.pointId,
    patrolId: site.patrolId,
    leakId: leak?.id ?? '',
    leakConcentrationPpm: leak?.concentrationPpm ?? 0,
    sides: [sideOf(site), sideOf(external)],
    affectedReadingIds: [site.id, external.id],
    affectedLeakIds: leak ? [leak.id] : [],
    originText: `巡检班现场值 ${site.value} 与外检班原值 ${external.value}${point ? ` ${point.unit}` : ''} 同点并存（${
      device ? `${device.type} ${device.model}` : '未知设备'
    } · ${point?.name ?? '点位已删除'}），外检原值保留不丢，现场值待核查。`,
    chosenSource: '',
    decidedBy: '',
    decidedAt: 0,
    decisionNote: '',
    createdAt: now,
    updatedAt: now,
    revision: 3
  }
  await db.conflicts.put(conflict)

  // 双方读数挂接冲突；现场值置待核查
  await db.readings.update(site.id, { syncState: 'conflict', verifyState: 'pending', conflictId: conflict.id, updatedAt: now })
  await db.readings.update(external.id, { syncState: 'conflict', verifyState: 'none', conflictId: conflict.id, updatedAt: now })

  if (leak) {
    await db.leaks.update(leak.id, { blockedByConflict: conflict.id, updatedAt: now })
  }
  return conflict
}

async function detectLeakMismatch(
  incoming: ReadingRow,
  siblings: ReadingRow[],
  now: number
): Promise<ConflictRow | null> {
  const point = await db.points.get(incoming.pointId)
  if (!point || point.unit !== 'ppm') return null
  const device = await db.devices.get(point.deviceId)
  if (!device) return null
  const leaks = await db.leaks.where('deviceId').equals(device.id).toArray()
  const leak =
    leaks.find((item) => concentrationGapPpm(incoming.value, item.concentrationPpm) > LEAK_MISMATCH_TOLERANCE_PPM) ??
    null
  if (!leak) return null
  // 同一处置单已有未决的「外检值与处置单冲突」才跳过；同点双值冲突是另一张单，不能吞掉本条差异
  const duplicated = await db.conflicts
    .where('leakId')
    .equals(leak.id)
    .toArray()
  if (duplicated.some((conflict) => conflict.type === 'leak-mismatch' && conflict.status === 'open')) return null

  const siteReading =
    siblings.find((row) => row.source === 'site') ??
    (await db.readings
      .where('pointId')
      .equals(incoming.pointId)
      .toArray())
      .find((row) => row.source === 'site' && Number.isFinite(row.value))

  const sides: ConflictSide[] = []
  if (siteReading) sides.push(sideOf(siteReading))
  sides.push(sideOf(incoming))

  const affectedReadingIds = [
    ...new Set([...(siteReading ? [siteReading.id] : []), incoming.id, ...siblings.map((row) => row.id)])
  ]

  const conflict: ConflictRow = {
    id: createId('cf'),
    type: 'leak-mismatch',
    status: 'open',
    stationId: point.stationId,
    deviceId: device.id,
    pointId: point.id,
    patrolId: incoming.patrolId,
    leakId: leak.id,
    leakConcentrationPpm: leak.concentrationPpm,
    sides,
    affectedReadingIds,
    affectedLeakIds: [leak.id],
    originText: `外检班原值 ${incoming.value} ppm 与处置单记载浓度 ${leak.concentrationPpm} ppm 不一致（${device.type} ${device.model} · ${point.name}），差异保留，待负责人选择事实来源。`,
    chosenSource: '',
    decidedBy: '',
    decidedAt: 0,
    decisionNote: '',
    createdAt: now,
    updatedAt: now,
    revision: 3
  }
  await db.conflicts.put(conflict)
  await db.readings.update(incoming.id, { syncState: 'conflict', conflictId: conflict.id, updatedAt: now })
  if (siteReading) {
    await db.readings.update(siteReading.id, {
      syncState: 'conflict',
      verifyState: siteReading.verifyState === 'none' ? 'pending' : siteReading.verifyState,
      conflictId: conflict.id,
      updatedAt: now
    })
  }
  await db.leaks.update(leak.id, { blockedByConflict: conflict.id, updatedAt: now })
  return conflict
}

/* ============================ 冲突裁决 ============================ */

export interface ResolveConflictInput {
  conflictId: string
  /** 事实来源：site（现场值）/ external（外检原值）/ leak（以处置单记载为准） */
  chosenSource: Exclude<Conflict['chosenSource'], ''>
  decidedBy: string
  decisionNote: string
}

/**
 * 负责人裁决冲突：
 * - 冲突置 resolved，回填事实来源；两版读数都保留（外检原值不丢、现场值不删）；
 * - 现场值被采信 → confirmed，否则 discarded；外检版始终保留；
 * - 解除关联处置单拦截；若采信外检/现场值，按选定来源更新处置单浓度并回填 factReadingId。
 */
export async function resolveConflict(input: ResolveConflictInput): Promise<ConflictRow> {
  const conflict = await db.conflicts.get(input.conflictId)
  if (!conflict) throw new Error('冲突单不存在或已被删除')
  const now = Date.now()

  const chosenReadingId =
    input.chosenSource === 'leak'
      ? ''
      : conflict.sides.find((side) => side.source === (input.chosenSource as ReadingSource))?.readingId ?? ''

  const next: ConflictRow = {
    ...conflict,
    status: 'resolved',
    chosenSource: input.chosenSource,
    decidedBy: input.decidedBy.trim() || '未署名负责人',
    decidedAt: now,
    decisionNote: input.decisionNote.trim(),
    updatedAt: now
  }
  await db.conflicts.put(next)

  // 两版读数都保留，仅更新合并/核查状态
  for (const side of conflict.sides) {
    const patch: Partial<ReadingRow> = {
      syncState: 'resolved',
      conflictId: conflict.id,
      updatedAt: now
    }
    if (side.source === 'site') {
      patch.verifyState = input.chosenSource === 'site' ? 'confirmed' : 'discarded'
    }
    await db.readings.update(side.readingId, patch)
  }

  // 解除处置单拦截
  for (const leakId of conflict.affectedLeakIds) {
    const leak = await db.leaks.get(leakId)
    if (!leak) continue
    const chosenSide = conflict.sides.find((side) => side.readingId === chosenReadingId)
    await db.leaks.update(leakId, {
      blockedByConflict: '',
      factReadingId: chosenReadingId,
      concentrationPpm: chosenSide ? chosenSide.value : leak.concentrationPpm,
      updatedAt: now
    })
  }

  return next
}

/** 冲突类型 / 来源的展示辅助 */
export function conflictTypeLabel(type: ConflictType): string {
  return type === 'dual-reading' ? '同点双值' : '外检值与处置单冲突'
}
