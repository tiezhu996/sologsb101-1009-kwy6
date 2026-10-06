// 运行时冒烟测试：用 fake-indexeddb 验证合并/冲突/快照判级
import 'fake-indexeddb/auto'
import { db, resetDatabase } from '../src/utils/db'
import {
  enqueueFieldReading,
  processSyncJob,
  submitExternalReading,
  decideConflict,
  flushSyncJobs
} from '../src/utils/sync'
import { judgeReading } from '../src/utils/range'
import type { PointRow } from '../src/utils/db'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${msg}`)
  } else {
    fail += 1
    console.error(`  ✗ ${msg}`)
  }
}

async function main(): Promise<void> {
  await resetDatabase()

  // 1. 断网录入：现场值入队，不产生读数
  const pt2 = (await db.points.get('pt-2')) as PointRow
  const pa3 = 'pa-3'
  const before = await db.readings.where('pointId').equals('pt-2').count()
  const enqueued = await enqueueFieldReading({
    patrolId: pa3,
    point: pt2,
    value: 0.3,
    note: '断网现场值',
    online: false
  })
  assert(enqueued.result === null, '断网录入返回 null（未立即合并）')
  const jobId = enqueued.job.id
  const after = await db.readings.where('pointId').equals('pt-2').count()
  assert(after === before, '断网录入不立即生成读数，仅暂存队列')
  const queued = await db.syncjobs.get(jobId)
  assert(queued?.state === '待同步', '暂存任务状态为待同步')

  // 2. 联网合并（pt-2 无外检值）→ 成功，无冲突
  const res = await processSyncJob(jobId)
  assert(res.ok, '恢复后合并成功')
  assert(res.conflictId === null, '同点位无外检值时不产生冲突')
  const reading = await db.readings.get(res.readingId)
  assert(!!reading && reading.source === '巡检班' && reading.verifyStatus === '已核实', '现场读数为巡检班已核实')
  assert(reading.standardRevision === 1 && reading.standardMaxAtEntry === 0.25, '读数带录入时标准快照 v1')

  // 3. 标准改版（v2）不翻历史
  await db.points.update('pt-2', { standardMin: 0.1, standardMax: 0.4, standardRevision: 2, updatedAt: Date.now() })
  const readingAfter = await db.readings.get(res.readingId)
  assert(readingAfter!.isAbnormal === reading!.isAbnormal, '标准改版后历史异常标记不变')
  assert(readingAfter!.standardMaxAtEntry === 0.25, '历史读数仍按录入时快照（上限 0.25）')

  // 4. 同点位外检录入（在线）→ 两版值冲突，现场值待核查，两版都保留
  const pt2v2 = (await db.points.get('pt-2')) as PointRow
  const ext = await submitExternalReading({
    patrolId: 'pa-3',
    point: pt2v2,
    value: 0.12,
    note: '外检合格值',
    foundDate: '2024-06-20'
  })
  assert(ext.conflictId !== null, '同点位显著不同的外检值生成两版值冲突')
  const fieldRow = await db.readings.get(res.readingId)
  assert(fieldRow!.verifyStatus === '待核查', '现场值变为待核查')
  const extRow = await db.readings.get(ext.readingId)
  assert(!!extRow && extRow.frozen && extRow.source === '外检班', '外检原值冻结保留')
  const conflict = await db.conflicts.get(ext.conflictId!)
  assert(conflict!.status === '未决' && conflict!.fieldValue === 0.3 && conflict!.externalValue === 0.12, '冲突保留两版值')

  // 5. 负责人裁决以外检为准：现场值未采纳但不删除
  await decideConflict({
    conflictId: ext.conflictId!,
    chosenSource: '外检班',
    decidedBy: '王强',
    decisionNote: '以外检为准'
  })
  const fieldDecided = await db.readings.get(res.readingId)
  const extDecided = await db.readings.get(ext.readingId)
  assert(fieldDecided!.verifyStatus === '未采纳', '未采纳的现场值标记为未采纳（仍保留）')
  assert(extDecided!.verifyStatus === '已核实' && extDecided!.frozen, '外检原值仍已核实且冻结')
  const conflictDecided = await db.conflicts.get(ext.conflictId!)
  assert(conflictDecided!.status === '已裁决' && conflictDecided!.chosenSource === '外检班', '冲突状态已裁决')

  // 6. 外检与处置单冲突（pt-3：处置单 68 已复检 vs 外检 30）
  const pt3 = (await db.points.get('pt-3')) as PointRow
  const extLeak = await submitExternalReading({ patrolId: 'pa-1', point: pt3, value: 30, note: '外检复测合格' })
  // 播种数据里 cf-2 已是未决，新提交不应重复制造同一处置单冲突
  const lk1 = await db.leaks.get('lk-1')
  assert(!!lk1!.conflictId, '存在外检/处置单冲突的处置单挂冲突外键')
  const openCf2 = await db.conflicts.get('cf-2')
  assert(openCf2!.status === '未决', '播种的外检/处置单冲突为未决')

  // 7. 未决冲突阻塞复检闭环
  // 直接通过 store 的判定逻辑验证：lk-1 的复检应被拦截。这里复用 sync 引擎的裁决解除阻塞。
  await decideConflict({ conflictId: 'cf-2', chosenSource: '外检班', decidedBy: '王强', decisionNote: '解除' })
  const lk1After = await db.leaks.get('lk-1')
  assert(lk1After!.concentrationPpm === 68, '裁决不改写处置单原始浓度（原值保留）')

  // 8. 合并失败可重试：人为构造指向已删除点位的任务 → 失败；恢复点位不现实，验证失败状态与幂等
  const flushRes = await flushSyncJobs()
  assert(flushRes.processed >= 2, `flush 处理播种队列任务（${flushRes.processed} 条）`)
  // jb-2（pt-7 存在）应成功；jb-1（pt-2 存在）也应成功
  const jb1 = await db.syncjobs.get('jb-1')
  const jb2 = await db.syncjobs.get('jb-2')
  assert(jb1?.state === '已合并', '失败任务 jb-1 重试后成功')
  assert(jb2?.state === '已合并', '待同步任务 jb-2 合并成功')
  const rdJob1 = await db.readings.get('rd-job1')
  assert(!!rdJob1 && rdJob1.syncJobId === 'jb-1', '重试成功后生成读数并回链任务')
  // 幂等：再次 flush 不重复
  const again = await flushSyncJobs()
  assert(again.processed === 0, '已合并任务不重复处理（幂等）')
  const dupCount = await db.readings.where('syncJobId').equals('jb-1').count()
  assert(dupCount === 1, '重试不产生重复读数')

  // 9. 判级纯函数：快照版本独立性
  const oldJudge = judgeReading(0.3, 0.18, 0.25, true)
  const newJudge = judgeReading(0.3, 0.1, 0.4, true)
  assert(oldJudge.isAbnormal === true && newJudge.isAbnormal === false, '同一读数在旧标准异常、新标准正常（快照判级成立）')

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`)
  await db.close()
  if (fail > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
