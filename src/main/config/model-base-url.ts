const OPENAI_COMPATIBLE_APIS = new Set(['openai-completions', 'openai-responses'])
const YUTIAN_MODEL_HOSTS = new Set(['x.yutianedu.com', 'claw.yutianedu.com'])

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function normalizeYutianBaseUrl(baseUrl: string): string {
  const trimmed = trimBaseUrl(baseUrl)
  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    if (!YUTIAN_MODEL_HOSTS.has(host)) return trimmed

    const pathname = url.pathname.replace(/\/+$/, '')
    if (host === 'x.yutianedu.com') {
      if (!pathname || pathname === '/' || pathname === '/v1') {
        url.pathname = '/api/proxy/v1'
        url.search = ''
        url.hash = ''
        return trimBaseUrl(url.toString())
      }

      for (const suffix of ['/chat/completions', '/completions', '/responses', '/messages']) {
        if (pathname.toLowerCase().endsWith(suffix)) {
          url.pathname = pathname.slice(0, -suffix.length) || '/'
          url.search = ''
          url.hash = ''
          return trimBaseUrl(url.toString())
        }
      }

      return trimmed
    }

    if (!pathname || pathname === '/') {
      url.pathname = '/v1'
      url.search = ''
      url.hash = ''
      return trimBaseUrl(url.toString())
    }

    return trimmed
  } catch {
    return trimmed
  }
}

export function normalizeModelBaseUrlForRuntime(
  baseUrl: string | undefined,
  api: string | undefined
): string {
  if (!baseUrl) return ''
  const trimmed = trimBaseUrl(baseUrl)
  if (!OPENAI_COMPATIBLE_APIS.has(api || '')) return trimmed
  return normalizeYutianBaseUrl(trimmed)
}
