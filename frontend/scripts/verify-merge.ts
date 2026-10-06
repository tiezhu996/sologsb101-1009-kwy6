/* eslint-disable no-console */
/**
 * 临时验证脚本：双班组暂存 → 合并 → 冲突 → 裁决 → 拦截 的端到端逻辑。
 * 通过 fake-indexeddb 在 Node 中跑 Dexie，不依赖浏览器。
 */
import 'fake-indexeddb/auto'
import { db } from '../src/utils/db'
import { mergePendingReadings, resolveConflict } from '../src/utils/merge'
import { judgeReading } from '../src/utils/range'
import type { Reading } from '../src/types/reading'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.error(`  ✗ ${msg}`)
  }
}

async function seedBase(): Promise<void> {
  const now = Date.now()
  await db.stations.put({ id: 's1', name: '站1', location: '', designFlowM3h: 1, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '', createdAt: now, updatedAt: now })
  await db.devices.put({ id: 'd1', stationId: 's1', type: '调压器', model: 'M', serialNo: 'X', installDate: '', state: '运行', createdAt: now, updatedAt: now })
  await db.points.put({ id: 'p1', deviceId: 'd1', stationId: 's1', name: '浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, standardRevision: 1, createdAt: now, updatedAt: now })
  await db.points.put({ id: 'p2', deviceId: 'd1', stationId: 's1', name: '压力', standardMin: 0.1, standardMax: 0.2, unit: 'MPa', isCritical: false, standardRevision: 1, createdAt: now, updatedAt: now })
  await db.patrols.put({ id: 'pa1', stationId: 's1', planDate: '2024-06-01', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: now, updatedAt: now })
}

async function putLocal(over: Partial<Reading> & { id: string; pointId: string; value: number; source: Reading['source'] }): Promise<void> {
  const point = await db.points.get(over.pointId)
  const j = judgeReading(over.value, point!.standardMin, point!.standardMax, point!.isCritical)
  const now = Date.now()
  await db.readings.put({
    patrolId: 'pa1',
    isAbnormal: j.isAbnormal,
    deviationPct: j.deviationPct,
    note: '',
    standardRevision: point!.standardRevision,
    standardMinAtEntry: point!.standardMin,
    standardMaxAtEntry: point!.standardMax,
    isCriticalAtEntry: point!.isCritical,
    batchNo: point!.standardRevision,
    syncState: 'local',
    verifyState: over.source === 'site' ? 'pending' : 'none',
    syncedAt: 0,
    lastError: '',
    conflictId: '',
    createdAt: now,
    updatedAt: now,
    ...over
  })
}

async function main(): Promise<void> {
  await seedBase()

  // 1. 单边暂存 → 合并 synced
  await putLocal({ id: 'r1', pointId: 'p2', value: 0.15, source: 'site' })
  const res1 = await mergePendingReadings()
  assert(res1.merged === 1 && res1.conflicts === 0, '单边现场值合并为 synced')
  assert((await db.readings.get('r1'))!.syncState === 'synced', 'r1 已合并')

  // 2. 断网暂存两条（同点双值）→ 恢复后合并出 dual-reading 冲突，两版都保留
  await putLocal({ id: 'r2', pointId: 'p1', value: 60, source: 'site' })
  await putLocal({ id: 'r3', pointId: 'p1', value: 75, source: 'external' })
  const res2 = await mergePendingReadings()
  assert(res2.conflicts >= 1, '同点双值合并产生冲突')
  const conflict = await db.conflicts.where('pointId').equals('p1').first()
  assert(!!conflict && conflict!.type === 'dual-reading' && conflict!.status === 'open', 'dual-reading 未决冲突已建')
  assert(conflict!.sides.length === 2, '两版值都保留')
  assert((await db.readings.get('r2'))!.verifyState === 'pending', '现场值标记待核查')
  assert((await db.readings.get('r3'))!.value === 75 && (await db.readings.get('r3'))!.syncState === 'conflict', '外检原值 75 保留不丢')

  // 3. 外检值与处置单冲突 → 拦截
  const now = Date.now()
  await db.leaks.put({ id: 'lk1', deviceId: 'd1', stationId: 's1', concentrationPpm: 40, foundTime: '2024-06-02', measure: '', state: '待处置', retestValuePpm: 0, handler: '', blockedByConflict: '', factReadingId: '', createdAt: now, updatedAt: now })
  await putLocal({ id: 'r4', pointId: 'p1', value: 90, source: 'external' })
  await mergePendingReadings()
  const lkAfter = await db.leaks.get('lk1')
  assert(!!lkAfter!.blockedByConflict, '外检值与处置单冲突时处置单被拦截')
  const leakConflict = (await db.conflicts.where('leakId').equals('lk1').toArray())[0]
  assert(!!leakConflict && leakConflict.type === 'leak-mismatch', 'leak-mismatch 冲突已建')
  assert(leakConflict.affectedLeakIds.includes('lk1') && leakConflict.affectedReadingIds.includes('r4'), '受影响记录已记录（读数 + 处置单）')

  // 4. 裁决后解除拦截，浓度更新，两版保留
  await resolveConflict({ conflictId: leakConflict.id, chosenSource: 'external', decidedBy: '负责人甲', decisionNote: '采信外检' })
  const lkResolved = await db.leaks.get('lk1')
  assert(lkResolved!.blockedByConflict === '', '裁决后处置单解除拦截')
  assert(lkResolved!.concentrationPpm === 90 && lkResolved!.factReadingId === 'r4', '按外检原值更新处置单浓度')
  const cfResolved = await db.conflicts.get(leakConflict.id)
  assert(cfResolved!.status === 'resolved' && cfResolved!.decidedBy === '负责人甲', '冲突已裁决并留痕')
  assert((await db.readings.get('r4'))!.syncState === 'resolved', '外检读数保留为已裁决（不删除）')

  // 5. 失败可重试：simulateFailure 第一次失败、第二次成功
  await putLocal({ id: 'r5', pointId: 'p2', value: 0.15, source: 'external' })
  let attempts = 0
  const failOnce = (): string => {
    attempts += 1
    return attempts === 1 ? '模拟合并超时' : ''
  }
  const f1 = await mergePendingReadings(['r5'], failOnce)
  assert(f1.failed === 1, '合并失败标记 failed 且数据保留')
  assert((await db.readings.get('r5'))!.syncState === 'failed', 'r5 failed')
  const f2 = await mergePendingReadings(['r5'], failOnce)
  assert(f2.merged === 1, '重试后合并成功')

  // 6. 标准版本冻结：改标准不翻历史
  await db.points.update('p1', { standardMax: 60, standardRevision: 2, updatedAt: Date.now() })
  const oldR3 = await db.readings.get('r3')
  assert(oldR3!.standardRevision === 1 && oldR3!.standardMaxAtEntry === 50, '历史读数冻结 v1 标准（上限 50）')
  await putLocal({ id: 'r6', pointId: 'p1', value: 55, source: 'site' })
  await mergePendingReadings(['r6'], () => '')
  const newR6 = await db.readings.get('r6')
  assert(newR6!.standardRevision === 2 && newR6!.standardMaxAtEntry === 60, '新批次按 v2 标准判级（上限 60）')
  assert(newR6!.isAbnormal === false, '55 ppm 在 v2（≤60）下判正常，而历史 r3 仍异常')
  assert(oldR3!.isAbnormal === true, '历史异常 r3 不因标准修改翻案')

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
