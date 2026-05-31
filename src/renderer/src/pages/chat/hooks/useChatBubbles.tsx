import { useMemo, useState, type ReactNode } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import { Think } from '@ant-design/x'
import type { BubbleListProps } from '@ant-design/x'
import { Avatar, Button } from 'antd'
import {
  AudioOutlined,
  CopyOutlined,
  ExportOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import type { AttachmentPayload, ChatMessage, ChatToolCall } from '../../../hooks/useGatewayWs'
import {
  formatModelPathLabel,
  isYutianProviderKey,
  replaceInternalYutianModelNames,
} from '../../../utils/modelDisplay'

interface UseChatBubblesArgs {
  messages: ChatMessage[]
  tokenColorTextSecondary: string
  showThinking: boolean
  showToolCalls: boolean
  showUsage: boolean
  onCopied: () => void
}

interface MarkdownElementProps {
  children?: ReactNode
  className?: string
  href?: string
  src?: string
  alt?: string
  title?: string
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}

function shortenModelName(model?: string): string | undefined {
  if (!model) return undefined
  const parts = model.split('/')
  return parts[parts.length - 1] || model
}

function formatAssistantModelMeta(model?: string, provider?: string): string[] {
  if (isYutianProviderKey(provider)) {
    return [formatModelPathLabel(provider, model)]
  }
  return [shortenModelName(model), provider].filter((item): item is string => Boolean(item))
}

function toLocalMediaSrc(src?: string): string | undefined {
  if (!src) return src
  if (src.startsWith('/')) {
    return `app://local-file/open?path=${encodeURIComponent(src)}`
  }
  if (!src.startsWith('file://')) return src
  try {
    const parsed = new URL(src)
    let localPath = decodeURIComponent(parsed.pathname || '')
    if (/^\/[A-Za-z]:\//.test(localPath)) {
      localPath = localPath.slice(1)
    }
    return `app://local-file/open?path=${encodeURIComponent(localPath)}`
  } catch {
    return src
  }
}

function rewriteLocalFileImages(markdown: string): string {
  if (!markdown) return markdown
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, alt, rawUrl) => {
    const mapped = toLocalMediaSrc(rawUrl) || rawUrl
    return `![${alt}](${mapped})`
  })
}

function localPathToAppUrl(localPath: string): string {
  return `app://local-file/open?path=${encodeURIComponent(localPath)}`
}

function getAttachmentLabel(att: AttachmentPayload): string {
  return att.fileName || att.localPath?.split(/[\\/]/).filter(Boolean).pop() || 'attachment'
}

function getAttachmentImageSrc(att: AttachmentPayload): string | undefined {
  if (att.localPath) return localPathToAppUrl(att.localPath)
  if (att.content) return `data:${att.mimeType};base64,${att.content}`
  return undefined
}

function openAttachment(att: AttachmentPayload): void {
  if (!att.localPath) return
  window.api.shell.openPath(att.localPath).catch(() => {})
}

type AttachmentKind = 'image' | 'pdf' | 'video' | 'audio' | 'document'

interface AttachmentPresentation {
  kind: AttachmentKind
  label: string
  action: string
  icon: ReactNode
  accent: string
  soft: string
  border: string
}

const ATTACHMENT_PRESENTATIONS: Record<AttachmentKind, AttachmentPresentation> = {
  image: {
    kind: 'image',
    label: '图片',
    action: '打开图片',
    icon: <FileImageOutlined />,
    accent: '#1677ff',
    soft: '#eef6ff',
    border: '#cfe7ff',
  },
  pdf: {
    kind: 'pdf',
    label: 'PDF',
    action: '打开 PDF',
    icon: <FilePdfOutlined />,
    accent: '#ff4d4f',
    soft: '#fff1f0',
    border: '#ffd8d4',
  },
  video: {
    kind: 'video',
    label: '视频',
    action: '打开视频',
    icon: <VideoCameraOutlined />,
    accent: '#722ed1',
    soft: '#f6f0ff',
    border: '#dfd0ff',
  },
  audio: {
    kind: 'audio',
    label: '音频',
    action: '打开音频',
    icon: <AudioOutlined />,
    accent: '#13a8a8',
    soft: '#e6fffb',
    border: '#b5f5ec',
  },
  document: {
    kind: 'document',
    label: '文件',
    action: '打开文件',
    icon: <FileTextOutlined />,
    accent: '#fa8c16',
    soft: '#fff7e6',
    border: '#ffe0b2',
  },
}

