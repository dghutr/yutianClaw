import { LeftOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons'
import { Empty, theme } from 'antd'
import type { TFunction } from 'i18next'
import type { SlashCommandNode } from '../hooks/useChatCommands'

interface SlashCommandPanelProps {
  items: SlashCommandNode[]
  activeIndex: number
  level: number
  query: string
  pathLabels: string[]
  canGoBack: boolean
  t: TFunction
  onHover: (index: number) => void
  onSelect: (index: number) => void
  onGoBack: () => void
}

export function SlashCommandPanel({
  items,
  activeIndex,
  level,
  query,
  pathLabels,
  canGoBack,
  t,
  onHover,
  onSelect,
  onGoBack,
}: SlashCommandPanelProps): React.ReactElement {
  const { token } = theme.useToken()

  return (
    <div
      onMouseDown={(event) => event.preventDefault()}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 'calc(100% + 8px)',
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 16,
        boxShadow: token.boxShadowSecondary,
        padding: 8,
        maxHeight: 300,
        overflowY: 'auto',
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: token.colorFillTertiary,
          borderRadius: 10,
          padding: '8px 10px',
          marginBottom: 8,
          color: token.colorTextSecondary,
          fontSize: 13,
        }}
      >
        <SearchOutlined style={{ fontSize: 12 }} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {query || t('chat.commands.panel.searchPlaceholder')}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '2px 8px 8px',
          fontSize: 12,
          color: token.colorTextTertiary,
        }}
      >
        <span>{level > 0 ? t('chat.commands.panel.submenu') : t('chat.commands.panel.root')}</span>
        {pathLabels.length > 0 ? (
          <span style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {pathLabels.join(' / ')}
          </span>
        ) : null}
      </div>

      {canGoBack ? (
        <div
          onClick={onGoBack}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 10,
            cursor: 'pointer',
            color: token.colorTextSecondary,
          }}
        >
          <LeftOutlined style={{ fontSize: 11 }} />
          <span>{t('chat.commands.panel.back')}</span>
        </div>
      ) : null}

      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('chat.commands.panel.empty')}
          styles={{ image: { height: 36 }, description: { color: token.colorTextTertiary } }}
        />
      ) : (
        items.map((item, index) => {
          const active = index === activeIndex
          return (
            <div
              key={item.id}
              onMouseEnter={() => onHover(index)}
              onClick={() => onSelect(index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 10,
                cursor: 'pointer',
                background: active ? token.colorFillSecondary : 'transparent',
              }}
            >
              <span
                style={{
                  width: 18,
                  display: 'inline-flex',
                  justifyContent: 'center',
                  color: token.colorTextSecondary,
                }}
              >
                {item.icon || null}
              </span>
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                }}
              >
                <span style={{ color: token.colorText, fontWeight: 500 }}>{item.label}</span>
                {item.description ? (
                  <span
                    style={{
                      color: token.colorTextSecondary,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.description}
                  </span>
                ) : null}
              </span>
              {item.children?.length ? (
                <RightOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
              ) : null}
            </div>
          )
        })
      )}
    </div>
  )
}
