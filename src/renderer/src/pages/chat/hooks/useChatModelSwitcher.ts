import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatModelPathLabel } from '../../../utils/modelDisplay'

interface ModelCatalogEntry {
  id: string
  provider?: string | null
  name?: string
}

interface ConfiguredProvider {
  apiKey?: string
  baseUrl?: string
  api?: string
  models?: Array<{
    id: string
    name?: string
    input?: string[]
  }>
}

type DefaultModelConfig = string | { primary: string; fallbacks?: string[] } | null

interface ModelOption {
  value: string
  label: string
}

interface SessionsPatchResult {
  resolved?: {
    model?: string
    modelProvider?: string
  }
}

interface SessionsDescribeResult {
  session?: {
    model?: string
    modelProvider?: string
  } | null
}

interface UseChatModelSwitcherArgs {
  status: string
  sessionKey: string | null
  isStreaming: boolean
  callRpc: (method: string, params: unknown) => Promise<unknown>
  onSwitched?: (model: string) => void
}

function buildQualifiedModelValue(model?: string | null, provider?: string | null): string {
  const trimmedModel = model?.trim() || ''
  if (!trimmedModel) return ''
  if (trimmedModel.includes('/')) return trimmedModel
  const trimmedProvider = provider?.trim() || ''
  return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel
}

function normalizeModelValue(value?: string | null): string {
  return (value || '').trim().toLowerCase()
}

function modelValuesEqual(a?: string | null, b?: string | null): boolean {
  return Boolean(a || b) && normalizeModelValue(a) === normalizeModelValue(b)
}

function buildModelOption(entry: ModelCatalogEntry): ModelOption | null {
  const value = buildQualifiedModelValue(entry.id, entry.provider)
  if (!value) return null
  return { value, label: formatModelPathLabel(entry.provider, entry.id, entry.name) }
}

function isUsableProvider(config: ConfiguredProvider): boolean {
  return Boolean(config.apiKey?.trim() && (config.models || []).some((model) => model.id?.trim()))
}

export function useChatModelSwitcher({
  status,
  sessionKey,
  isStreaming,
  callRpc,
  onSwitched,
}: UseChatModelSwitcherArgs) {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [currentModelBySession, setCurrentModelBySession] = useState<Record<string, string>>({})
  const [defaultModel, setDefaultModel] = useState('')

  const fetchSessionModelState = useCallback(async (): Promise<{
    currentModel: string
    defaultModel: string
  }> => {
    if (status !== 'ready' || !sessionKey || isStreaming) {
      return { currentModel: '', defaultModel: '' }
    }

    const defaultConfig = (await window.api.model.getDefault()) as DefaultModelConfig
    const defaultValue =
      typeof defaultConfig === 'string' ? defaultConfig : (defaultConfig?.primary ?? '')

    const trimmedDefault = defaultValue.trim()
    try {
      const result = (await callRpc('sessions.describe', {
        key: sessionKey,
      })) as SessionsDescribeResult
      const sessionModel = buildQualifiedModelValue(
        result.session?.model,
        result.session?.modelProvider
      )
      return {
        currentModel:
          sessionModel && !modelValuesEqual(sessionModel, trimmedDefault) ? sessionModel : '',
        defaultModel: trimmedDefault,
      }
    } catch {
      return {
        currentModel: '',
        defaultModel: trimmedDefault,
      }
    }
  }, [callRpc, isStreaming, sessionKey, status])

  const loadCurrentSessionModel = useCallback(async (): Promise<void> => {
    if (status !== 'ready' || !sessionKey || isStreaming) {
      return
    }
    const state = await fetchSessionModelState()
    setCurrentModelBySession((prev) => ({ ...prev, [sessionKey]: state.currentModel }))
    setDefaultModel(state.defaultModel)
  }, [fetchSessionModelState, isStreaming, sessionKey, status])

  const currentModel = sessionKey ? (currentModelBySession[sessionKey] ?? '') : ''

  const loadModelCatalog = useCallback(async (): Promise<void> => {
    setLoadingModels(true)
    try {
      const providers = (await window.api.model.listProviders()) as Record<
        string,
        ConfiguredProvider
      >
      const entries: ModelCatalogEntry[] = []

      for (const [providerKey, config] of Object.entries(providers)) {
        if (!isUsableProvider(config)) continue
        for (const model of config.models || []) {
          if (!model.id?.trim()) continue
          entries.push({
            id: model.id,
            name: model.name,
            provider: providerKey,
          })
        }
      }

      setCatalog(entries)
    } finally {
      setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    void loadModelCatalog().catch(() => {})
  }, [loadModelCatalog])

  useEffect(() => {
    void loadCurrentSessionModel().catch(() => {})
  }, [loadCurrentSessionModel])

  const options = useMemo(() => {
    const seen = new Set<string>()
    const result: ModelOption[] = []

    const addOption = (option: ModelOption | null) => {
      if (!option) return
      const normalized = option.value.toLowerCase()
      if (seen.has(normalized)) return
      seen.add(normalized)
      result.push(option)
    }

    for (const entry of catalog) {
      addOption(buildModelOption(entry))
    }

    return result
  }, [catalog])

  const handleModelChange = useCallback(
    async (nextValue: string): Promise<void> => {
      if (!sessionKey || status !== 'ready' || switchingModel) return
      const normalizedNext = nextValue.trim()
      if (normalizedNext === currentModel) return

      const prevModel = currentModel
      setCurrentModelBySession((prev) => ({ ...prev, [sessionKey]: normalizedNext }))
      setSwitchingModel(true)
      try {
        const patchResult = (await callRpc('sessions.patch', {
          key: sessionKey,
          model: normalizedNext || null,
        })) as SessionsPatchResult

        const resolvedModel = buildQualifiedModelValue(
          patchResult.resolved?.model,
          patchResult.resolved?.modelProvider
        )

        const verifiedState = await fetchSessionModelState()
        const nextSessionModel = normalizedNext
          ? verifiedState.currentModel || resolvedModel || normalizedNext
          : ''
        setCurrentModelBySession((prev) => ({
          ...prev,
          [sessionKey]: nextSessionModel,
        }))
        setDefaultModel(verifiedState.defaultModel)

        const expectedModel = normalizedNext || verifiedState.defaultModel || defaultModel
        const actualModel = nextSessionModel || verifiedState.defaultModel

        if (
          normalizedNext &&
          expectedModel &&
          actualModel &&
          !modelValuesEqual(expectedModel, actualModel)
        ) {
          throw new Error(`Gateway resolved ${actualModel}, expected ${expectedModel}`)
        }

        console.info('[chat:model-switch]', {
          sessionKey,
          requestedModel: normalizedNext || null,
          resolvedModel: resolvedModel || null,
          verifiedModel: nextSessionModel || null,
          defaultModel: defaultModel || null,
        })

        onSwitched?.(actualModel)
      } catch (error) {
        setCurrentModelBySession((prev) => ({ ...prev, [sessionKey]: prevModel }))
        throw error
      } finally {
        setSwitchingModel(false)
      }
    },
    [
      callRpc,
      currentModel,
      defaultModel,
      fetchSessionModelState,
      onSwitched,
      sessionKey,
      status,
      switchingModel,
    ]
  )

  return {
    modelOptions: options,
    hasUsableModels: options.length > 0,
    currentModel,
    defaultModel,
    loadingModels,
    switchingModel,
    modelSelectDisabled: status !== 'ready' || isStreaming || switchingModel,
    handleModelChange,
  }
}
