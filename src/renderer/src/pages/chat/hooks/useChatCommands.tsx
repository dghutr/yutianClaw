import { useMemo } from 'react'
import type { TFunction } from 'i18next'
import type React from 'react'
import {
  InfoCircleOutlined,
  MessageOutlined,
  SettingOutlined,
  SoundOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons'

export interface SlashCommandNode {
  id: string
  label: string
  icon?: React.ReactNode
  description?: string
  insertText?: string
  keywords?: string[]
  children?: SlashCommandNode[]
}

export function useChatCommands(t: TFunction) {
  return useMemo(() => {
    const leaf = (value: string, descKey: string, keywords?: string[]): SlashCommandNode => ({
      id: value,
      label: value,
      insertText: value,
      description: t(`chat.commands.${descKey}`),
      keywords,
    })

    return [
      {
        id: 'group-session',
        label: t('chat.commands.groupSession'),
        icon: <MessageOutlined />,
        children: [
          leaf('/session', 'session', ['session', 'conversation']),
          leaf('/stop', 'stop', ['abort']),
          leaf('/reset', 'reset', ['clear']),
          leaf('/new', 'new', ['create']),
          leaf('/compact', 'compact', ['summary']),
        ],
      },
      {
        id: 'group-options',
        label: t('chat.commands.groupOptions'),
        icon: <ThunderboltOutlined />,
        children: [
          leaf('/usage', 'usage'),
          leaf('/think', 'think'),
          leaf('/verbose', 'verbose'),
          leaf('/reasoning', 'reasoning'),
          leaf('/elevated', 'elevated'),
          leaf('/exec', 'exec'),
          leaf('/model', 'model'),
          leaf('/models', 'models'),
          leaf('/queue', 'queue'),
        ],
      },
      {
        id: 'group-status',
        label: t('chat.commands.groupStatus'),
        icon: <InfoCircleOutlined />,
        children: [
          leaf('/help', 'help'),
          leaf('/commands', 'commands'),
          leaf('/status', 'status'),
          leaf('/context', 'context'),
          leaf('/export-session', 'exportSession'),
          leaf('/whoami', 'whoami'),
        ],
      },
      {
        id: 'group-management',
        label: t('chat.commands.groupManagement'),
        icon: <SettingOutlined />,
        children: [
          leaf('/allowlist', 'allowlist'),
          leaf('/approve', 'approve'),
          leaf('/subagents', 'subagents'),
          leaf('/acp', 'acp'),
          leaf('/focus', 'focus'),
          leaf('/unfocus', 'unfocus'),
          leaf('/agents', 'agents'),
          leaf('/kill', 'kill'),
          leaf('/steer', 'steer'),
          leaf('/activation', 'activation'),
          leaf('/send', 'send'),
        ],
      },
      {
        id: 'group-media',
        label: t('chat.commands.groupMedia'),
        icon: <SoundOutlined />,
        children: [leaf('/tts', 'tts')],
      },
      {
        id: 'group-tools',
        label: t('chat.commands.groupTools'),
        icon: <ToolOutlined />,
        children: [leaf('/skill', 'skill'), leaf('/restart', 'restart')],
      },
    ] as SlashCommandNode[]
  }, [t])
}
