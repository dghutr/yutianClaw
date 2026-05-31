import { useCallback, useRef, useState } from 'react'
import type { UploadFile } from 'antd'
import type { AttachmentPayload } from '../../../hooks/useGatewayWs'
import { buildAttachmentPayloads } from '../chat-page.utils'

interface UseChatComposerArgs {
  sendMessage: (text: string, attachments?: AttachmentPayload[]) => boolean
  beforeSend?: () => boolean | Promise<boolean>
}

export function useChatComposer({ sendMessage, beforeSend }: UseChatComposerArgs) {
  const [inputValue, setInputValue] = useState('')
  const [attachFiles, setAttachFiles] = useState<UploadFile[]>([])
  const [attachOpen, setAttachOpen] = useState(false)
  const attachRef = useRef(null)

  const handleSend = useCallback(
    (text: string): void => {
      if (!text.trim() && !attachFiles.length) return

      const doSend = async (): Promise<void> => {
        if (beforeSend) {
          const allowed = await beforeSend()
          if (!allowed) return
        }

        let payloads: AttachmentPayload[] | undefined
        if (attachFiles.length > 0) {
          payloads = await buildAttachmentPayloads(attachFiles)
        }

        const accepted = sendMessage(text, payloads)
        if (!accepted) return

        if (payloads?.length) {
          setAttachFiles([])
          setAttachOpen(false)
        }
        setInputValue('')
      }

      void doSend()
    },
    [attachFiles, beforeSend, sendMessage]
  )

  return {
    inputValue,
    setInputValue,
    attachFiles,
    setAttachFiles,
    attachOpen,
    setAttachOpen,
    attachRef,
    handleSend,
  }
}
