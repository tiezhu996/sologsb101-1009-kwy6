/**
 * /sync 断网合并与冲突裁决中心
 * - 顶部：联网/断网模拟与待合并队列
 * - 合并队列：现场断网暂存任务，恢复后按设备/点位合并；失败可重试
 * - 数据冲突：两版值冲突 / 外检与处置单冲突，展示冲突来源与受影响记录，负责人裁决事实来源
 * 消费 SyncJob、DataConflict、Point、Device、Reading、Leak。
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import OnlineBadge from '@/components/common/OnlineBadge'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useSyncStore } from '@/stores/syncStore'
import { db, type ConflictRow, type SyncJobRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { CONFLICT_STATUSES, CONFLICT_TYPES, type ConflictParty } from '@/types/sync'
import { formatValue } from '@/utils/range'
import { ROUTES } from '@/router'

const JOB_STATE_COLOR: Record<SyncJobRow['state'], string> = {
  待同步: 'orange',
  合并失败: 'red',
  已合并: 'green'
}

export default function SyncCenter() {
  const navigate = useNavigate()
  const stationStore = useStationStore()
  const syncStore = useSyncStore()
  const readingTable = useIdbTable(db.readings, { sortByUpdatedAt: false })

  const [decideTarget, setDecideTarget] = useState<ConflictRow | null>(null)
  const [chosenSource, setChosenSource] = useState<ConflictParty>('外检班')
  const [decideForm] = Form.useForm<{ decidedBy: string; decisionNote: string }>()
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('未决')

  const pointById = useMemo(
    () => new Map(stationStore.points.map((point) => [point.id, point])),
    [stationStore.points]
  )
  const deviceById = useMemo(
    () => new Map(stationStore.devices.map((device) => [device.id, device])),
    [stationStore.devices]
  )
  const stationById = useMemo(
    () => new Map(stationStore.stations.map((station) => [station.id, station])),
    [stationStore.stations]
  )

  const contextOf = (pointId: string, deviceId: string, stationId: string): string => {
    const station = stationById.get(stationId)?.name ?? '—'
    const device = deviceById.get(deviceId)
    const point = pointById.get(pointId)
    return `${station} / ${device ? `${device.type} ${device.model}` : '设备已删除'} / ${point ? point.name : '点位已删除'}`
  }

  const jobs = syncStore.syncJobs
  const conflicts = syncStore.conflicts.filter((conflict) => {
    if (typeFilter && conflict.type !== typeFilter) return false
    if (statusFilter && conflict.status !== statusFilter) return false
    return true
  })

  const openDecide = (conflict: ConflictRow): void => {
    setDecideTarget(conflict)
    setChosenSource('外检班')
    decideForm.resetFields()
    decideForm.setFieldsValue({ decidedBy: '', decisionNote: '' })
  }

  const submitDecide = async (): Promise<void> => {
    if (!decideTarget) return
    const values = await decideForm.validate().catch(() => null)
    if (!values) return
    try {
      await syncStore.decideConflict({
        conflictId: decideTarget.id,
        chosenSource,
        decidedBy: values.decidedBy,
        decisionNote: values.decisionNote
      })
      Message.success(`已由 ${values.decidedBy || '未署名'} 裁决，事实来源：${chosenSource}`)
      setDecideTarget(null)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '裁决失败')
    }
  }

  const retry = async (job: SyncJobRow): Promise<void> => {
    const result = await syncStore.retryJob(job.id)
    if (result.ok) {
      Message.success(
        result.conflictId ? '合并完成，已保留两版并登记冲突待负责人核查' : '合并完成，现场值已按设备/点位归并'
      )
    } else {
      Message.error(`合并失败：${result.error ?? '可再次重试'}`)
    }
  }

  const flushAll = async (): Promise<void> => {
    const result = await syncStore.flushAll()
    if (result.processed === 0) {
      Message.info('没有待合并的现场任务')
      return
    }
    result.failed === 0
      ? Message.success(`已合并 ${result.processed} 条现场读数`)
      : Message.warning(`合并 ${result.processed} 条，其中 ${result.failed} 条失败，可重试`)
  }

  const jobColumns: TableColumnProps<SyncJobRow>[] = [
    {
      title: '设备 / 点位',
      width: 260,
      render: (_v, record) => contextOf(record.pointId, record.deviceId, record.stationId)
    },
    {
      title: '现场值',
      width: 130,
      render: (_v, record) => {
        const point = pointById.get(record.pointId)
        return formatValue(record.payload.value, point?.unit ?? '')
      }
    },
    {
      title: '所属巡检',
      width: 150,
      render: (_v, record) => record.payload.patrolId || '—'
    },
    {
      title: '录入时标准',
      width: 180,
      render: (_v, record) =>
        `${record.payload.standardMin} ~ ${record.payload.standardMax}（第 ${record.payload.standardRevision} 版）`
    },
    { title: '尝试次数', dataIndex: 'attempts', width: 90 },
    {
      title: '状态',
      width: 120,
      render: (_v, record) => <Tag color={JOB_STATE_COLOR[record.state]}>{record.state}</Tag>
    },
    {
      title: '失败原因 / 备注',
      render: (_v, record) => (
        <span style={{ color: record.lastError ? '#f53f3f' : '#86909c' }}>
          {record.lastError || record.payload.note || '—'}
        </span>
      )
    },
    {
      title: '操作',
      width: 160,
      render: (_v, record) =>
        record.state === '已合并' ? (
          <Button type="text" size="small" disabled>
            已合并
          </Button>
        ) : (
          <Space size={4}>
            <Button type="text" size="small" disabled={!syncStore.online} onClick={() => retry(record)}>
              重试合并
            </Button>
            <Popconfirm title="放弃该条现场暂存读数？" onOk={() => syncStore.removeJob(record.id)}>
              <Button type="text" size="small" status="danger">
                放弃
              </Button>
            </Popconfirm>
          </Space>
        )
    }
  ]

  const conflictColumns: TableColumnProps<ConflictRow>[] = [
    { title: '冲突类型', width: 150, render: (_v, record) => <Tag color={record.type === '两版值冲突' ? 'orange' : 'red'}>{record.type}</Tag> },
    {
      title: '冲突来源（设备 / 点位）',
      width: 280,
      render: (_v, record) => contextOf(record.pointId, record.deviceId, record.stationId)
    },
    {
      title: '巡检班现场值',
      width: 130,
      render: (_v, record) =>
        record.fieldValue === null ? (
          <span className="muted">—</span>
        ) : (
          <span style={{ color: '#d25f00', fontWeight: 600 }}>{record.fieldValue}</span>
        )
    },
    {
      title: '外检原值',
      width: 130,
      render: (_v, record) =>
        record.externalValue === null ? (
          <span className="muted">—</span>
        ) : (
          <span style={{ color: '#722ed1', fontWeight: 600 }}>{record.externalValue}</span>
        )
    },
    {
      title: '受影响记录',
      render: (_v, record) => {
        const affected: string[] = []
        if (record.fieldReadingId) {
          const r = readingTable.rows.find((item) => item.id === record.fieldReadingId)
          affected.push(r ? `现场读数 ${r.value}（${r.verifyStatus}）` : '现场读数')
        }
        if (record.externalReadingId) affected.push('外检原值（冻结保留）')
        if (record.leakId && record.leakRef) {
          affected.push(`处置单 ${record.leakRef.leakConcentrationPpm} ppm · ${record.leakRef.leakState}`)
        }
        return (
          <div>
            <div style={{ marginBottom: 4 }}>{record.affectedLabel}</div>
            <Space size={4} wrap>
              {affected.map((item) => (
                <Tag key={item} size="small" color="gray">
                  {item}
                </Tag>
              ))}
            </Space>
          </div>
        )
      }
    },
    {
      title: '状态 / 裁决',
      width: 220,
      render: (_v, record) => (
        <div>
          <Tag color={record.status === '未决' ? 'red' : record.status === '已裁决' ? 'green' : 'gray'}>
            {record.status}
          </Tag>
          {record.chosenSource ? <Tag size="small" color="arcoblue">以{record.chosenSource}为准</Tag> : null}
          {record.decidedBy ? <div className="muted" style={{ fontSize: 12 }}>负责人：{record.decidedBy}</div> : null}
          {record.decisionNote ? <div className="muted" style={{ fontSize: 12 }}>{record.decisionNote}</div> : null}
        </div>
      )
    },
    {
      title: '操作',
      width: 170,
      render: (_v, record) => (
        <Space size={4} direction="vertical">
          {record.status === '未决' ? (
            <>
              <Button type="text" size="small" onClick={() => openDecide(record)}>
                裁决事实来源
              </Button>
              <Popconfirm
                title="忽略后仍保留差异，处置单可继续闭环；可稍后重新打开。确认忽略？"
                onOk={async () => {
                  await syncStore.ignoreConflict(record.id, '负责人')
                  Message.success('已忽略冲突，差异仍保留在台账中')
                }}
              >
                <Button type="text" size="small">
                  暂不裁决
                </Button>
              </Popconfirm>
            </>
          ) : (
            <Button type="text" size="small" onClick={() => syncStore.reopenConflict(record.id)}>
              重新打开
            </Button>
          )}
          {record.leakId ? (
            <Button type="text" size="small" onClick={() => navigate(ROUTES.leaks)}>
              查看处置单
            </Button>
          ) : null}
        </Space>
      )
    }
  ]

  const pendingCount = syncStore.pendingCount()
  const failedCount = syncStore.failedCount()
  const openCount = syncStore.openConflictCount()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">断网合并与冲突裁决中心</h2>
          <p className="page-head__desc">
            巡检班现场断网可继续录入，恢复联网后按「设备 + 点位」合并；同一点位两版值均保留、现场值待核查，
            外检原值与处置单冲突由负责人选择事实来源，未决前处置单不能复检闭环。
          </p>
        </div>
        <div className="page-head__actions">
          <OnlineBadge />
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="待合并现场值" value={pendingCount} suffix="条" tone="warning" />
        <StatBadge label="合并失败" value={failedCount} suffix="条" tone="danger" />
        <StatBadge label="未决冲突" value={openCount} suffix="项" tone="danger" />
        <StatBadge
          label="历史冲突"
          value={syncStore.conflicts.filter((item) => item.status !== '未决').length}
          suffix="项"
          tone="default"
        />
      </div>

      {!syncStore.online ? (
        <Alert
          type="warning"
          content="当前为现场断网状态：巡检班读数会离线暂存到合并队列；外检班原值需恢复联网后录入。"
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            合并队列（{jobs.length}）
          </h3>
          <Space>
            <span className="muted">恢复联网后自动合并，失败任务保留现场值可反复重试（幂等不重复写）</span>
            <Button size="small" type="primary" disabled={!syncStore.online || pendingCount + failedCount === 0} onClick={flushAll}>
              全部重试合并
            </Button>
          </Space>
        </div>
        {jobs.length === 0 ? (
          <EmptyPanel title="暂存队列已清空" description="现场读数均已合并，或当前没有断网录入。" compact />
        ) : (
          <Table<SyncJobRow>
            rowKey="id"
            size="small"
            border
            data={jobs}
            columns={jobColumns}
            pagination={false}
            scroll={{ x: 1200 }}
          />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            数据冲突（{conflicts.length} / {syncStore.conflicts.length}）
          </h3>
          <Space>
            <Radio.Group type="button" size="small" value={typeFilter} onChange={(v) => setTypeFilter(String(v))}>
              <Radio value="">全部类型</Radio>
              {CONFLICT_TYPES.map((item) => (
                <Radio key={item} value={item}>
                  {item}
                </Radio>
              ))}
            </Radio.Group>
            <Radio.Group type="button" size="small" value={statusFilter} onChange={(v) => setStatusFilter(String(v))}>
              <Radio value="">全部状态</Radio>
              {CONFLICT_STATUSES.map((item) => (
                <Radio key={item} value={item}>
                  {item}
                </Radio>
              ))}
            </Radio.Group>
          </Space>
        </div>
        {conflicts.length === 0 ? (
          <EmptyPanel title="没有匹配的冲突" description="两班读数一致时不产生冲突；冲突裁决前两版值都会保留。" compact />
        ) : (
          <Table<ConflictRow>
            rowKey="id"
            size="small"
            border
            data={conflicts}
            columns={conflictColumns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>

      <Modal
        visible={decideTarget !== null}
        title={decideTarget ? `裁决事实来源 · ${decideTarget.type}` : '裁决事实来源'}
        onCancel={() => setDecideTarget(null)}
        onOk={submitDecide}
        okText="确认裁决"
        cancelText="取消"
        unmountOnExit
      >
        {decideTarget ? (
          <>
            <Alert
              type={decideTarget.type === '外检与处置单冲突' ? 'error' : 'warning'}
              style={{ marginBottom: 12 }}
              content={decideTarget.affectedLabel}
            />
            <Form form={decideForm} layout="vertical">
              <Form.Item label="选择事实来源" required>
                <Radio.Group value={chosenSource} onChange={(v) => setChosenSource(v as ConflictParty)}>
                  <Space direction="vertical">
                    <Radio value="巡检班">
                      以巡检班现场值为准（{decideTarget.fieldValue ?? '—'}）
                      {decideTarget.type === '两版值冲突' ? '，外检原值仍保留' : '，处置单按现场事实继续处理'}
                    </Radio>
                    <Radio value="外检班">
                      以外检班原值为准（{decideTarget.externalValue ?? '—'}）
                      {decideTarget.type === '两版值冲突' ? '，现场值标记未采纳但不删除' : '，处置单解除闭环阻塞'}
                    </Radio>
                  </Space>
                </Radio.Group>
              </Form.Item>
              <Form.Item field="decidedBy" label="裁决负责人" rules={[{ required: true, message: '请填写负责人' }]}>
                <Input placeholder="如 王强" />
              </Form.Item>
              <Form.Item field="decisionNote" label="裁决说明">
                <Input.TextArea placeholder="如 外检仪器刚完成校准，以外检为准" autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
            </Form>
            <p className="muted" style={{ fontSize: 12 }}>
              裁决只确定事实来源，不会删除或改写任何一方的原始读数 / 处置单浓度。
            </p>
          </>
        ) : null}
      </Modal>
    </div>
  )
}
