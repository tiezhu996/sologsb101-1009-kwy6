/**
 * /patrols 巡检录入
 * 巡检班（现场）与外检班（外检原值）各记一份；断网时读数本地暂存，恢复后在「合并与冲突」页合并。
 * 判定列按读数录入时冻结的标准快照展示——标准后来改过也不翻历史。
 * 消费 Patrol、Reading、Point；复用 <AbnormalTag>、<FilterBar>、<EmptyPanel>、<StatBadge>、<SourceTag>。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { useStationStore } from '@/stores/stationStore'
import { usePatrolStore } from '@/stores/patrolStore'
import { useSyncStore } from '@/stores/syncStore'
import { usePatrolGap } from '@/hooks/usePatrolGap'
import { PATROL_STATES, type Patrol, type PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading } from '@/types/reading'
import type { ReadingSource } from '@/types/source'
import { READING_SOURCE_LABEL } from '@/types/source'
import { levelOfReading } from '@/utils/range'

const ENTRY_SOURCES: ReadingSource[] = ['site', 'external']

export default function PatrolEntry() {
  const navigate = useNavigate()
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
  const entrySource = patrolStore.entrySource

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
  /** 当前巡检下 点位 → 两班组读数 */
  const readingsByPoint = useMemo(() => patrolStore.pointValuesOf(activePatrol?.id ?? ''), [patrolStore, activePatrol?.id])

  useEffect(() => {
    if (activePatrol) patrolStore.seedDraftFromReadings(activePatrol.id, activePoints)
    // 仅在切换巡检任务或点位集合变化时回填草稿
  }, [activePatrol?.id, activePoints.length])

  const saveAll = async (): Promise<void> => {
    if (!activePatrol) return
    const count = await patrolStore.saveReadingDrafts(activePatrol.id, activePoints, entrySource)
    if (count === 0) {
      Message.warning('没有可保存的读数，请先录入')
      return
    }
    Message.success(
      syncStore.offline
        ? `已本地暂存 ${count} 条${READING_SOURCE_LABEL[entrySource]}读数，恢复网络后合并`
        : `已保存 ${count} 条${READING_SOURCE_LABEL[entrySource]}读数，已按设备+点位合并`
    )
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
    const values = await completeForm.validate().catch(() => null)
    if (!values) return
    await patrolStore.saveReadingDrafts(activePatrol.id, activePoints, entrySource)
    await patrolStore.completePatrol(activePatrol.id, values.patrolDate, values.patrolman, values.envNote)
    Message.success('巡检已完成，异常读数可在异常分级页派发处置单')
    setCompleteOpen(false)
  }

  const markMissed = async (patrol: Patrol): Promise<void> => {
    await patrolStore.markMissed(patrol.id, '超期未执行，已标记漏检')
    Message.warning('已标记为漏检，可在巡检计划页跟踪')
  }

  const openNote = (reading: Reading): void => {
    setNoteTarget(reading)
    noteForm.setFieldsValue({ note: reading.note })
    setNoteOpen(true)
  }

  const submitNote = async (): Promise<void> => {
    const values = await noteForm.validate().catch(() => null)
    if (!values || !noteTarget) return
    await patrolStore.saveSingleReading(
      noteTarget.patrolId,
      stationStore.points.find((point) => point.id === noteTarget.pointId) as Point,
      noteTarget.value,
      values.note,
      noteTarget.source
    )
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
      title: '录入班组 / 状态',
      width: 240,
      render: (_value, record) => (
        <SourceTag source={record.source} syncState={record.syncState} verifyState={record.verifyState} />
      )
    },
    {
      title: '录入时标准（冻结）',
      width: 190,
      render: (_value, record) =>
        `${record.standardMinAtEntry} ~ ${record.standardMaxAtEntry} ${
          stationStore.points.find((point) => point.id === record.pointId)?.unit ?? ''
        }（v${record.standardRevision}${record.isCriticalAtEntry ? ' · 关键' : ''}）`
    },
    { title: '读数', dataIndex: 'value', width: 100, render: (value: number) => value },
    { title: '偏差率', dataIndex: 'deviationPct', width: 100, render: (value: number) => `${value.toFixed(2)}%` },
    {
      title: '判定（录入时）',
      width: 150,
      render: (_value, record) => <AbnormalTag level={levelOfReading(record)} size="small" />
    },
    { title: '备注', dataIndex: 'note', width: 180, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openNote(record)}>
            备注
          </Button>
          <Popconfirm title="确认删除该读数？另一班组的同点读数不受影响" onOk={() => patrolStore.removeReading(record.id)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const pendingCountInPatrol = syncStore.pendingReadings.filter((reading) => reading.patrolId === activePatrol?.id).length

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检录入（双班组）</h2>
          <p className="page-head__desc">
            巡检班与外检班各记一份；同一点位两版都保留，现场值待核查，外检原值不丢。断网录入本地暂存，恢复后按设备+点位合并。
          </p>
        </div>
        <div className="page-head__actions">
          <Button disabled={!activePatrol} onClick={saveAll}>
            保存{entrySource === 'site' ? '巡检班' : '外检班'}读数
          </Button>
          <Button type="primary" disabled={!activePatrol} onClick={openComplete}>
            完成巡检
          </Button>
        </div>
      </div>

      {syncStore.offline ? (
        <Alert
          type="warning"
          style={{ marginBottom: 12 }}
          content="现场断网中：本次录入仅写入本地暂存队列（不丢数据），网络恢复后请到「合并与冲突」页重试合并。"
        />
      ) : pendingCountInPatrol > 0 ? (
        <Alert
          type="info"
          style={{ marginBottom: 12 }}
          content={`本任务还有 ${pendingCountInPatrol} 条暂存/失败读数未合并。`}
          action={
            <Button size="small" type="primary" onClick={() => navigate('/sync')}>
              去合并
            </Button>
          }
        />
      ) : null}

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
                      title="删除该巡检任务将同时删除其读数（两班组均删）"
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
                    value={entrySource}
                    onChange={(value: ReadingSource) => patrolStore.setEntrySource(value)}
                    options={ENTRY_SOURCES.map((source) => ({
                      label: source === 'site' ? '巡检班（现场）' : '外检班（外检原值）',
                      value: source
                    }))}
                  />
                  <span className="muted">
                    {entrySource === 'site' ? '现场值，双值时待核查' : '外检原值，保留不丢'}
                  </span>
                </Space>
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
                    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                    gap: 12,
                    marginBottom: 16
                  }}
                >
                  {activePoints.map((point) => {
                    const key = patrolStore.draftKey(activePatrol.id, point.id, entrySource)
                    const value = patrolStore.readingDraft[key]
                    const judgement = value === undefined ? null : patrolStore.judge(point, value)
                    const pointReadings = readingsByPoint.get(point.id) ?? []
                    const siteSaved = pointReadings.find((reading) => reading.source === 'site')
                    const externalSaved = pointReadings.find((reading) => reading.source === 'external')
                    const dualValue = siteSaved && externalSaved && siteSaved.value !== externalSaved.value
                    return (
                      <div
                        key={point.id}
                        className="panel"
                        style={{
                          padding: 12,
                          borderColor: dualValue ? '#f53f3f' : undefined
                        }}
                      >
                        <div className="card-list-item__head">
                          <span>
                            {point.name}
                            {point.isCritical ? <Tag color="orange" size="small" style={{ marginLeft: 6 }}>关键点</Tag> : null}
                            {dualValue ? (
                              <Tag color="red" size="small" style={{ marginLeft: 6 }}>
                                同点双值待核查
                              </Tag>
                            ) : null}
                          </span>
                          {judgement ? <AbnormalTag level={judgement.level} deviationPct={judgement.deviationPct} size="small" /> : null}
                        </div>
                        <div className="card-list-item__meta">
                          <span>
                            现行标准 v{point.standardRevision}：{point.standardMin} ~ {point.standardMax} {point.unit}
                          </span>
                        </div>
                        <div className="card-list-item__meta" style={{ gap: 12 }}>
                          <span style={{ color: siteSaved ? '#165dff' : '#86909c' }}>
                            巡检班{siteSaved ? ` ${siteSaved.value}（按 v${siteSaved.standardRevision}）` : ' 未录'}
                          </span>
                          <span style={{ color: externalSaved ? '#722ed1' : '#86909c' }}>
                            外检班{externalSaved ? ` ${externalSaved.value}（按 v${externalSaved.standardRevision}）` : ' 未录'}
                          </span>
                        </div>
                        <Space style={{ marginTop: 8 }}>
                          <InputNumber
                            size="small"
                            style={{ width: 140 }}
                            value={value}
                            step={point.unit === 'ppm' ? 1 : 0.01}
                            placeholder={`${READING_SOURCE_LABEL[entrySource]}读数`}
                            onChange={(next: number | undefined) => {
                              if (next === undefined) return
                              patrolStore.setReadingDraft(activePatrol.id, point.id, Number(next), entrySource)
                            }}
                          />
                          <Button
                            size="small"
                            disabled={value === undefined}
                            onClick={async () => {
                              if (value === undefined) return
                              const existing = (readingsByPoint.get(point.id) ?? []).find(
                                (reading) => reading.source === entrySource
                              )
                              await patrolStore.saveSingleReading(
                                activePatrol.id,
                                point,
                                value,
                                existing ? existing.note : '',
                                entrySource
                              )
                              Message.success(
                                syncStore.offline
                                  ? `${point.name} 读数已本地暂存，恢复后合并`
                                  : `${point.name} ${READING_SOURCE_LABEL[entrySource]}读数已保存`
                              )
                            }}
                          >
                            保存
                          </Button>
                        </Space>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="panel-head">
                <h4 className="panel-title" style={{ margin: 0 }}>已保存读数（两班组，共 {activeReadings.length} 条）</h4>
                {syncStore.pendingReadings.some((reading) => reading.patrolId === activePatrol.id) ? (
                  <Button size="small" onClick={() => navigate('/sync')}>
                    有暂存读数待合并 →
                  </Button>
                ) : null}
              </div>
              {activeReadings.length === 0 ? (
                <EmptyPanel title="暂无已保存读数" description="录入后点击「保存读数」或逐点保存；断网时自动进入本地暂存。" compact />
              ) : (
                <Table<Reading>
                  rowKey="id"
                  size="small"
                  border
                  data={activeReadings}
                  columns={readingColumns}
                  pagination={false}
                  scroll={{ x: 1240 }}
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
        title={`现场备注 · ${noteTarget ? READING_SOURCE_LABEL[noteTarget.source] : ''}`}
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
