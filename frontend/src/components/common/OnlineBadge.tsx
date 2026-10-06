/**
 * <OnlineBadge> 联网/断网状态与合并队列徽标
 * 点击切换断网模拟；恢复联网时自动合并现场暂存。
 * 被应用外壳、巡检录入、合并中心页消费。
 */
import { Badge, Button, Space, Tag } from '@arco-design/web-react'
import { useSyncStore } from '@/stores/syncStore'

export interface OnlineBadgeProps {
  compact?: boolean
}

export function OnlineBadge({ compact = false }: OnlineBadgeProps) {
  const syncStore = useSyncStore()
  const pending = syncStore.pendingCount()
  const failed = syncStore.failedCount()

  return (
    <Space size={8} wrap>
      <Tag color={syncStore.online ? 'green' : 'red'} style={{ fontWeight: 600 }}>
        {syncStore.online ? '● 联网（外检可录 / 自动合并）' : '○ 现场断网（仅巡检班离线暂存）'}
      </Tag>
      {pending > 0 ? <Badge count={pending} text={`待合并 ${pending}`} color="#ff7d00" /> : null}
      {failed > 0 ? <Badge count={failed} text={`合并失败 ${failed}`} color="#f53f3f" /> : null}
      <Button
        size="small"
        loading={syncStore.flushing}
        status={syncStore.online ? 'warning' : 'success'}
        onClick={() => {
          void syncStore.setOnline(!syncStore.online)
        }}
      >
        {syncStore.online ? '模拟断网' : '恢复联网并合并'}
      </Button>
      {!compact && syncStore.online && (pending > 0 || failed > 0) ? (
        <Button
          size="small"
          loading={syncStore.flushing}
          onClick={() => {
            void syncStore.flushAll()
          }}
        >
          立即重试合并
        </Button>
      ) : null}
    </Space>
  )
}

export default OnlineBadge
