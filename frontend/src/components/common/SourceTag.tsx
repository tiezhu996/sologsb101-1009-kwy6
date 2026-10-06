/**
 * <SourceTag> 读数来源 + 核查状态标记
 * - 巡检班现场值（待核查 / 已核实 / 未采纳）
 * - 外检班原值（冻结，不可覆盖）
 * 被巡检录入、异常分级、合并中心页消费。
 */
import { Tag, Tooltip } from '@arco-design/web-react'
import { IconLock } from '@arco-design/web-react/icon'
import type { ReadingSource, ReadingVerifyStatus } from '@/types/reading'

export interface SourceTagProps {
  source: ReadingSource
  verifyStatus?: ReadingVerifyStatus
  frozen?: boolean
  size?: 'small' | 'default'
}

const VERIFY_COLOR: Record<ReadingVerifyStatus, string> = {
  待核查: 'orange',
  已核实: 'green',
  未采纳: 'gray'
}

export function SourceTag({ source, verifyStatus, frozen = false, size = 'default' }: SourceTagProps) {
  const tagSize = size === 'default' ? 'default' : 'small'
  if (source === '外检班') {
    return (
      <Tooltip content="外检班原值：只读冻结，永不被覆盖或删除">
        <Tag color="purple" size={tagSize} icon={frozen ? <IconLock /> : undefined}>
          外检原值
        </Tag>
      </Tooltip>
    )
  }
  const status = verifyStatus ?? '已核实'
  return (
    <Tooltip content={status === '待核查' ? '同一点位存在两版值，现场值待负责人核查' : `现场值 · ${status}`}>
      <Tag color={VERIFY_COLOR[status]} size={tagSize}>
        现场值{status === '已核实' ? '' : ` · ${status}`}
      </Tag>
    </Tooltip>
  )
}

export default SourceTag
