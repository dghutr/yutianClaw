/**
 * Skill Marketplace 抽象接口 + ClawHub / SkillHub 实现
 *
 * 通过 SkillMarketplace 接口解耦，未来可无缝接入其他 skill 市场。
 */

import { proxyFetch } from '../utils/proxy'

// ========== 共享数据类型 ==========

export interface SkillSearchResult {
  slug: string
  displayName: string
  summary: string
  version: string
  updatedAt: number
  score?: number
}

export interface SkillBrowseItem {
  slug: string
  displayName: string
  summary: string
  stats: { downloads?: number; stars?: number }
  updatedAt: number
  latestVersion?: { version: string }
}

export interface SkillBrowseResult {
  items: SkillBrowseItem[]
  nextCursor: string | null
}

export interface SkillMarketplaceInfo {
  id: string
  name: string
  baseUrl: string
}

// ========== 抽象接口 ==========

export interface SkillMarketplace extends SkillMarketplaceInfo {
  search(query: string, opts?: { limit?: number }): Promise<SkillSearchResult[]>
  browse(opts?: { limit?: number; sort?: string; cursor?: string }): Promise<SkillBrowseResult>
  download(slug: string, version?: string): Promise<Buffer>
}

async function readJsonResponse<T>(res: Response, context: string): Promise<T> {
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('json')) {
    const body = await res.text().catch(() => '')
    throw new Error(`${context}: expected JSON, got ${contentType || 'unknown'} ${body.slice(0, 120)}`)
  }
  return (await res.json()) as T
}

// ========== ClawHub 实现 ==========

export class ClawHubMarketplace implements SkillMarketplace {
  readonly id = 'clawhub'
  readonly name = 'ClawHub'
  readonly baseUrl: string

  constructor(baseUrl = 'https://clawhub.ai') {
    this.baseUrl = baseUrl
  }

  async search(query: string, opts?: { limit?: number }): Promise<SkillSearchResult[]> {
    const limit = opts?.limit ?? 20
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      nonSuspiciousOnly: 'true',
    })
    const url = `${this.baseUrl}/api/v1/search?${params.toString()}`
    const res = await proxyFetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`ClawHub search failed: HTTP ${res.status}`)
    const data = await readJsonResponse<{
      items?: SkillSearchResult[]
      results?: SkillSearchResult[]
    }>(res, 'ClawHub search')
    return data.items ?? data.results ?? []
  }

  async browse(opts?: {
    limit?: number
    sort?: string
    cursor?: string
  }): Promise<SkillBrowseResult> {
    const limit = opts?.limit ?? 20
    const requestedSort = opts?.sort ?? 'trending'

    const fetchPage = async (sort: string): Promise<SkillBrowseResult> => {
      const params = new URLSearchParams({
        sort,
        limit: String(limit),
        nonSuspiciousOnly: 'true',
      })
      if (opts?.cursor) params.set('cursor', opts.cursor)
      const url = `${this.baseUrl}/api/v1/skills?${params.toString()}`
      const res = await proxyFetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`ClawHub browse failed: HTTP ${res.status}`)
      const data = await readJsonResponse<{
        items?: SkillBrowseItem[]
        skills?: SkillBrowseItem[]
        nextCursor?: string | null
        cursor?: string | null
      }>(res, 'ClawHub browse')
      const items = data.items ?? data.skills ?? []
      const nextCursor = data.nextCursor ?? data.cursor ?? null
      return { items, nextCursor }
    }

    const first = await fetchPage(requestedSort)
    if (requestedSort === 'trending' && first.items.length === 0 && !opts?.cursor) {
      return await fetchPage('downloads')
    }
    return first
  }

  async download(slug: string, version = 'latest'): Promise<Buffer> {
    const url = `${this.baseUrl}/api/v1/download?slug=${encodeURIComponent(slug)}&tag=${encodeURIComponent(version)}`
    const res = await proxyFetch(url, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`ClawHub download failed: HTTP ${res.status}`)
    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }
}

// ========== SkillHub 实现（腾讯云加速镜像） ==========

interface SkillHubIndexItem {
  slug: string
  name: string
  description?: string
  version?: string
  updated_at?: string
  stats?: { downloads?: number; stars?: number }
}

interface SkillHubIndex {
  skills: SkillHubIndexItem[]
}

/** SkillHub 索引内存缓存（约 9MB，有效期 10 分钟） */
let skillHubIndexCache: SkillHubIndex | null = null
let skillHubIndexFetchedAt = 0
const SKILLHUB_INDEX_TTL = 10 * 60 * 1000