function getAttachmentKind(att: AttachmentPayload): AttachmentKind {
  if (att.category === 'image' || att.mimeType.startsWith('image/')) return 'image'
  if (att.category === 'video' || att.mimeType.startsWith('video/')) return 'video'
  if (att.category === 'audio' || att.mimeType.startsWith('audio/')) return 'audio'
  if (att.mimeType === 'application/pdf' || /\.pdf$/i.test(getAttachmentLabel(att))) return 'pdf'
  return 'document'
}

function getAttachmentLocationLabel(att: AttachmentPayload, tokenColorTextSecondary: string): ReactNode {
  if (att.localPath) {
    const pathParts = att.localPath.split(/[\\/]/).filter(Boolean)
    const parent = pathParts.length > 1 ? pathParts[pathParts.length - 2] : ''
    return parent ? `保存在 ${parent}` : '本地文件'
  }
  if (att.mimeType) return att.mimeType
  return <span style={{ color: tokenColorTextSecondary }}>附件</span>
}

function AttachmentCard({
  att,
  tokenColorTextSecondary,
}: {
  att: AttachmentPayload
  tokenColorTextSecondary: string
}): ReactNode {
  const [imageFailed, setImageFailed] = useState(false)
  const label = getAttachmentLabel(att)
  const kind = getAttachmentKind(att)
  const presentation = ATTACHMENT_PRESENTATIONS[kind]
  const imageSrc = kind === 'image' ? getAttachmentImageSrc(att) : undefined
  const canOpen = Boolean(att.localPath)
  const showImagePreview = Boolean(imageSrc && !imageFailed)

  return (
    <div
      title={att.localPath || label}
      style={{
        width: 'min(100%, 330px)',
        border: `1px solid ${presentation.border}`,
        borderRadius: 12,
        padding: 10,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        background: `linear-gradient(135deg, #ffffff 0%, ${presentation.soft} 100%)`,
        boxShadow: '0 10px 26px rgba(15, 23, 42, 0.06)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => canOpen && openAttachment(att)}
        disabled={!canOpen}
        style={{
          width: 72,
          height: 58,
          border: 'none',
          borderRadius: 10,
          padding: 0,
          flex: '0 0 auto',
          overflow: 'hidden',
          color: '#fff',
          cursor: canOpen ? 'pointer' : 'default',
          background: showImagePreview
            ? presentation.soft
            : `linear-gradient(135deg, ${presentation.accent} 0%, #ff6b4a 100%)`,
          boxShadow: `0 8px 18px ${presentation.accent}33`,
        }}
      >
        {showImagePreview ? (
          <img
            src={imageSrc}
            alt={label}
            onError={() => setImageFailed(true)}
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              objectFit: 'cover',
            }}
          />
        ) : (
          <span style={{ fontSize: 26, lineHeight: '58px' }}>{presentation.icon}</span>
        )}
      </button>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: presentation.accent,
            fontSize: 12,
            fontWeight: 700,
            marginBottom: 2,
          }}
        >
          {presentation.icon}
          <span>{presentation.label}</span>
        </div>
        <div
          style={{
            color: '#182235',
            fontSize: 14,
            fontWeight: 700,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
        <div
          style={{
            color: tokenColorTextSecondary,
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 2,
          }}
        >
          {getAttachmentLocationLabel(att, tokenColorTextSecondary)}
        </div>
      </div>

      <Button
        size="small"
        type="primary"
        icon={<ExportOutlined />}
        disabled={!canOpen}
        onClick={() => openAttachment(att)}
        style={{
          flex: '0 0 auto',
          borderColor: presentation.accent,
          background: presentation.accent,
          boxShadow: `0 8px 16px ${presentation.accent}33`,
        }}
      >
        {presentation.action}
      </Button>
    </div>
  )
}

