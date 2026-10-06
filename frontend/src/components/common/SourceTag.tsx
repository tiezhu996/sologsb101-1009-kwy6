/**
 * <SourceTag> 读数来源（巡检班现场值 / 外检班原值）与合并状态标签
 * 被巡检录入、异常分级、同步中心、读数台账等页面消费。
 */
import { Tag } from '@arco-design/web-react'
import type { ReadingSource, ReadingSyncState, SiteVerifyState } from '@/types/source'
import { READING_SOURCE_LABEL, READING_SYNC_LABEL, SITE_VERIFY_LABEL } from '@/types/source'

export interface SourceTagProps {
  source: ReadingSource
  syncState?: ReadingSyncState
  verifyState?: SiteVerifyState
  size?: 'small' | 'default'
}

const SYNC_COLOR: Record<ReadingSyncState, string> = {
  local: 'gray',
  synced: 'green',
  conflict: 'red',
  resolved: 'arcoblue',
  failed: 'orange'
}

const VERIFY_COLOR: Record<SiteVerifyState, string> = {
  none: 'gray',
  pending: 'orange',
  confirmed: 'green',
  discarded: 'gray'
}

export function SourceTag({ source, syncState, verifyState, size = 'small' }: SourceTagProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      <Tag color={source === 'site' ? 'arcoblue' : 'purple'} size={size}>
        {READING_SOURCE_LABEL[source]}
      </Tag>
      {syncState && syncState !== 'synced' ? (
        <Tag color={SYNC_COLOR[syncState]} size={size}>
          {READING_SYNC_LABEL[syncState]}
        </Tag>
      ) : null}
      {verifyState && verifyState !== 'none' ? (
        <Tag color={VERIFY_COLOR[verifyState]} size={size}>
          {SITE_VERIFY_LABEL[verifyState]}
        </Tag>
      ) : null}
    </span>
  )
}

export default SourceTag