/** 将索引条目排序后按 sort key 排列 */
function sortSkillHubItems(items: SkillHubIndexItem[], sort: string): SkillHubIndexItem[] {
  const arr = [...items]
  switch (sort) {
    case 'downloads':
      return arr.sort((a, b) => (b.stats?.downloads ?? 0) - (a.stats?.downloads ?? 0))
    case 'stars':
      return arr.sort((a, b) => (b.stats?.stars ?? 0) - (a.stats?.stars ?? 0))
    case 'updated':
      return arr.sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0
        return tb - ta
      })
    case 'trending':
    default:
      // trending: 综合 downloads + stars 降序
      return arr.sort((a, b) => {
        const sa = (a.stats?.downloads ?? 0) + (a.stats?.stars ?? 0) * 5
        const sb = (b.stats?.downloads ?? 0) + (b.stats?.stars ?? 0) * 5
        return sb - sa
      })
  }
}

function scoreSkillHubItem(item: SkillHubIndexItem, query: string): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 1
  const slug = item.slug.toLowerCase()
  const name = item.name.toLowerCase()
  const description = (item.description ?? '').toLowerCase()
  const terms = needle.split(/\s+/).filter(Boolean)
  let score = 0

  if (slug === needle) score += 120
  if (name === needle) score += 110
  if (name.includes(needle)) score += 80
  if (slug.includes(needle)) score += 60
  if (description.includes(needle)) score += 35
  if (terms.length > 1) {
    const haystack = `${slug} ${name} ${description}`
    const matchedTerms = terms.filter((term) => haystack.includes(term)).length
    score += matchedTerms * 10
  }
  return score
}

function mapSkillHubSearchItem(item: SkillHubIndexItem, score?: number): SkillSearchResult {
  return {
    slug: item.slug,
    displayName: item.name,
    summary: item.description ?? '',
    version: item.version ?? '',
    updatedAt: item.updated_at ? new Date(item.updated_at).getTime() : 0,
    ...(score != null ? { score } : {}),
  }
}

export class SkillHubMarketplace implements SkillMarketplace {
  readonly id = 'skillhub'
  readonly name = 'SkillHub (中文镜像)'
  readonly baseUrl = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com'

  // 腾讯 CLB 搜索 & 下载（低延迟）
  private readonly clbBase = 'http://lb-3zbg86f6-0gwe3n7q8t4sv2za.clb.gz-tencentclb.com'
  // COS 静态存储（全量索引 & 下载兜底）
  private readonly cosBase = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com'

