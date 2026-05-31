import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../hooks/useGatewayWs'

const BOTTOM_THRESHOLD = 96

function isNearBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD
}

export function useChatConnectionUi(
  status: string,
  messages: ChatMessage[],
  sessionKey: string | null
) {
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const wasNearBottomRef = useRef(true)
  const pendingSessionScrollRef = useRef(false)
  const [showConnectingSpinner, setShowConnectingSpinner] = useState(false)

  const updateScrollAnchor = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    wasNearBottomRef.current = isNearBottom(el)
  }, [])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    updateScrollAnchor()
    el.addEventListener('scroll', updateScrollAnchor, { passive: true })
    return () => el.removeEventListener('scroll', updateScrollAnchor)
  }, [updateScrollAnchor])

  useEffect(() => {
    pendingSessionScrollRef.current = true
  }, [sessionKey])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    if (pendingSessionScrollRef.current || wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight
      wasNearBottomRef.current = true
      if (messages.length > 0 || !sessionKey) {
        pendingSessionScrollRef.current = false
      }
    }
  }, [messages, sessionKey])

  useEffect(() => {
    const isConnecting = status === 'connecting' || status === 'handshaking'
    if (!isConnecting) {
      setShowConnectingSpinner(false)
      return
    }
    const timer = setTimeout(() => setShowConnectingSpinner(true), 400)
    return () => clearTimeout(timer)
  }, [status])

  return { messagesContainerRef, showConnectingSpinner }
}
