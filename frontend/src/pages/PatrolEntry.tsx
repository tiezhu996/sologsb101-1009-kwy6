/**
 * /patrols 巡检录入
 * 巡检班与外检班各记一份：巡检班现场值断网可离线暂存（恢复后按设备/点位合并），
 * 外检班原值仅在线直写且冻结；录入即按「录入时标准」比对并给出异常级别。
 * 消费 Patrol、Reading、Point；复用 <AbnormalTag>、<FilterBar>、<EmptyPanel>、<StatBadge>、<SourceTag>、<OnlineBadge>。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import SourceTag from '@/components/common/SourceTag'
import StatBadge from '@/components/common/StatBadge'
import OnlineBadge from '@/components/common/OnlineBadge'
import { useStationStore } from '@/stores/stationStore'
import { usePatrolStore } from '@/stores/patrolStore'
import { useSyncStore } from '@/stores/syncStore'
import { usePatrolGap } from '@/hooks/usePatrolGap'
import { snapshotOfReading } from '@/types/reading'
import { PATROL_STATES, type Patrol, type PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading, ReadingSource } from '@/types/reading'
import { formatValue, rangeText } from '@/utils/range'

export default function PatrolEntry() {
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const syncStore = useSyncStore()

  const [completeForm] = Form.useForm<{ patrolDate: string; patrolman: string; envNote: string }>()
  const [noteForm] = Form.useForm<{ note: string }>()
  const [completeOpen, setCompleteOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteTarget, setNoteTarget] = useState<Reading | null>(null)

  const gap = usePatrolGap(patrolStore.patrols)
  const filter = patrolStore.filter
  const source = patrolStore.entrySource
  const online = syncStore.online

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'states', label: '巡检状态', options: PATROL_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = { keyword: '', stationId: filter.stationId, states: filter.states }

  const onModelChange = (next: FilterModel): void => {
    patrolStore.patchFilter({
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      states: (Array.isArray(next.states) ? next.states : []) as PatrolState[]
    })
  }

  const patrols = patrolStore.filteredPatrols()
  const activePatrol = patrolStore.activePatrolId
    ? patrolStore.patrols.find((patrol) => patrol.id === patrolStore.activePatrolId) ?? null
    : null

  /** 当前站点下所有设备点位 */
  const activePoints = useMemo<Point[]>(() => {
    if (!activePatrol) return []
    const deviceIds = stationStore.devices
      .filter((device) => device.stationId === activePatrol.stationId)
      .map((device) => device.id)
    return stationStore.points.filter((point) => deviceIds.includes(point.deviceId))
  }, [activePatrol, stationStore.devices, stationStore.points])

  const activeReadings = activePatrol ? patrolStore.readingsOfPatrol(activePatrol.id) : []
  const pendingJobs = activePatrol ? syncStore.syncJobs.filter((job) => job.payload.patrolId === activePatrol.id && job.state !== '已合并') : []

  useEffect(() => {
    if (activePatrol) patrolStore.seedDraftFromReadings(activePatrol.id, activePoints, patrolStore.entrySource)
    // 仅在切换巡检任务、点位集合或录入班组时回填草稿
  }, [activePatrol?.id, activePoints.length, patrolStore.entrySource])

  const draftJudgementOf = (point: Point, value: number | undefined) =>
    value === undefined ? null : patrolStore.judge(point, value)

  const abnormalInDraft = activePoints.filter((point) => {
    const value = patrolStore.readingDraft[`${source}:${activePatrol?.id ?? ''}:${point.id}`]
    if (value === undefined) return false
    return patrolStore.judge(point, value).isAbnormal
  }).length

  const saveAll = async (): Promise<void> => {
    if (!activePatrol) return
    if (source === '外检班' && !online) {
      Message.error('现场断网，外检班原值不能录入；请先恢复联网，或切换到巡检班离线暂存')
      return
    }
    const count = await patrolStore.saveReadingDrafts(activePatrol.id, activePoints, source)
    if (count === 0) {
      Message.warning('没有可保存的读数，请先录入')
      return
    }
    if (source === '巡检班' && !online) {
      Message.success(`已离线暂存 ${count} 条现场值，恢复联网后自动按设备/点位合并`)
    } else {
      Message.success(`已保存 ${count} 条${source === '外检班' ? '外检原值（只读冻结）' : '现场值'}`)
    }
  }

  const saveOne = async (point: Point, value: number): Promise<void> => {
    if (!activePatrol) return
    const saved = patrolStore
      .readingsOfPatrol(activePatrol.id)
      .filter((reading) => reading.pointId === point.id && reading.source === source)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    const result = await patrolStore.saveSingleReading(activePatrol.id, point, value, saved?.note ?? '', source)
    if (!result.ok) {
      Message.error(result.blocked ?? '保存失败')
      return
    }
    if (result.offlineQueued) {
      Message.success(`${point.name} 现场值已离线暂存，恢复联网后合并`)
    } else {
      Message.success(`${point.name} 读数已保存${source === '外检班' ? '（外检原值冻结）' : ''}`)
    }
  }

  const openComplete = (): void => {
    if (!activePatrol) return
    completeForm.setFieldsValue({
      patrolDate: new Date().toISOString().slice(0, 10),
      patrolman: activePatrol.patrolman,
      envNote: activePatrol.envNote
    })
    setCompleteOpen(true)
  }

  const submitComplete = async (): Promise<void> => {
    if (!activePatrol) return
    if (source === '巡检班' && pendingJobs.some((job) => job.state !== '已合并')) {
      // 允许完成但提示有未合并现场值
      Message.warning('仍有现场值未完成合并，完成后可到「合并与冲突」中心重试')
    }
    const values = await completeForm.validate().catch(() => null)
    if (!values) return
    await patrolStore.completePatrol(activePatrol.id, values.patrolDate, values.patrolman, values.envNote)
    Message.success('巡检已完成，异常读数可在异常分级页派发处置单')
    setCompleteOpen(false)
  }

  const markMissed = async (patrol: Patrol): Promise<void> => {
    await patrolStore.markMissed(patrol.id, '超期未执行，已标记漏检')
    Message.warning('已标记为漏检，可在巡检计划页跟踪')
  }

  const openNote = (reading: Reading): void => {
    if (reading.frozen) {
      Message.info('外检原值只读，不能修改备注')
      return
    }
    setNoteTarget(reading)
    noteForm.setFieldsValue({ note: reading.note })
    setNoteOpen(true)
  }

  const submitNote = async (): Promise<void> => {
    const values = await noteForm.validate().catch(() => null)
    if (!values || !noteTarget) return
    await patrolStore.updateReadingNote(noteTarget, values.note)
    Message.success('现场备注已保存')
    setNoteOpen(false)
  }

  const readingColumns: TableColumnProps<Reading>[] = [
    {
      title: '点位',
      width: 130,
      render: (_value, record) => stationStore.points.find((point) => point.id === record.pointId)?.name ?? '点位已删除'
    },
    {
      title: '来源 / 核查',
      width: 150,
      render: (_value, record) => <SourceTag source={record.source} verifyStatus={record.verifyStatus} frozen={record.frozen} size="small" />
    },
    {
      title: '判级标准（录入时）',
      width: 200,
      render: (_value, record) => {
        const point = stationStore.points.find((item) => item.id === record.pointId)
        const snapshot = snapshotOfReading(record, point ? { standardMin: point.standardMin, standardMax: point.standardMax, isCritical: point.isCritical } : null)
        return (
          <span>
            {rangeText(snapshot.standardMin, snapshot.standardMax, point?.unit ?? '')}
            <Tag size="small" style={{ marginLeft: 4 }}>v{record.standardRevision}</Tag>
          </span>
        )
      }
    },
    { title: '读数', dataIndex: 'value', width: 110, render: (value: number, record) => formatValue(value, stationStore.points.find((p) => p.id === record.pointId)?.unit ?? '') },
    { title: '偏差率', dataIndex: 'deviationPct', width: 100, render: (value: number) => `${value.toFixed(2)}%` },
    {
      title: '判定',
      width: 150,
      render: (_value, record) => <AbnormalTag level={patrolStore.judgeReadingRow(record).level} size="small" />
    },
    {
      title: '冲突',
      width: 110,
      render: (_value, record) =>
        record.conflictId ? (
          <Tag color="red" size="small">
            待核查冲突
          </Tag>
        ) : (
          <span className="muted">—</span>
        )
    },
    { title: '备注', dataIndex: 'note', width: 180, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 130,
      render: (_value, record) =>
        record.frozen ? (
          <Tag color="purple" size="small">
            原值锁定
          </Tag>
        ) : (
          <Space size={4}>
            <Button type="text" size="small" onClick={() => openNote(record)}>
              备注
            </Button>
            <Popconfirm title="确认删除该现场读数？" onOk={() => patrolStore.removeReading(record.id)}>
              <Button type="text" size="small" status="danger">
                删除
              </Button>
            </Popconfirm>
          </Space>
        )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检录入</h2>
          <p className="page-head__desc">
            巡检班与外检班各记一份；巡检班现场值断网可继续录入并暂存，恢复联网后按设备/点位合并，同一点位两版都有值时保留两版。
          </p>
        </div>
        <div className="page-head__actions">
          <Space>
            <Button disabled={!activePatrol || (source === '外检班' && !online)} onClick={saveAll}>
              {source === '巡检班' && !online ? '离线暂存全部' : '保存全部读数'}
            </Button>
            <Button type="primary" disabled={!activePatrol} onClick={openComplete}>
              完成巡检
            </Button>
            <OnlineBadge />
          </Space>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="巡检任务" value={patrolStore.patrols.length} suffix="次" tone="primary" />
        <StatBadge label="已完成" value={patrolStore.patrols.filter((item) => item.state === '已完成').length} suffix="次" tone="success" />
        <StatBadge label="待巡检" value={patrolStore.patrols.filter((item) => item.state === '待巡检').length} suffix="次" tone="info" />
        <StatBadge label="漏检 / 超期" value={gap.overdueCount} suffix="次" tone="danger" />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder=""
        onModelChange={onModelChange}
      />

      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 className="panel-title">巡检任务（{patrols.length}）</h3>
          {patrols.length === 0 ? (
            <EmptyPanel title="没有巡检任务" description="可到巡检计划页按站点批量生成计划。" compact />
          ) : (
            patrols.map((patrol) => {
              const item = gap.gapOf(patrol)
              const station = stationStore.stations.find((entry) => entry.id === patrol.stationId)
              const jobCount = patrolStore.pendingJobCountOf(patrol.id)
              return (
                <div
                  key={patrol.id}
                  className={`card-list-item${patrol.id === patrolStore.activePatrolId ? ' is-active' : ''}`}
                  onClick={() => patrolStore.setActivePatrol(patrol.id)}
                >
                  <div className="card-list-item__head">
                    <span>{station ? station.name : '未知站点'}</span>
                    <Tag
                      color={patrol.state === '已完成' ? 'green' : patrol.state === '漏检' ? 'red' : 'blue'}
                    >
                      {patrol.state}
                    </Tag>
                  </div>
                  <div className="card-list-item__meta">
                    <span>计划 {patrol.planDate}</span>
                    <span>· 实际 {patrol.patrolDate || '未执行'}</span>
                    <span>· {patrol.patrolman || '未指派'}</span>
                  </div>
                  <div className="card-list-item__meta">
                    <span style={{ color: item.overdue ? '#f53f3f' : undefined }}>{item.text}</span>
                    {jobCount > 0 ? (
                      <Tag color="orange" size="small" style={{ marginLeft: 6 }}>
                        {jobCount} 条现场值待合并
                      </Tag>
                    ) : null}
                  </div>
                  <div className="card-list-item__meta" style={{ gap: 8 }}>
                    <Button
                      type="text"
                      size="small"
                      disabled={patrol.state === '已完成'}
                      onClick={(event) => {
                        event.stopPropagation()
                        patrolStore.setActivePatrol(patrol.id)
                        openComplete()
                      }}
                    >
                      完成
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      disabled={patrol.state === '已完成'}
                      onClick={(event) => {
                        event.stopPropagation()
                        void markMissed(patrol)
                      }}
                    >
                      标记漏检
                    </Button>
                    <Popconfirm
                      title="删除该巡检任务将同时删除其读数"
                      onOk={() => patrolStore.removePatrol(patrol.id)}
                    >
                      <Button type="text" size="small" status="danger" onClick={(event) => event.stopPropagation()}>
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="panel">
          {activePatrol ? (
            <>
              <div className="panel-head">
                <h3 className="panel-title" style={{ margin: 0 }}>
                  逐点录入 · {stationStore.stations.find((item) => item.id === activePatrol.stationId)?.name ?? ''}
                  <span className="muted"> （{activePatrol.planDate}，{activePoints.length} 个点位）</span>
                </h3>
                <Space>
                  <Radio.Group
                    type="button"
                    size="small"
                    value={source}
                    onChange={(value) => patrolStore.setEntrySource(value as ReadingSource)}
                  >
                    <Radio value="巡检班">巡检班现场值</Radio>
                    <Radio value="外检班">外检班原值</Radio>
                  </Radio.Group>
                </Space>
              </div>

              {source === '外检班' && !online ? (
                <Alert
                  type="error"
                  style={{ margin: '8px 0' }}
                  content="现场断网期间外检班原值不可录入（外检原值必须在线直写并冻结）。请恢复联网，或切换到巡检班现场值离线暂存。"
                />
              ) : null}
              {source === '巡检班' && !online ? (
                <Alert
                  type="warning"
                  style={{ margin: '8px 0' }}
                  content="现场断网：巡检班读数将先离线暂存，恢复联网后自动按设备/点位合并，合并失败可在「合并与冲突」中心重试。"
                />
              ) : null}

              <div className="card-list-item__meta" style={{ marginBottom: 8 }}>
                <span className="muted">
                  草稿中异常 {abnormalInDraft} 项 / 已存档异常 {activeReadings.filter((item) => item.isAbnormal).length} 项
                  {pendingJobs.length > 0 ? ` / 待合并 ${pendingJobs.length} 项` : ''}
                </span>
              </div>

              {activePoints.length === 0 ? (
                <EmptyPanel
                  title="该站点暂无点位"
                  description="先到点位配置页为设备配置标准值区间。"
                  compact
                />
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                    gap: 12,
                    marginBottom: 16
                  }}
                >
                  {activePoints.map((point) => {
                    const key = `${source}:${activePatrol.id}:${point.id}`
                    const value = patrolStore.readingDraft[key]
                    const judgement = draftJudgementOf(point, value)
                    const versions = activeReadings.filter((item) => item.pointId === point.id)
                    const sameSource = versions.filter((item) => item.source === source)
                    const otherSource = source === '外检班' ? '巡检班' : '外检班'
                    const hasOther = versions.some((item) => item.source === otherSource)
                    return (
                      <div key={point.id} className="panel" style={{ padding: 12 }}>
                        <div className="card-list-item__head">
                          <span>
                            {point.name}
                            {point.isCritical ? <Tag color="orange" size="small" style={{ marginLeft: 6 }}>关键点</Tag> : null}
                          </span>
                          {judgement ? <AbnormalTag level={judgement.level} deviationPct={judgement.deviationPct} size="small" /> : null}
                        </div>
                        <div className="card-list-item__meta">
                          <span>
                            当前标准 {point.standardMin} ~ {point.standardMax} {point.unit}（v{point.standardRevision}）
                          </span>
                        </div>
                        <div className="card-list-item__meta">
                          {sameSource.length > 0 ? (
                            <span>
                              已存档（{source}）：
                              {sameSource
                                .slice()
                                .sort((a, b) => b.createdAt - a.createdAt)
                                .map((item) => (
                                  <Tag key={item.id} size="small" color={item.verifyStatus === '待核查' ? 'orange' : item.verifyStatus === '未采纳' ? 'gray' : 'green'}>
                                    {item.value}
                                    {item.verifyStatus === '待核查' ? ' 待核查' : ''}
                                  </Tag>
                                ))}
                            </span>
                          ) : (
                            <span className="muted">{source}尚未录入</span>
                          )}
                        </div>
                        {hasOther ? (
                          <div className="card-list-item__meta">
                            <Tag color="red" size="small">
                              同一点位已有{otherSource}值，保存后保留两版
                            </Tag>
                          </div>
                        ) : null}
                        <Space style={{ marginTop: 8 }}>
                          <InputNumber
                            size="small"
                            style={{ width: 140 }}
                            value={value}
                            step={point.unit === 'ppm' ? 1 : 0.01}
                            placeholder="输入读数"
                            onChange={(next: number | undefined) => {
                              if (next === undefined) return
                              patrolStore.setReadingDraft(source, activePatrol.id, point.id, Number(next))
                            }}
                          />
                          <Button
                            size="small"
                            type="primary"
                            disabled={value === undefined || (source === '外检班' && !online)}
                            onClick={() => value !== undefined && saveOne(point, value)}
                          >
                            {source === '巡检班' && !online ? '暂存' : '保存'}
                          </Button>
                        </Space>
                      </div>
                    )
                  })}
                </div>
              )}

              <h4 className="panel-title">已保存读数（两班各版均保留）</h4>
              {activeReadings.length === 0 ? (
                <EmptyPanel title="暂无已保存读数" description="录入后点击「保存全部读数」或逐点保存。" compact />
              ) : (
                <Table<Reading>
                  rowKey="id"
                  size="small"
                  border
                  data={activeReadings}
                  columns={readingColumns}
                  pagination={false}
                  scroll={{ x: 1300 }}
                />
              )}
            </>
          ) : (
            <EmptyPanel title="尚未选择巡检任务" description="在左侧任务列表中选择一次巡检后即可逐点录入读数。" compact />
          )}
        </div>
      </div>

      <Modal
        visible={completeOpen}
        title="完成巡检"
        onCancel={() => setCompleteOpen(false)}
        onOk={submitComplete}
        okText="确认完成"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={completeForm} layout="vertical">
          <Form.Item field="patrolDate" label="实际日期" rules={[{ required: true, message: '请填写实际日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="patrolman" label="巡检人" rules={[{ required: true, message: '请填写巡检人' }]}>
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="envNote" label="现场环境备注">
            <Input.TextArea placeholder="如 晴，气温 26℃，无异常气味" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={noteOpen}
        title="现场备注"
        onCancel={() => setNoteOpen(false)}
        onOk={submitNote}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={noteForm} layout="vertical">
          <Form.Item field="note" label="备注">
            <Input.TextArea placeholder="如 便携式检漏仪测得，有轻微气味" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
