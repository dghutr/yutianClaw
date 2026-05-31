import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type { SlashCommandNode } from './useChatCommands'

interface SlashTokenContext {
  start: number
  end: number
  query: string
}

interface UseSlashCommandMenuArgs {
  commands: SlashCommandNode[]
  onApplyCommand: (nextValue: string, cursor: number) => void
}

interface UseSlashCommandMenuReturn {
  open: boolean
  level: number
  query: string
  pathLabels: string[]
  canGoBack: boolean
  items: SlashCommandNode[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  goBack: () => void
  closeMenu: () => void
  handleInputChange: (value: string, cursor: number) => void
  handleKeyDown: (event: React.KeyboardEvent, value: string) => boolean
  handleItemClick: (index: number, value: string) => void
}

function getSlashTokenContext(value: string, cursor: number): SlashTokenContext | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length))
  let start = safeCursor - 1
  while (start >= 0 && !/\s/.test(value[start])) {
    start -= 1
  }
  const tokenStart = start + 1

  let end = safeCursor
  while (end < value.length && !/\s/.test(value[end])) {
    end += 1
  }

  const token = value.slice(tokenStart, end)
  if (!token.startsWith('/')) return null

  return {
    start: tokenStart,
    end,
    query: token.slice(1).toLowerCase(),
  }
}

function matchNode(node: SlashCommandNode, query: string): boolean {
  const text = `${node.label} ${node.insertText || ''} ${node.description || ''} ${(
    node.keywords || []
  ).join(' ')}`.toLowerCase()
  return text.includes(query)
}

function matchNodeDeep(node: SlashCommandNode, query: string): boolean {
  if (matchNode(node, query)) return true
  return (node.children || []).some((child) => matchNodeDeep(child, query))
}

function findLevel(commands: SlashCommandNode[], path: string[]): SlashCommandNode[] {
  let current = commands
  for (const id of path) {
    const matched = current.find((item) => item.id === id)
    if (!matched?.children?.length) return []
    current = matched.children
  }
  return current
}

function getPathLabels(commands: SlashCommandNode[], path: string[]): string[] {
  const labels: string[] = []
  let current = commands
  for (const id of path) {
    const matched = current.find((item) => item.id === id)
    if (!matched) break
    labels.push(matched.label)
    current = matched.children || []
  }
  return labels
}

export function useSlashCommandMenu({
  commands,
  onApplyCommand,
}: UseSlashCommandMenuArgs): UseSlashCommandMenuReturn {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [path, setPath] = useState<string[]>([])
  const [tokenContext, setTokenContext] = useState<SlashTokenContext | null>(null)

  const currentLevelItems = useMemo(() => findLevel(commands, path), [commands, path])
  const pathLabels = useMemo(() => getPathLabels(commands, path), [commands, path])
  const query = tokenContext?.query ?? ''
  const canGoBack = path.length > 0

  const items = useMemo(() => {
    const normalizedQuery = tokenContext?.query?.trim() || ''
    if (!normalizedQuery) return currentLevelItems
    if (path.length === 0) {
      return commands.filter((item) => matchNodeDeep(item, normalizedQuery))
    }
    return currentLevelItems.filter((item) => matchNode(item, normalizedQuery))
  }, [commands, currentLevelItems, path.length, tokenContext?.query])

  useEffect(() => {
    if (!items.length) {
      setActiveIndex(0)
      return
    }
    setActiveIndex((prev) => Math.min(prev, items.length - 1))
  }, [items])

  const closeMenu = useCallback(() => {
    setOpen(false)
    setPath([])
    setActiveIndex(0)
    setTokenContext(null)
  }, [])

  const goBack = useCallback(() => {
    setPath((prev) => prev.slice(0, -1))
    setActiveIndex(0)
  }, [])

  const applyLeaf = useCallback(
    (node: SlashCommandNode, value: string) => {
      if (!tokenContext) return
      const insertText = node.insertText || node.label
      const nextValue = `${value.slice(0, tokenContext.start)}${insertText} ${value.slice(tokenContext.end)}`
      const cursor = tokenContext.start + insertText.length + 1
      onApplyCommand(nextValue, cursor)
      closeMenu()
    },
    [closeMenu, onApplyCommand, tokenContext]
  )

  const handleInputChange = useCallback((value: string, cursor: number) => {
    const nextToken = getSlashTokenContext(value, cursor)
    if (!nextToken) {
      setOpen(false)
      setPath([])
      setTokenContext(null)
      setActiveIndex(0)
      return
    }
    setOpen(true)
    setTokenContext(nextToken)
  }, [])

  const openOrApply = useCallback(
    (node: SlashCommandNode, value: string) => {
      if (node.children?.length) {
        setPath((prev) => [...prev, node.id])
        setActiveIndex(0)
        return
      }
      applyLeaf(node, value)
    },
    [applyLeaf]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, value: string): boolean => {
      if (!open) return false

      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return true
      }

      if (event.key === 'Backspace' && canGoBack && !query) {
        event.preventDefault()
        goBack()
        return true
      }

      if (!items.length) return false

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((prev) => (prev + 1) % items.length)
        return true
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((prev) => (prev - 1 + items.length) % items.length)
        return true
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        openOrApply(items[activeIndex], value)
        return true
      }

      return false
    },
    [activeIndex, canGoBack, closeMenu, goBack, items, open, openOrApply, query]
  )

  const handleItemClick = useCallback(
    (index: number, value: string) => {
      const node = items[index]
      if (!node) return
      setActiveIndex(index)
      openOrApply(node, value)
    },
    [items, openOrApply]
  )

  return {
    open,
    level: path.length,
    query,
    pathLabels,
    canGoBack,
    items,
    activeIndex,
    setActiveIndex,
    goBack,
    closeMenu,
    handleInputChange,
    handleKeyDown,
    handleItemClick,
  }
}