function AttachmentList({
  attachments,
  tokenColorTextSecondary,
}: {
  attachments?: AttachmentPayload[]
  tokenColorTextSecondary: string
}): ReactNode {
  if (!attachments?.length) return null

  return (
    <div style={{ marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {attachments.map((att, i) => {
        const label = getAttachmentLabel(att)
        if (att.localPath || att.content) {
          return (
            <AttachmentCard
              key={`${label}-${i}`}
              att={att}
              tokenColorTextSecondary={tokenColorTextSecondary}
            />
          )
        }

        return (
          <span key={`${label}-${i}`} style={{ fontSize: 12, color: tokenColorTextSecondary }}>
            <FileOutlined style={{ marginRight: 4 }} />
            {label}
          </span>
        )
      })}
    </div>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeParseJson(text?: string): unknown | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function oneLine(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}...`
}

function compactValue(value: unknown, maxLength = 1200): string {
  if (value === undefined) return ''
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) || String(value)
  if (raw.length <= maxLength) return raw
  return `${raw.slice(0, maxLength - 1)}...`
}

function collectRecords(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return []

  const records: Record<string, unknown>[] = [value]
  for (const key of ['data', 'payload', 'args', 'arguments']) {
    const nested = value[key]
    if (isRecord(nested)) records.push(nested)
  }
  return records
}

function readString(value: unknown, keys: string[]): string | undefined {
  for (const record of collectRecords(value)) {
    for (const key of keys) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate
      if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate)
    }
  }
  return undefined
}

function formatProcessName(name: string): string {
  const labels: Record<string, string> = {
    exec: '运行命令',
    message: '阶段消息',
    session_status: '会话状态',
    apply_patch: '修改文件',
    browser: '浏览器操作',
  }
  return labels[name] || name.replace(/[_-]+/g, ' ')
}

function statusLabel(status: ChatToolCall['status']): string {
  if (status === 'loading') return '进行中'
  if (status === 'error') return '异常'
  return '完成'
}

function statusColor(status: ChatToolCall['status']): string {
  if (status === 'loading') return '#1677ff'
  if (status === 'error') return '#ff4d4f'
  return '#52c41a'
}

function summarizeToolCall(toolCall: ChatToolCall): string {
  const args = safeParseJson(toolCall.argumentsText)
  const result = safeParseJson(toolCall.resultText)
  const command = readString(args, ['command', 'cmd', 'script'])
  if (command) return `运行：${oneLine(command)}`

  const phaseMessage = readString(args, ['message', 'text', 'content', 'summary'])
  if (phaseMessage) return oneLine(phaseMessage)

  const status = readString(args, ['status', 'state', 'phase'])
  if (status) return `状态：${oneLine(status)}`

  const resultMessage = readString(result, [
    'summary',
    'message',
    'text',
    'content',
    'output',
    'stdout',
    'stderr',
  ])
  if (resultMessage) return oneLine(resultMessage)

  if (toolCall.status === 'loading') return '正在处理当前步骤...'
  if (toolCall.status === 'error') return '执行异常，展开可查看返回信息。'
  return '当前步骤已完成。'
}

function ToolProcessLog({
  toolCalls,
  tokenColorTextSecondary,
}: {
  toolCalls: ChatToolCall[]
  tokenColorTextSecondary: string
}) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: 10,
        borderRadius: 8,
        border: '1px solid rgba(5,5,5,0.08)',
        background: 'rgba(0,0,0,0.025)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>推理与执行过程</div>
      {toolCalls.map((toolCall, index) => {
        const args = safeParseJson(toolCall.argumentsText)
        const result = safeParseJson(toolCall.resultText)
        const hasDetails = Boolean(toolCall.argumentsText || toolCall.resultText)
        const color = statusColor(toolCall.status)

        return (
          <div
            key={toolCall.id}
            style={{
              display: 'grid',
              gap: 6,
              padding: '8px 0',
              borderTop: index === 0 ? 'none' : '1px solid rgba(5,5,5,0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span
                style={{
                  width: 48,
                  flexShrink: 0,
                  borderRadius: 999,
                  padding: '1px 7px',
                  color,
                  border: `1px solid ${color}`,
                  fontSize: 11,
                  lineHeight: '18px',
                  textAlign: 'center',
                  background: '#fff',
                }}
              >
                {statusLabel(toolCall.status)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                步骤 {index + 1} · {formatProcessName(toolCall.name)}
              </span>
            </div>
            <div style={{ fontSize: 13, color: tokenColorTextSecondary, lineHeight: 1.6 }}>
              {summarizeToolCall(toolCall)}
            </div>
            {hasDetails ? (
              <details open={toolCall.status === 'error'}>
                <summary
                  style={{
                    cursor: 'pointer',
                    fontSize: 12,
                    color: tokenColorTextSecondary,
                  }}
                >
                  查看细节
                </summary>
                <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
                  {toolCall.argumentsText ? (
                    <pre
                      style={{
                        margin: 0,
                        padding: 8,
                        borderRadius: 6,
                        background: 'rgba(0,0,0,0.04)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: 12,
                        color: tokenColorTextSecondary,
                      }}
                    >
                      {compactValue(args)}
                    </pre>
                  ) : null}
                  {toolCall.resultText ? (
                    <pre
                      style={{
                        margin: 0,
                        padding: 8,
                        borderRadius: 6,
                        background: 'rgba(0,0,0,0.04)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: 12,
                        color: tokenColorTextSecondary,
                      }}
                    >
                      {compactValue(result)}
                    </pre>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function StreamingProcessPlaceholder({
  tokenColorTextSecondary,
}: {
  tokenColorTextSecondary: string
}) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        minWidth: 260,
        padding: 10,
        borderRadius: 8,
        border: '1px solid rgba(255,77,42,0.18)',
        background: 'rgba(255,77,42,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#ff4d2a',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>正在分析请求</span>
      </div>
      <div style={{ fontSize: 13, color: tokenColorTextSecondary, lineHeight: 1.6 }}>
        已开始处理，正在等待模型返回首段可展示内容。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {['连接模型', '整理上下文', '等待输出'].map((label) => (
          <span
            key={label}
            style={{
              borderRadius: 999,
              border: '1px solid rgba(5,5,5,0.08)',
              background: '#fff',
              padding: '2px 8px',
              fontSize: 12,
              color: tokenColorTextSecondary,
            }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function useChatBubbles({
  messages,
  tokenColorTextSecondary,
  showThinking,
  showToolCalls,
  showUsage,
  onCopied,
}: UseChatBubblesArgs): {
  bubbleItems: BubbleListProps['items']
  bubbleRoles: BubbleListProps['role']
} {
  const markdownComponents = useMemo(
    () => ({
      img: (props: { src?: string; alt?: string; title?: string }): React.ReactElement => {
        const mappedSrc = toLocalMediaSrc(props.src)
        return (
          <img
            src={mappedSrc}
            alt={props.alt}
            title={props.title}
            style={{ maxWidth: '100%', borderRadius: 8 }}
          />
        )
      },
      p: (props: MarkdownElementProps): React.ReactElement => (
        <p style={{ margin: '0 0 0.75em', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {props.children}
        </p>
      ),
      li: (props: MarkdownElementProps): React.ReactElement => (
        <li style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{props.children}</li>
      ),
      a: (props: MarkdownElementProps): React.ReactElement => (
        <a
          href={props.href}
          title={props.title}
          target="_blank"
          rel="noreferrer"
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}
        >
          {props.children}
        </a>
      ),
      pre: (props: MarkdownElementProps): React.ReactElement => (
        <pre
          className={props.className}
          style={{
            maxWidth: '100%',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}
        >
          {props.children}
        </pre>
      ),
      code: (props: MarkdownElementProps): React.ReactElement => (
        <code
          className={props.className}
          style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}
        >
          {props.children}
        </code>
      ),
      table: (props: MarkdownElementProps): React.ReactElement => (
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <table style={{ maxWidth: '100%', borderCollapse: 'collapse' }}>{props.children}</table>
        </div>
      ),
    }),
    []
  )
  const markdownDompurifyConfig = useMemo(
    () => ({
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|app|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    }),
    []
  )

  const bubbleItems: BubbleListProps['items'] = useMemo(
    () =>
      messages
        .map((chatMsg) => {
          const displayContent =
            chatMsg.role === 'assistant'
              ? replaceInternalYutianModelNames(chatMsg.content, chatMsg.provider)
              : (chatMsg.content ?? '')
          const displayThinking =
            chatMsg.role === 'assistant'
              ? replaceInternalYutianModelNames(chatMsg.thinking, chatMsg.provider)
              : (chatMsg.thinking ?? '')

          if (chatMsg.role === 'assistant') {
            const hasText = Boolean(displayContent.trim()) || Boolean(chatMsg.streaming)
            const hasThinking = showThinking && Boolean(displayThinking.trim())
            const hasTools = showToolCalls && Boolean(chatMsg.toolCalls?.length)
            const hasAttachments = Boolean(chatMsg.attachments?.length)
            const hasVisibleContent = hasText || hasThinking || hasTools || hasAttachments

            // 当前开关下没有可见内容时，整条 assistant 气泡不渲染，避免出现空白气泡
            if (!hasVisibleContent) return null
          }

          return {
            key: chatMsg.id,
            role: chatMsg.role === 'assistant' ? 'ai' : 'user',
            content:
              chatMsg.role === 'assistant' ? (
                <div
                  style={{
                    display: 'grid',
                    gap: 10,
                    minWidth: 0,
                    maxWidth: '100%',
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                  }}
                >
                  {showThinking && displayThinking ? (
                    <Think defaultExpanded>
                      <XMarkdown
                        content={rewriteLocalFileImages(displayThinking)}
                        openLinksInNewTab
                        components={markdownComponents}
                        dompurifyConfig={markdownDompurifyConfig}
                      />
                    </Think>
                  ) : null}
                  {showToolCalls && chatMsg.toolCalls && chatMsg.toolCalls.length > 0 ? (
                    <ToolProcessLog
                      toolCalls={chatMsg.toolCalls}
                      tokenColorTextSecondary={tokenColorTextSecondary}
                    />
                  ) : null}
                  <AttachmentList
                    attachments={chatMsg.attachments}
                    tokenColorTextSecondary={tokenColorTextSecondary}
                  />
                  {displayContent ? (
                    <XMarkdown
                      content={rewriteLocalFileImages(displayContent)}
                      openLinksInNewTab
                      components={markdownComponents}
                      dompurifyConfig={markdownDompurifyConfig}
                    />
                  ) : chatMsg.streaming && !displayThinking && !chatMsg.toolCalls?.length ? (
                    <StreamingProcessPlaceholder
                      tokenColorTextSecondary={tokenColorTextSecondary}
                    />
                  ) : null}
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gap: 6,
                    minWidth: 0,
                    maxWidth: 'min(680px, 68vw)',
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                  }}
                >
                  <AttachmentList
                    attachments={chatMsg.attachments}
                    tokenColorTextSecondary={tokenColorTextSecondary}
                  />
                  {displayContent ? (
                    <div
                      style={{
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                        lineHeight: 1.7,
                        textAlign: 'left',
                      }}
                    >
                      {displayContent}
                    </div>
                  ) : null}
                </div>
              ),
            // 空等待状态由上方的过程卡片承接，避免 Bubble 默认 loading 只显示三个点。
            loading: false,
            footer: !chatMsg.streaming ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: chatMsg.role === 'user' ? 'flex-end' : 'flex-start',
                  gap: 6,
                  marginTop: 2,
                }}
              >
                {showUsage &&
                  chatMsg.role === 'assistant' &&
                  (chatMsg.model || chatMsg.provider || chatMsg.usage || chatMsg.durationMs) && (
                    <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>
                      {[
                        ...formatAssistantModelMeta(chatMsg.model, chatMsg.provider),
                        chatMsg.usage ? formatCompactNumber(chatMsg.usage.totalTokens) : undefined,
                        chatMsg.durationMs
                          ? `${(chatMsg.durationMs / 1000).toFixed(1)}s`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  style={{ fontSize: 12, color: '#999', padding: '0 4px', height: 'auto' }}
                  onClick={() => {
                    navigator.clipboard.writeText(displayContent)
                    onCopied()
                  }}
                />
              </div>
            ) : undefined,
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    [
      markdownComponents,
      markdownDompurifyConfig,
      messages,
      onCopied,
      showThinking,
      showToolCalls,
      showUsage,
      tokenColorTextSecondary,
    ]
  )

  const bubbleRoles: BubbleListProps['role'] = useMemo(
    () => ({
      ai: {
        placement: 'start',
        avatar: <Avatar style={{ background: '#FF4D2A', color: '#fff', flexShrink: 0 }}>A</Avatar>,
      },
      user: {
        placement: 'end',
        avatar: <Avatar style={{ background: '#1677ff', color: '#fff', flexShrink: 0 }}>U</Avatar>,
      },
    }),
    []
  )

  return { bubbleItems, bubbleRoles }
}