  async search(query: string, opts?: { limit?: number }): Promise<SkillSearchResult[]> {
    const limit = opts?.limit ?? 20
    const index = await this.loadIndex()
    const ranked = sortSkillHubItems(index.skills, 'trending')
      .map((item, order) => ({ item, order, score: scoreSkillHubItem(item, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)

    return ranked.map((entry) => mapSkillHubSearchItem(entry.item, entry.score))
  }

  async browse(opts?: {
    limit?: number
    sort?: string
    cursor?: string
  }): Promise<SkillBrowseResult> {
    const limit = opts?.limit ?? 20
    const sort = opts?.sort ?? 'trending'
    const offset = opts?.cursor ? parseInt(opts.cursor, 10) : 0

    const index = await this.loadIndex()
    const sorted = sortSkillHubItems(index.skills, sort)
    const page = sorted.slice(offset, offset + limit)
    const nextOffset = offset + limit
    const nextCursor = nextOffset < sorted.length ? String(nextOffset) : null

    const items: SkillBrowseItem[] = page.map((item) => ({
      slug: item.slug,
      displayName: item.name,
      summary: item.description ?? '',
      stats: item.stats ?? {},
      updatedAt: item.updated_at ? new Date(item.updated_at).getTime() : 0,
      latestVersion: item.version ? { version: item.version } : undefined,
    }))

    return { items, nextCursor }
  }

  async download(slug: string): Promise<Buffer> {
    // 先试 CLB，失败后回退 COS
    const primaryUrl = `${this.clbBase}/api/v1/download?slug=${encodeURIComponent(slug)}`
    const fallbackUrl = `${this.cosBase}/skills/${encodeURIComponent(slug)}.zip`
    try {
      const res = await proxyFetch(primaryUrl, { signal: AbortSignal.timeout(30000) })
      if (res.ok) {
        return Buffer.from(await res.arrayBuffer())
      }
    } catch {
      // CLB 不可达，走 COS fallback
    }
    const res = await proxyFetch(fallbackUrl, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`SkillHub download failed: HTTP ${res.status} for ${slug}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** 加载全量索引，内存缓存 10 分钟 */
  private async loadIndex(): Promise<SkillHubIndex> {
    const now = Date.now()
    if (skillHubIndexCache && now - skillHubIndexFetchedAt < SKILLHUB_INDEX_TTL) {
      return skillHubIndexCache
    }
    const url = `${this.cosBase}/skills.json`
    const res = await proxyFetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`SkillHub index fetch failed: HTTP ${res.status}`)
    const data = await readJsonResponse<SkillHubIndex>(res, 'SkillHub index')
    if (!Array.isArray(data.skills)) throw new Error('SkillHub index: invalid format')
    skillHubIndexCache = data
    skillHubIndexFetchedAt = now
    return data
  }
}

// ========== FindSkill 实现（skills.volces.com） ==========

interface FindSkillItem {
  Slug: string
  Name: string
  Description: string
  UpdatedAt: string
}

interface FindSkillResponse {
  Skills: FindSkillItem[]
  NextPageToken: string
}

/** FindSkill 全量索引内存缓存（约 1.3MB，有效期 10 分钟） */
let findSkillIndexCache: FindSkillItem[] | null = null
let findSkillIndexFetchedAt = 0
const FINDSKILL_INDEX_TTL = 10 * 60 * 1000

function mapFindSkillItem(item: FindSkillItem): SkillBrowseItem {
  return {
    slug: item.Slug,
    displayName: item.Name,
    summary: item.Description,
    stats: {},
    updatedAt: item.UpdatedAt ? new Date(item.UpdatedAt).getTime() : 0,
  }
}

export class FindSkillMarketplace implements SkillMarketplace {
  readonly id = 'findskill'
  readonly name = 'FindSkill'
  readonly baseUrl = 'https://skills.volces.com'

  async search(query: string, opts?: { limit?: number }): Promise<SkillSearchResult[]> {
    const limit = opts?.limit ?? 20
    const url = `${this.baseUrl}/v1/skills?query=${encodeURIComponent(query)}`
    const res = await proxyFetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`FindSkill search failed: HTTP ${res.status}`)
    const data = (await res.json()) as FindSkillResponse
    return (data.Skills ?? []).slice(0, limit).map((item) => ({
      slug: item.Slug,
      displayName: item.Name,
      summary: item.Description,
      version: '',
      updatedAt: item.UpdatedAt ? new Date(item.UpdatedAt).getTime() : 0,
    }))
  }

  async browse(opts?: {
    limit?: number
    sort?: string
    cursor?: string
  }): Promise<SkillBrowseResult> {
    const limit = opts?.limit ?? 20
    const sort = opts?.sort ?? 'trending'
    const offset = opts?.cursor ? parseInt(opts.cursor, 10) : 0

    const index = await this.loadIndex()

    // FindSkill 暂无 stats，仅支持按 updated 排序
    const sorted =
      sort === 'updated'
        ? [...index].sort((a, b) => {
            const ta = a.UpdatedAt ? new Date(a.UpdatedAt).getTime() : 0
            const tb = b.UpdatedAt ? new Date(b.UpdatedAt).getTime() : 0
            return tb - ta
          })
        : index

    const page = sorted.slice(offset, offset + limit)
    const nextOffset = offset + limit
    const nextCursor = nextOffset < sorted.length ? String(nextOffset) : null

    return { items: page.map(mapFindSkillItem), nextCursor }
  }

  async download(slug: string): Promise<Buffer> {
    // slug 格式：clawhub/author/name → 直接拼路径
    const url = `${this.baseUrl}/v1/skills/download/${slug}`
    const res = await proxyFetch(url, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`FindSkill download failed: HTTP ${res.status} for ${slug}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** 加载全量索引，内存缓存 10 分钟 */
  private async loadIndex(): Promise<FindSkillItem[]> {
    const now = Date.now()
    if (findSkillIndexCache && now - findSkillIndexFetchedAt < FINDSKILL_INDEX_TTL) {
      return findSkillIndexCache
    }
    const url = `${this.baseUrl}/v1/skills`
    const res = await proxyFetch(url, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`FindSkill index fetch failed: HTTP ${res.status}`)
    const data = (await res.json()) as FindSkillResponse
    if (!Array.isArray(data.Skills)) throw new Error('FindSkill index: invalid format')
    findSkillIndexCache = data.Skills
    findSkillIndexFetchedAt = now
    return findSkillIndexCache
  }
}

// ========== 市场注册表 ==========

const marketplaces: SkillMarketplace[] = [
  new SkillHubMarketplace(),
  new ClawHubMarketplace(),
  new FindSkillMarketplace(),
]

export function getMarketplaces(): SkillMarketplace[] {
  return marketplaces
}

export function getMarketplace(id: string): SkillMarketplace | undefined {
  return marketplaces.find((m) => m.id === id)
}

export interface SkillSearchResult {
  slug: string
  displayName: string
  summary: string
  version: string
  updatedAt: number
  score?: number
}

export interface SkillBrowseItem {
  slug: string
  displayName: string
  summary: string
  stats: { downloads?: number; stars?: number }
  updatedAt: number
  latestVersion?: { version: string }
}

export interface SkillBrowseResult {
  items: SkillBrowseItem[]
  nextCursor: string | null
}

export interface SkillMarketplaceInfo {
  id: string
  name: string
  baseUrl: string
}

// ========== 抽象接口 ==========

export interface SkillMarketplace extends SkillMarketplaceInfo {
  search(query: string, opts?: { limit?: number }): Promise<SkillSearchResult[]>
  browse(opts?: { limit?: number; sort?: string; cursor?: string }): Promise<SkillBrowseResult>
  download(slug: string, version?: string): Promise<Buffer>
}
