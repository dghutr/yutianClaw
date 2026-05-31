const YUTIAN_PUBLIC_MODEL_NAME = '誉天大模型'

export function isYutianProviderKey(providerKey?: string | null): boolean {
  return Boolean(providerKey && (providerKey === 'yutian' || providerKey.startsWith('yutian-')))
}

export function getYutianProviderType(providerKey?: string | null): string | undefined {
  void providerKey
  return undefined
}

export function formatProviderDisplayName(providerKey?: string | null): string | undefined {
  if (!providerKey) return undefined
  if (isYutianProviderKey(providerKey)) return YUTIAN_PUBLIC_MODEL_NAME
  return providerKey
}

export function formatModelDisplayName(
  providerKey: string | undefined | null,
  modelId: string | undefined | null,
  modelName?: string
): string {
  if (isYutianProviderKey(providerKey)) {
    return YUTIAN_PUBLIC_MODEL_NAME
  }
  return modelName || modelId || ''
}

export function formatModelPathLabel(
  providerKey: string | undefined | null,
  modelId: string | undefined | null,
  modelName?: string
): string {
  if (isYutianProviderKey(providerKey)) {
    return YUTIAN_PUBLIC_MODEL_NAME
  }
  const displayName = formatModelDisplayName(providerKey, modelId, modelName)
  const providerName = formatProviderDisplayName(providerKey)
  return providerName ? `${displayName} · ${providerName}` : displayName
}

export function formatYutianPublicModelName(providerKey?: string | null): string {
  void providerKey
  return YUTIAN_PUBLIC_MODEL_NAME
}

export function replaceInternalYutianModelNames(
  text: string | undefined | null,
  providerKey?: string | null
): string {
  if (!text) return ''
  if (!isYutianProviderKey(providerKey)) return text

  const publicName = formatYutianPublicModelName(providerKey)
  return text
    .replace(/(?:MiniMax|Minimax|minimax)[-\s]?M2\.5/gi, publicName)
    .replace(/DeepSeek[-\s]?V4[-\s]?Pro/gi, publicName)
}

export function formatQualifiedModelPath(value?: string | null, modelName?: string): string {
  const trimmed = value?.trim() || ''
  if (!trimmed) return ''
  const separator = trimmed.indexOf('/')
  if (separator <= 0) return modelName || trimmed
  return formatModelPathLabel(trimmed.slice(0, separator), trimmed.slice(separator + 1), modelName)
}
