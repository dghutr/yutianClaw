import { useCallback, useEffect, useMemo, useState, type SetStateAction } from 'react'
import type { GatewayAgentRow } from '../../../hooks/useGatewayWs'
import type { AgentConfig } from '../agents-page.types'

let cachedAgents: AgentConfig[] = []
let cachedSelectedId: string | null = null

export function useAgentList(
  status: string,
  listAgents: () => Promise<{ agents: GatewayAgentRow[]; defaultId?: string } | null>
) {
  const [agents, setAgents] = useState<AgentConfig[]>(() => cachedAgents)
  const [loading, setLoading] = useState(() => cachedAgents.length === 0)
  const [selectedId, setSelectedIdState] = useState<string | null>(() => cachedSelectedId)

  const setSelectedId = useCallback((value: SetStateAction<string | null>) => {
    setSelectedIdState((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      cachedSelectedId = next
      return next
    })
  }, [])

  const applyAgents = useCallback((list: AgentConfig[]) => {
    cachedAgents = list
    setAgents(list)
    setSelectedIdState((prev) => {
      const next = prev && list.some((agent) => agent.id === prev) ? prev : list[0]?.id || null
      cachedSelectedId = next
      return next
    })
  }, [])

  const loadAgents = useCallback(async () => {
    setLoading(cachedAgents.length === 0)
    try {
      const configAgents = (await window.api.agent.list()) as AgentConfig[]
      const configMap = new Map(configAgents.map((a) => [a.id, a]))

      if (status === 'ready') {
        const result = await listAgents()
        if (result) {
          const runtimeIds = new Set(result.agents.map((row) => row.id))
          const runtimeFirst: AgentConfig[] = result.agents.map((row) => {
            const conf = configMap.get(row.id)
            return {
              ...(conf || {}),
              id: row.id,
              name: row.name || row.identity?.name || conf?.name,
              identity: row.identity || conf?.identity,
              default: row.id === result.defaultId || conf?.default,
            }
          })
          const configOnly: AgentConfig[] = configAgents.filter(
            (agent) => !runtimeIds.has(agent.id)
          )
          const list: AgentConfig[] = [...runtimeFirst, ...configOnly]
          applyAgents(list)
          return
        }
      }
      const list = configAgents
      applyAgents(list)
    } finally {
      setLoading(false)
    }
  }, [applyAgents, status, listAgents])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId) || null,
    [agents, selectedId]
  )

  return {
    agents,
    loading,
    selectedId,
    selectedAgent,
    setSelectedId,
    loadAgents,
  }
}
