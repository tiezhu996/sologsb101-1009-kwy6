/**
 * /sync 断网暂存与双班合并中心
 * - 模拟现场断网 / 恢复；断网时录入进入本地暂存，恢复后按设备+点位合并
 * - 同点双值、外检值与处置单冲突在此保留两版并展示冲突来源 / 受影响记录
 * - 合并失败可重试；冲突由负责人选择事实来源，未决前相关处置单不能完成
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
  Radio,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import SourceTag from '@/components/common/SourceTag'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useSyncStore } from '@/stores/syncStore'
import { useLeakStore } from '@/stores/leakStore'
import { exportConflictCsv } from '@/utils/export'
import type { Reading } from '@/types/reading'
import { READING_SYNC_LABEL } from '@/types/source'
import type { Conflict } from '@/types/conflict'
import { CONFLICT_TYPE_LABEL } from '@/types/conflict'
import type { ResolveConflictInput } from '@/utils/merge'
import { abnormalLevelOf, formatValue, levelOfReading } from '@/utils/range'

type ChosenSource = ResolveConflictInput['chosenSource']

export default function SyncCenter() {
  const navigate = useNavigate()
  const stationStore = useStationStore()
  const syncStore = useSyncStore()
  const leakStore = useLeakStore()

  const [decideTarget, setDecideTarget] = useState<Conflict | null>(null)
  const [chosenSource, setChosenSource] = useState<ChosenSource>('site')
  const [decideForm] = Form.useForm<{ decidedBy: string; decisionNote: string }>()
  const [submitting, setSubmitting] = useState(false)

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

  const nameOfPoint = (pointId: string): string => {
    const point = pointById.get(pointId)
    if (!point) return '点位已删除'
    const device = deviceById.get(point.deviceId)
    const station = stationById.get(point.stationId)
    return `${station ? station.name : '未知站'} / ${device ? `${device.type} ${device.model}` : '设备已删'} / ${point.name}`
  }

  const toggleOffline = (): void => {
    const next = !syncStore.offline
    syncStore.setOffline(next)
    if (next) {
      Message.warning('已模拟现场断网：巡检班录入将本地暂存，恢复网络后再合并')
    } else {
      Message.success('网络已恢复，可点击「立即合并暂存读数」同步')
    }
  }

  const syncAll = async (): Promise<void> => {
    if (syncStore.offline) {
      Message.warning('当前仍处于断网状态，请先恢复网络')
      return
    }
    const result = await syncStore.syncAll()
    Message.success(
      `合并完成：成功 ${result.merged} 条，发现/更新冲突 ${result.conflicts} 条，失败 ${result.failed} 条`
    )
  }

  const retryOne = async (reading: Reading): Promise<void> => {
    if (syncStore.offline) {
      Message.warning('当前仍处于断网状态，请先恢复网络后重试')
      return
    }
    const result = await syncStore.retry([reading.id])
    const item = result.items[0]
    if (item?.state === 'failed') {
      Message.error(`合并仍失败：${item.error}`)
    } else {
      Message.success(`读数已重新合并（${item ? READING_SYNC_LABEL[item.state] : ''}）`)
    }
  }

  const openDecide = (conflict: Conflict): void => {
    setDecideTarget(conflict)
    setChosenSource(conflict.type === 'leak-mismatch' ? 'external' : 'site')
    decideForm.setFieldsValue({ decidedBy: conflict.decidedBy || '', decisionNote: conflict.decisionNote || '' })
  }

  const submitDecide = async (): Promise<void> => {
    if (!decideTarget) return
    const values = await decideForm.validate().catch(() => null)
    if (!values) return
    setSubmitting(true)
    try {
      await syncStore.resolveConflict({
        conflictId: decideTarget.id,
        chosenSource,
        decidedBy: values.decidedBy,
        decisionNote: values.decisionNote
      })
      Message.success('冲突已裁决：两版记录均保留，关联处置单已解除拦截')
      setDecideTarget(null)
    } finally {
      setSubmitting(false)
    }
  }

  const pendingColumns: TableColumnProps<Reading>[] = [
    {
      title: '设备 / 点位',
      width: 260,
      render: (_value, record) => nameOfPoint(record.pointId)
    },
    {
      title: '读数',
      width: 130,
      render: (_value, record) => {
        const point = pointById.get(record.pointId)
        return formatValue(record.value, point?.unit ?? '')
      }
    },
    {
      title: '录入时判级',
      width: 130,
      render: (_value, record) => (
        <Tag color={record.isAbnormal ? (levelOfReading(record) === '严重超标' ? 'red' : 'orange') : 'green'}>
          {abnormalLevelOf(record.deviationPct, record.isCriticalAtEntry)}
        </Tag>
      )
    },
    {
      title: '来源 / 状态',
      width: 250,
      render: (_value, record) => (
        <SourceTag source={record.source} syncState={record.syncState} verifyState={record.verifyState} />
      )
    },
    {
      title: '失败原因',
      render: (_value, record) =>
        record.lastError ? <span style={{ color: '#f53f3f' }}>{record.lastError}</span> : <span className="muted">断网暂存中，等待恢复后合并</span>
    },
    {
      title: '操作',
      width: 110,
      render: (_value, record) => (
        <Button type="text" size="small" disabled={syncStore.offline} onClick={() => retryOne(record)}>
          重试合并
        </Button>
      )
    }
  ]

  const conflictColumns: TableColumnProps<Conflict>[] = [
    {
      title: '冲突类型',
      width: 150,
      render: (_value, record) => (
        <Tag color={record.type === 'dual-reading' ? 'orange' : 'red'}>{CONFLICT_TYPE_LABEL[record.type]}</Tag>
      )
    },
    { title: '设备 / 点位', width: 260, render: (_value, record) => nameOfPoint(record.pointId) },
    {
      title: '差异两版',
      width: 280,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          {record.sides.map((side) => {
            const point = pointById.get(record.pointId)
            return (
              <span key={`${side.source}-${side.readingId}`}>
                <Tag color={side.source === 'site' ? 'arcoblue' : 'purple'} size="small">
                  {side.source === 'site' ? '巡检班现场' : '外检原值'}
                </Tag>
                <strong style={{ margin: '0 4px' }}>{formatValue(side.value, point?.unit ?? '')}</strong>
                <span className="muted">· {side.levelText}</span>
              </span>
            )
          })}
          {record.type === 'leak-mismatch' ? (
            <span>
              <Tag color="red" size="small">处置单记载</Tag>
              <strong style={{ margin: '0 4px' }}>{formatValue(record.leakConcentrationPpm, 'ppm')}</strong>
            </span>
          ) : null}
        </Space>
      )
    },
    { title: '冲突来源', render: (_value, record) => <span>{record.originText}</span> },
    {
      title: '受影响记录',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <span className="muted">读数 {record.affectedReadingIds.length} 条：{record.affectedReadingIds.join('、')}</span>
          {record.affectedLeakIds.length > 0 ? (
            <span style={{ color: '#f53f3f' }}>
              处置单被拦截：{record.affectedLeakIds.map((id) => leakStore.leaks.find((leak) => leak.id === id) ? `${id}（${leakStore.leaks.find((leak) => leak.id === id)?.state}）` : id).join('、')}
            </span>
          ) : (
            <span className="muted">无关联处置单</span>
          )}
        </Space>
      )
    },
    {
      title: '状态 / 操作',
      width: 200,
      render: (_value, record) =>
        record.status === 'open' ? (
          <Space direction="vertical" size={2}>
            <Tag color="red">未决 · 处置单不能完成</Tag>
            <Button type="primary" size="small" onClick={() => openDecide(record)}>
              负责人裁决
            </Button>
          </Space>
        ) : (
          <Space direction="vertical" size={2}>
            <Tag color="green">已裁决</Tag>
            <span className="muted">
              采信{record.chosenSource === 'site' ? '现场值' : record.chosenSource === 'external' ? '外检原值' : '处置单'} · {record.decidedBy}
            </span>
            <Button type="text" size="small" onClick={() => openDecide(record)}>
              查看裁决
            </Button>
          </Space>
        )
    }
  ]

  const openConflicts = syncStore.openConflicts()
  const blockedLeakCount = syncStore.conflictBlockedLeakIds().length

  const decideOptions = useMemo(() => {
    if (!decideTarget) return []
    const options: { value: ChosenSource; label: string; extra: string }[] = decideTarget.sides.map((side) => ({
      value: side.source,
      label: side.source === 'site' ? '以巡检班现场值为准' : '以外检班原值为准（外检原值）',
      extra: `${side.value} ${pointById.get(decideTarget.pointId)?.unit ?? ''} · ${side.note || '无备注'}`
    }))
    if (decideTarget.type === 'leak-mismatch') {
      options.push({
        value: 'leak',
        label: '以处置单记载浓度为准',
        extra: `${decideTarget.leakConcentrationPpm} ppm · 两版读数仍保留留档`
      })
    }
    return options
  }, [decideTarget, pointById])

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">断网暂存 · 双班合并 · 冲突裁决</h2>
          <p className="page-head__desc">
            巡检班与外检班各记一份；断网时本地暂存，恢复后按设备与点位合并。同点双值两版都保留，现场值待核查，外检原值不丢。
          </p>
        </div>
        <div className="page-head__actions">
          <Button
            disabled={syncStore.conflicts.length === 0}
            onClick={() =>
              Message.success(
                exportConflictCsv(
                  stationStore.stations,
                  stationStore.devices,
                  stationStore.points,
                  syncStore.conflicts
                )
              )
            }
          >
            导出冲突台账
          </Button>
          <Button status={syncStore.offline ? 'warning' : 'success'} onClick={toggleOffline}>
            {syncStore.offline ? '模拟恢复网络' : '模拟现场断网'}
          </Button>
          <Button type="primary" disabled={syncStore.offline || syncStore.pendingReadings.length === 0} onClick={syncAll}>
            立即合并暂存读数（{syncStore.pendingReadings.length}）
          </Button>
        </div>
      </div>

      <Alert
        type={syncStore.offline ? 'warning' : 'info'}
        style={{ marginBottom: 16 }}
        content={
          syncStore.offline
            ? '当前为断网状态：巡检班录入的读数只会写入本地暂存队列，不会丢失；恢复网络后点击「立即合并」。'
            : '网络正常：新读数直接合并；历史读数按录入时标准判级，标准后来修改不影响历史异常与已派处置单。'
        }
      />

      <div className="stat-row">
        <StatBadge label="本地暂存 / 失败" value={syncStore.pendingReadings.length} suffix="条" tone={syncStore.offline ? 'warning' : 'primary'} />
        <StatBadge label="合并失败待重试" value={syncStore.failedCount()} suffix="条" tone="danger" />
        <StatBadge label="未决冲突" value={openConflicts.length} suffix="条" tone="danger" />
        <StatBadge label="被拦截处置单" value={blockedLeakCount} suffix="张" tone="warning" hint="外检值与处置单冲突未裁决前不能完成闭环" />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            本地暂存与合并失败（{syncStore.pendingReadings.length}）
          </h3>
          <span className="muted">合并失败后可逐条重试，暂存数据始终保留</span>
        </div>
        {syncStore.pendingReadings.length === 0 ? (
          <EmptyPanel title="没有待合并读数" description="断网时巡检班录入的读数会出现在这里，恢复网络后一键合并。" compact />
        ) : (
          <Table<Reading>
            rowKey="id"
            size="small"
            border
            data={syncStore.pendingReadings}
            columns={pendingColumns}
            pagination={false}
            scroll={{ x: 1100 }}
          />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            合并冲突清单（{syncStore.conflicts.length}，未决 {openConflicts.length}）
          </h3>
          <Space>
            <Button size="small" onClick={() => navigate('/leaks')}>
              前往处置单
            </Button>
            <Button size="small" onClick={() => navigate('/abnormal')}>
              异常分级
            </Button>
          </Space>
        </div>
        {syncStore.conflicts.length === 0 ? (
          <EmptyPanel title="暂无冲突" description="双班组数值一致、或外检值与处置单无差异时不产生冲突。" compact />
        ) : (
          <Table<Conflict>
            rowKey="id"
            size="small"
            border
            data={syncStore.conflicts}
            columns={conflictColumns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>

      <Modal
        visible={decideTarget !== null}
        title={decideTarget ? `冲突裁决 · ${CONFLICT_TYPE_LABEL[decideTarget.type]}` : '冲突裁决'}
        onCancel={() => setDecideTarget(null)}
        onOk={submitDecide}
        okText="确认裁决并解除拦截"
        cancelText="取消"
        confirmLoading={submitting}
        okButtonProps={{ disabled: decideTarget?.status === 'resolved' }}
        unmountOnExit
      >
        {decideTarget ? (
          <div>
            <Alert type="warning" style={{ marginBottom: 12 }} content={decideTarget.originText} />
            <div style={{ marginBottom: 12 }}>
              <div className="muted" style={{ marginBottom: 6 }}>受影响记录</div>
              <Space wrap>
                {decideTarget.affectedReadingIds.map((id) => (
                  <Tag key={id} size="small">读数 {id}</Tag>
                ))}
                {decideTarget.affectedLeakIds.map((id) => (
                  <Tag key={id} color="red" size="small">处置单 {id}</Tag>
                ))}
              </Space>
            </div>
            {decideTarget.status === 'open' ? (
              <>
                <div className="muted" style={{ marginBottom: 6 }}>选择事实来源（两版记录都会保留，外检原值不删除）</div>
                <Radio.Group
                  direction="vertical"
                  value={chosenSource}
                  onChange={(value: ChosenSource) => setChosenSource(value)}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}
                >
                  {decideOptions.map((option) => (
                    <Radio key={option.value} value={option.value}>
                      <span>{option.label}</span>
                      <span className="muted" style={{ marginLeft: 8 }}>{option.extra}</span>
                    </Radio>
                  ))}
                </Radio.Group>
                <Form form={decideForm} layout="vertical">
                  <Form.Item field="decidedBy" label="裁决负责人" rules={[{ required: true, message: '请填写负责人' }]}>
                    <Input placeholder="如 王负责人" />
                  </Form.Item>
                  <Form.Item field="decisionNote" label="裁决说明" rules={[{ required: true, message: '请填写裁决依据' }]}>
                    <Input.TextArea placeholder="如 经复核对仪表，采信现场值；外检原值留档" autoSize={{ minRows: 2, maxRows: 4 }} />
                  </Form.Item>
                </Form>
              </>
            ) : (
              <Alert
                type="success"
                content={`已于 ${new Date(decideTarget.decidedAt).toLocaleString()} 由 ${decideTarget.decidedBy} 裁决，采信${
                  decideTarget.chosenSource === 'site' ? '巡检班现场值' : decideTarget.chosenSource === 'external' ? '外检班原值' : '处置单记载'
                }。${decideTarget.decisionNote}`}
              />
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
