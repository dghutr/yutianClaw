/**
 * Dashboard — YuTianClaw product workbench.
 *
 * This page is intentionally a presentation refactor only: existing gateway,
 * model, agent, channel, cron, account, and log data sources remain unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Spin } from 'antd'
import {
  ApiOutlined,
  BookOutlined,
  CheckCircleOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  CloudServerOutlined,
  CompassOutlined,
  ExclamationCircleOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LoginOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ScheduleOutlined,
  ThunderboltOutlined,
  UserOutlined,
  VideoCameraOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGatewayContext } from '../../contexts/GatewayContext'

interface DashStats {
  providerCount: number
  defaultModel: string | null
  agentCount: number
  defaultAgent: string | null
  channelCount: number
  channelNames: string[]
  cronTotal: number
  cronEnabled: number
  cronFailed: number
  cronLatestName: string | null
  cronLatestStatus: 'ok' | 'error' | 'skipped' | null
  cronLatestAt: number | null
  cronNextAt: number | null
}

interface DashCronJob {
  id: string
  name: string
  enabled: boolean
  state?: {
    nextRunAtMs?: number
    lastRunAtMs?: number
    lastRunStatus?: 'ok' | 'error' | 'skipped'
  }
  lastRun?: {
    status: 'ok' | 'error' | 'skipped'
    startedAt: number
  }
  lastRunAt?: number
  lastRunStatus?: 'ok' | 'error' | 'skipped'
  nextRunAt?: number
  nextRunAtMs?: number
}

interface DashCronTimelineItem {
  id: string
  name: string
  enabled: boolean
  lastStatus: 'ok' | 'error' | 'skipped' | null
  lastAt: number | null
  nextAt: number | null
}

interface WorkbenchAction {
  key: string
  title: string
  desc: string
  icon: ReactNode
  accent: string
  onClick: () => void
}

interface EmployeeCard {
  key: string
  title: string
  desc: string
  icon: ReactNode
  accent: string
}

const OPEN_ACCOUNT_LOGIN_EVENT = 'yutianclaw:open-account-login'
const ACCOUNT_STATE_UPDATED_EVENT = 'yutianclaw:account-state-updated'
const QUOTA_UNITS_PER_YUAN = 500_000

const LOG_COLORS: Record<string, string> = {
  error: '#ff4d4f',
  warn: '#fa8c16',
  info: 'rgba(255,255,255,0.75)',
  debug: 'rgba(255,255,255,0.35)',
}

function stripLogMeta(line: string): string {
  return line
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?\s*/, '')
    .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '')
    .replace(/^{"level":"[^"]*","time":[^,]+,/, '{')
    .trim()
}

function parseLogTime(line: string): string {
  const m = line.match(/(\d{2}:\d{2}:\d{2})/)
  return m ? m[1] : ''
}

function logLevel(line: string): 'error' | 'warn' | 'info' | 'debug' {
  const l = line.toLowerCase()
  if (l.includes('"level":"error"') || / error[: ]/.test(l)) return 'error'
  if (l.includes('"level":"warn"') || / warn[: ]/.test(l)) return 'warn'
  if (l.includes('"level":"debug"') || / debug[: ]/.test(l)) return 'debug'
  return 'info'
}

function pickLastRunAt(job: DashCronJob): number | null {
  return job.state?.lastRunAtMs ?? job.lastRunAt ?? job.lastRun?.startedAt ?? null
}

function pickNextRunAt(job: DashCronJob): number | null {
  return job.state?.nextRunAtMs ?? job.nextRunAtMs ?? job.nextRunAt ?? null
}

function pickLastRunStatus(job: DashCronJob): 'ok' | 'error' | 'skipped' | null {
  return job.state?.lastRunStatus ?? job.lastRunStatus ?? job.lastRun?.status ?? null
}

function useUptime(isRunning: boolean): string {
  const startedAtRef = useRef<number | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (isRunning && startedAtRef.current === null) {
      startedAtRef.current = Date.now()
    } else if (!isRunning) {
      startedAtRef.current = null
    }
  }, [isRunning])

  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [isRunning])

  if (!isRunning || startedAtRef.current === null) return ''
  const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
  const h = Math.floor(elapsed / 3600)
    .toString()
    .padStart(2, '0')
  const m = Math.floor((elapsed % 3600) / 60)
    .toString()
    .padStart(2, '0')
  const s = (elapsed % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}

function normalizeBalance(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return value < 0 ? 0 : value
}

function getNumber(user: YutianUserInfo | null, keys: string[]): number | undefined {
  if (!user) return undefined
  for (const key of keys) {
    const value = user[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

function formatQuotaCurrency(value: number): string {
  const amount = (value / QUOTA_UNITS_PER_YUAN).toFixed(2)
  return `¥${amount}`
}

function formatAccountBalance(user: YutianUserInfo | null): string {
  const accountQuota = normalizeBalance(getNumber(user, ['quota']))
  if (accountQuota !== undefined) return formatQuotaCurrency(accountQuota)
  const points = getNumber(user, ['points', 'point', 'credits', 'credit'])
  if (points !== undefined) return `积分 ${compactNumber(points)}`
  const tokens = normalizeBalance(getNumber(user, ['tokens', 'token_balance', 'balance']))
  if (tokens !== undefined) return `余额 ${compactNumber(tokens)}`
  return '余额 --'
}

function getAccountName(user: YutianUserInfo | null): string {
  if (!user) return '未登录'
  return user.display_name || user.username || user.email || `用户 ${user.id || ''}`.trim()
}

function formatModelName(model: string | null): string {
  if (!model) return '未配置'
  if (model.includes('yutian')) return '誉天大模型'
  const parts = model.split(/[.:/]/).filter(Boolean)
  return parts[parts.length - 1] || model
}

function formatWhen(timestampMs: number | null): string {
  if (!timestampMs) return '暂无记录'
  const delta = Date.now() - timestampMs
  const abs = Math.abs(delta)
  if (abs < 60_000) return delta >= 0 ? '刚刚' : '即将执行'
  if (abs < 3_600_000) {
    const n = Math.floor(abs / 60_000)
    return delta >= 0 ? `${n} 分钟前` : `${n} 分钟后`
  }
  if (abs < 86_400_000) {
    const n = Math.floor(abs / 3_600_000)
    return delta >= 0 ? `${n} 小时前` : `${n} 小时后`
  }
  const n = Math.floor(abs / 86_400_000)
  return delta >= 0 ? `${n} 天前` : `${n} 天后`
}

function statusText(state: string): string {
  if (state === 'running') return '运行中'
  if (state === 'starting') return '启动中'
  if (state === 'stopping') return '停止中'
  return '未启动'
}

function DashboardPage(): React.ReactElement {
  const navigate = useNavigate()
  const { gwState, gwPort, status, callRpc } = useGatewayContext()
  const [account, setAccount] = useState<YutianAccountState>({
    loggedIn: false,
    user: null,
    hasAccessToken: false,
    hasApiKey: false,
  })

  const isRunning = gwState === 'running'
  const isStarting = gwState === 'starting'
  const isStopping = gwState === 'stopping'
  const uptime = useUptime(isRunning)

  const [stats, setStats] = useState<DashStats>({
    providerCount: 0,
    defaultModel: null,
    agentCount: 0,
    defaultAgent: null,
    channelCount: 0,
    channelNames: [],
    cronTotal: 0,
    cronEnabled: 0,
    cronFailed: 0,
    cronLatestName: null,
    cronLatestStatus: null,
    cronLatestAt: null,
    cronNextAt: null,
  })
  const [statsLoading, setStatsLoading] = useState(true)
  const [cronJobs, setCronJobs] = useState<DashCronJob[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [logExpanded, setLogExpanded] = useState(false)
  const logBoxRef = useRef<HTMLDivElement>(null)

  const loadAccount = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.account.getState()
      setAccount(next)
    } catch {
      // Account is optional on the dashboard; keep the page usable.
    }
  }, [])

  const loadStats = useCallback(async (): Promise<void> => {
    try {
      const [providers, defaultModel, agents, channels] = await Promise.all([
        window.api.model.listProviders().catch(() => ({})),
        window.api.model.getDefault().catch(() => null),
        window.api.agent.list().catch(() => []),
        window.api.channel.list().catch(() => ({})),
      ])

      let jobs: DashCronJob[] = []
      if (gwState === 'running' && status === 'ready') {
        try {
          const result = (await callRpc('cron.list', { limit: 20, offset: 0 })) as {
            jobs?: DashCronJob[]
          }
          jobs = Array.isArray(result?.jobs) ? result.jobs : []
        } catch {
          // Gateway may not expose cron yet; keep the overview quiet.
        }
      }
      setCronJobs(jobs)

      const providerCount = Object.keys(providers as Record<string, unknown>).length
      const defaultModelStr =
        defaultModel == null
          ? null
          : typeof defaultModel === 'string'
            ? defaultModel
            : (defaultModel as { primary: string }).primary

      const agentList = Array.isArray(agents)
        ? (agents as Array<{
            id?: string
            default?: boolean
            name?: string
            identity?: { name?: string }
          }>)
        : []
      const customAgents = agentList.filter((a) => a.id !== 'main')
      const defaultAgentEntry = agentList.find((a) => a.default)
      const defaultAgentName = defaultAgentEntry
        ? defaultAgentEntry.identity?.name || defaultAgentEntry.name || defaultAgentEntry.id || null
        : null

      const channelMap = channels as Record<string, { enabled?: boolean }>
      const enabledChannels = Object.entries(channelMap).filter(([, v]) => v?.enabled !== false)
      const cronEnabled = jobs.filter((j) => j.enabled).length
      const cronFailed = jobs.filter((j) => pickLastRunStatus(j) === 'error').length

      let cronLatestJob: DashCronJob | null = null
      let latestAt = 0
      for (const job of jobs) {
        const runAt = pickLastRunAt(job)
        if (runAt && runAt > latestAt) {
          latestAt = runAt
          cronLatestJob = job
        }
      }

      let cronNextAt: number | null = null
      for (const job of jobs) {
        if (!job.enabled) continue
        const next = pickNextRunAt(job)
        if (!next) continue
        if (cronNextAt === null || next < cronNextAt) cronNextAt = next
      }

      setStats({
        providerCount,
        defaultModel: defaultModelStr,
        agentCount: customAgents.length,
        defaultAgent: defaultAgentName,
        channelCount: enabledChannels.length,
        channelNames: enabledChannels.map(([k]) => k).slice(0, 3),
        cronTotal: jobs.length,
        cronEnabled,
        cronFailed,
        cronLatestName: cronLatestJob?.name ?? null,
        cronLatestStatus: cronLatestJob ? pickLastRunStatus(cronLatestJob) : null,
        cronLatestAt: cronLatestJob ? pickLastRunAt(cronLatestJob) : null,
        cronNextAt,
      })
    } catch {
      // Keep stale values instead of showing duplicate warnings.
    } finally {
      setStatsLoading(false)
    }
  }, [callRpc, gwState, status])

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  useEffect(() => {
    const onAccountStateUpdated = (event: Event): void => {
      const next = (event as CustomEvent<YutianAccountState>).detail
      if (next) setAccount(next)
    }
    window.addEventListener(ACCOUNT_STATE_UPDATED_EVENT, onAccountStateUpdated)
    return () => window.removeEventListener(ACCOUNT_STATE_UPDATED_EVENT, onAccountStateUpdated)
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  useEffect(() => {
    const refresh = (): void => {
      void loadStats()
      void loadAccount()
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [loadAccount, loadStats])

  useEffect(() => {
    window.api.gateway.getLogBuffer().then((buf) => {
      if (buf.length > 0) setLogs(buf.slice(-30))
    })
    const offLog = window.api.gateway.onLog((line) => {
      setLogs((prev) => {
        const next = [...prev, line]
        return next.length > 30 ? next.slice(-30) : next
      })
    })
    return () => {
      offLog()
    }
  }, [])

  useEffect(() => {
    const box = logBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [logs, logExpanded])

  const openLogin = (): void => {
    window.dispatchEvent(new Event(OPEN_ACCOUNT_LOGIN_EVENT))
  }

  const openWebsite = (): void => {
    window.api.shell.openExternal('https://claw.yutianedu.com/').catch(() => {})
  }

  const gatewayTone = isRunning ? '#21B573' : isStarting || isStopping ? '#FAAD14' : '#98A2B3'
  const modelReady = stats.defaultModel != null
  const channelReady = stats.channelCount > 0
  const latestLog = logs.length > 0 ? logs[logs.length - 1] : null

  const recentRuns: DashCronTimelineItem[] = cronJobs
    .map((job) => ({
      id: job.id,
      name: job.name || job.id,
      enabled: job.enabled,
      lastStatus: pickLastRunStatus(job),
      lastAt: pickLastRunAt(job),
      nextAt: pickNextRunAt(job),
    }))
    .filter((job) => job.lastAt != null || job.nextAt != null || job.enabled)
    .sort((a, b) => {
      const aLast = a.lastAt ?? 0
      const bLast = b.lastAt ?? 0
      if (aLast !== bLast) return bLast - aLast
      const aNext = a.nextAt ?? Number.MAX_SAFE_INTEGER
      const bNext = b.nextAt ?? Number.MAX_SAFE_INTEGER
      return aNext - bNext
    })
    .slice(0, 3)

  const quickActions: WorkbenchAction[] = [
    {
      key: 'chat',
      title: '开始聊天',
      desc: '进入主对话区，让数字员工处理真实任务',
      icon: <MessageOutlined />,
      accent: '#FF4D2A',
      onClick: () => navigate('/chat'),
    },
    {
      key: 'agents',
      title: '创建数字员工',
      desc: '为作业、考试、资料、视频等场景配置角色',
      icon: <RobotOutlined />,
      accent: '#7C4DFF',
      onClick: () => navigate('/agents'),
    },
    {
      key: 'channels',
      title: '连接飞书',
      desc: '把外部消息接入工作台并自动回传结果',
      icon: <ApiOutlined />,
      accent: '#1677FF',
      onClick: () => navigate('/channels'),
    },
    {
      key: 'pdf',
      title: '生成 PDF 资料',
      desc: '在对话里生成课程介绍、作业报告和资料文件',
      icon: <FileTextOutlined />,
      accent: '#00A88F',
      onClick: () => navigate('/chat'),
    },
  ]

  const employees: EmployeeCard[] = [
    {
      key: 'homework',
      title: '作业批改',
      desc: '评分、错因、改进建议',
      icon: <CheckSquareOutlined />,
      accent: '#FF4D2A',
    },
    {
      key: 'exam',
      title: '考试辅导',
      desc: '知识点拆解与复习节奏',
      icon: <BookOutlined />,
      accent: '#FAAD14',
    },
    {
      key: 'material',
      title: '课程资料',
      desc: 'PDF、讲义、课程介绍',
      icon: <FileDoneOutlined />,
      accent: '#00A88F',
    },
    {
      key: 'video',
      title: '课件视频',
      desc: '脚本、分镜、口播结构',
      icon: <VideoCameraOutlined />,
      accent: '#7C4DFF',
    },
    {
      key: 'career',
      title: '职业规划',
      desc: '岗位路径与证书建议',
      icon: <CompassOutlined />,
      accent: '#1677FF',
    },
    {
      key: 'feishu',
      title: '飞书协同',
      desc: '外部会话自动接入',
      icon: <MessageOutlined />,
      accent: '#21B573',
    },
  ]

  return (
    <div
      style={{
        minHeight: '100%',
        overflow: 'auto',
        background:
          'radial-gradient(circle at 86% 0%, rgba(255,77,42,0.14), transparent 34%), linear-gradient(180deg, #F8FAFC 0%, #EEF2F7 100%)',
      }}
    >
      <div
        style={{
          maxWidth: 1360,
          margin: '0 auto',
          padding: '28px 32px 36px',
          display: 'grid',
          gap: 18,
        }}
      >
        {!account.loggedIn && (
          <section
            style={{
              borderRadius: 12,
              border: '1px solid rgba(255,77,42,0.22)',
              background:
                'linear-gradient(135deg, rgba(255,77,42,0.12), rgba(255,255,255,0.92) 58%, rgba(255,255,255,0.82))',
              padding: '14px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              boxShadow: '0 14px 36px rgba(15, 23, 42, 0.06)',
            }}
          >
            <IconBox icon={<LoginOutlined />} color="#FF4D2A" size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>
                登录后自动同步誉天大模型密钥与余额
              </div>
              <div style={{ marginTop: 3, fontSize: 12, color: '#667085' }}>
                未登录也可以手动配置模型；登录后会减少配置步骤，并显示可用额度。
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
              <Button type="primary" icon={<LoginOutlined />} onClick={openLogin}>
                立即登录
              </Button>
              <Button icon={<GlobalOutlined />} onClick={openWebsite}>
                官网注册
              </Button>
            </div>
          </section>
        )}

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.45fr) minmax(330px, 0.55fr)',
            gap: 18,
            alignItems: 'stretch',
          }}
        >
          <div
            style={{
              minHeight: 314,
              borderRadius: 18,
              overflow: 'hidden',
              position: 'relative',
              padding: 28,
              color: '#fff',
              background: 'linear-gradient(135deg, #06192B 0%, #0B2A42 62%, #381313 100%)',
              boxShadow: '0 24px 60px rgba(6,25,43,0.22)',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: -80,
                right: -60,
                width: 300,
                height: 300,
                borderRadius: '50%',
                border: '44px solid rgba(255,77,42,0.24)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                right: 26,
                bottom: 20,
                width: 220,
                height: 150,
                transform: 'skewX(-18deg)',
                background: 'linear-gradient(120deg, rgba(255,77,42,0.5), rgba(255,77,42,0))',
              }}
            />
            <div style={{ position: 'relative', zIndex: 1, maxWidth: 720 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <IconBox icon={<RobotOutlined />} color="#FF4D2A" size={48} dark />
                <div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.62)' }}>
                    YuTianClaw 工作台
                  </div>
                  <h1 style={{ margin: 0, marginTop: 2, fontSize: 32, letterSpacing: 0 }}>
                    今天从哪里开始？
                  </h1>
                </div>
              </div>

              <p
                style={{
                  margin: '22px 0 0',
                  maxWidth: 620,
                  fontSize: 15,
                  lineHeight: 1.75,
                  color: 'rgba(255,255,255,0.78)',
                }}
              >
                让数字员工接住教学服务、资料生成、飞书消息和后台运营数据。首页只保留关键入口，
                其他配置放回对应模块里，减少重复提醒。
              </p>

              <div style={{ marginTop: 24, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <Button
                  type="primary"
                  size="large"
                  icon={<MessageOutlined />}
                  onClick={() => navigate('/chat')}
                >
                  开始实时聊天
                </Button>
                <Button
                  size="large"
                  icon={<RobotOutlined />}
                  onClick={() => navigate('/agents')}
                  style={{
                    color: '#fff',
                    borderColor: 'rgba(255,255,255,0.28)',
                    background: 'rgba(255,255,255,0.08)',
                  }}
                >
                  管理数字员工
                </Button>
                <Button
                  size="large"
                  icon={<GlobalOutlined />}
                  onClick={openWebsite}
                  style={{
                    color: '#fff',
                    borderColor: 'rgba(255,255,255,0.28)',
                    background: 'rgba(255,255,255,0.08)',
                  }}
                >
                  打开官网
                </Button>
              </div>
            </div>
          </div>

          <aside
            style={{
              borderRadius: 18,
              border: '1px solid rgba(15,23,42,0.08)',
              background: 'rgba(255,255,255,0.92)',
              boxShadow: '0 18px 44px rgba(15, 23, 42, 0.08)',
              padding: 18,
              display: 'grid',
              alignContent: 'start',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <IconBox
                icon={account.loggedIn ? <UserOutlined /> : <LoginOutlined />}
                color={account.loggedIn ? '#1677FF' : '#FF4D2A'}
                size={40}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, color: '#111827' }}>
                  {account.loggedIn ? getAccountName(account.user) : '请登录'}
                </div>
                <div style={{ marginTop: 2, fontSize: 12, color: '#667085' }}>
                  {account.loggedIn
                    ? formatAccountBalance(account.user)
                    : '同步密钥、余额和测试额度'}
                </div>
              </div>
              {!account.loggedIn && (
                <Button size="small" type="primary" onClick={openLogin}>
                  登录
                </Button>
              )}
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              <StatusRow
                icon={<CloudServerOutlined />}
                title="服务引擎"
                value={statusText(gwState)}
                color={gatewayTone}
                extra={isRunning && gwPort > 0 ? `:${gwPort}${uptime ? ` · ${uptime}` : ''}` : ''}
              />
              <StatusRow
                icon={<ThunderboltOutlined />}
                title="默认模型"
                value={modelReady ? formatModelName(stats.defaultModel) : '未配置'}
                color={modelReady ? '#21B573' : '#FAAD14'}
              />
              <StatusRow
                icon={<ApiOutlined />}
                title="聊天渠道"
                value={channelReady ? `${stats.channelCount} 个已启用` : '未连接'}
                color={channelReady ? '#21B573' : '#98A2B3'}
              />
              <StatusRow
                icon={<SafetyCertificateOutlined />}
                title="誉天密钥"
                value={account.loggedIn ? (account.hasApiKey ? '已同步' : '待同步') : '登录后同步'}
                color={account.hasApiKey ? '#21B573' : '#FAAD14'}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {gwState === 'stopped' && (
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={() => window.api.gateway.startWithRecovery()}
                >
                  启动服务
                </Button>
              )}
              {isRunning && (
                <>
                  <Button icon={<ReloadOutlined />} onClick={() => window.api.gateway.restart()}>
                    重启
                  </Button>
                  <Button
                    danger
                    icon={<PoweroffOutlined />}
                    onClick={() => window.api.gateway.stop()}
                  >
                    停止
                  </Button>
                </>
              )}
              {(isStarting || isStopping) && (
                <Button loading>{isStarting ? '启动中' : '停止中'}</Button>
              )}
            </div>
          </aside>
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(160px, 1fr))',
            gap: 12,
          }}
        >
          {quickActions.map((item) => (
            <button
              key={item.key}
              onClick={item.onClick}
              className="yt-dashboard-action"
              style={{
                border: '1px solid rgba(15,23,42,0.08)',
                borderRadius: 12,
                background: 'rgba(255,255,255,0.9)',
                padding: 16,
                textAlign: 'left',
                cursor: 'pointer',
                boxShadow: '0 12px 28px rgba(15,23,42,0.06)',
              }}
            >
              <IconBox icon={item.icon} color={item.accent} size={42} />
              <div style={{ marginTop: 12, fontSize: 15, fontWeight: 800, color: '#111827' }}>
                {item.title}
              </div>
              <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.55, color: '#667085' }}>
                {item.desc}
              </div>
            </button>
          ))}
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.2fr) minmax(330px, 0.8fr)',
            gap: 18,
          }}
        >
          <div
            style={{
              borderRadius: 16,
              border: '1px solid rgba(15,23,42,0.08)',
              background: 'rgba(255,255,255,0.94)',
              padding: 18,
              boxShadow: '0 16px 36px rgba(15,23,42,0.06)',
            }}
          >
            <SectionTitle
              icon={<RobotOutlined />}
              title="数字员工矩阵"
              subtitle="面向教育培训业务的六类高频执行场景"
              action={
                <Button size="small" onClick={() => navigate('/agents')}>
                  管理数字员工
                </Button>
              }
            />
            <div
              style={{
                marginTop: 14,
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 10,
              }}
            >
              {employees.map((item) => (
                <div
                  key={item.key}
                  style={{
                    minHeight: 112,
                    borderRadius: 10,
                    border: '1px solid rgba(15,23,42,0.08)',
                    background:
                      'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.96))',
                    padding: 13,
                  }}
                >
                  <IconBox icon={item.icon} color={item.accent} size={36} />
                  <div style={{ marginTop: 9, fontSize: 14, fontWeight: 800, color: '#111827' }}>
                    {item.title}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: '#667085' }}>{item.desc}</div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              borderRadius: 16,
              border: '1px solid rgba(15,23,42,0.08)',
              background: 'rgba(255,255,255,0.94)',
              padding: 18,
              boxShadow: '0 16px 36px rgba(15,23,42,0.06)',
            }}
          >
            <SectionTitle
              icon={<WalletOutlined />}
              title="运营概览"
              subtitle="保留关键指标，减少重复提示"
            />
            <div
              style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}
            >
              <MetricCard
                label="模型服务商"
                value={statsLoading ? '...' : String(stats.providerCount)}
              />
              <MetricCard
                label="数字员工"
                value={statsLoading ? '...' : String(stats.agentCount)}
              />
              <MetricCard
                label="已启用渠道"
                value={statsLoading ? '...' : String(stats.channelCount)}
              />
              <MetricCard
                label="定时任务"
                value={statsLoading ? '...' : `${stats.cronEnabled}/${stats.cronTotal}`}
              />
            </div>
            <div
              style={{
                marginTop: 14,
                borderRadius: 10,
                background: '#F8FAFC',
                border: '1px solid rgba(15,23,42,0.08)',
                padding: 12,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 800, color: '#111827' }}>下一次建议</div>
              <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.65, color: '#667085' }}>
                {!modelReady
                  ? '当前没有可用模型，请登录同步誉天模型或手动配置第三方模型；配置完成后会自动启动服务引擎。'
                  : !isRunning
                    ? '先启动服务引擎，聊天、渠道和自动任务才会开始工作。'
                    : stats.agentCount === 0
                      ? '建议创建一个通用数字员工，后续再扩展到具体业务场景。'
                      : '系统已具备基础工作流，可以进入实时聊天开始处理任务。'}
              </div>
            </div>
          </div>
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 0.95fr) minmax(0, 1.05fr)',
            gap: 18,
          }}
        >
          <div
            style={{
              borderRadius: 16,
              border: '1px solid rgba(15,23,42,0.08)',
              background: 'rgba(255,255,255,0.94)',
              padding: 18,
            }}
          >
            <SectionTitle
              icon={<ScheduleOutlined />}
              title="最近任务"
              subtitle="只展示关键状态，详细记录在定时任务页"
              action={
                <Button size="small" onClick={() => navigate('/cron')}>
                  查看全部
                </Button>
              }
            />
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              {statsLoading ? (
                <Spin size="small" />
              ) : recentRuns.length === 0 ? (
                <EmptyLine text="暂无任务运行记录" />
              ) : (
                recentRuns.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      borderRadius: 10,
                      background: '#F8FAFC',
                      border: '1px solid rgba(15,23,42,0.08)',
                      padding: '10px 12px',
                    }}
                  >
                    {item.lastStatus === 'error' ? (
                      <ExclamationCircleOutlined style={{ color: '#FF4D4F' }} />
                    ) : item.lastStatus === 'ok' ? (
                      <CheckCircleOutlined style={{ color: '#21B573' }} />
                    ) : (
                      <ClockCircleOutlined style={{ color: '#FAAD14' }} />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: '#111827',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.name}
                      </div>
                      <div style={{ marginTop: 3, fontSize: 11, color: '#98A2B3' }}>
                        上次 {formatWhen(item.lastAt)} · 下次 {formatWhen(item.nextAt)}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: item.enabled ? '#21B573' : '#98A2B3' }}>
                      {item.enabled ? '启用' : '暂停'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div
            style={{
              borderRadius: 16,
              border: '1px solid rgba(15,23,42,0.08)',
              background: logExpanded ? '#101828' : 'rgba(255,255,255,0.94)',
              padding: 18,
              minHeight: 200,
            }}
          >
            <SectionTitle
              icon={<FileTextOutlined />}
              title="服务事件"
              subtitle="默认只显示最新一条，避免首页信息过载"
              dark={logExpanded}
              action={
                <div style={{ display: 'flex', gap: 10 }}>
                  <Button size="small" onClick={() => setLogExpanded((v) => !v)}>
                    {logExpanded ? '收起' : '展开'}
                  </Button>
                  <Button size="small" onClick={() => navigate('/logs')}>
                    日志页
                  </Button>
                </div>
              }
            />
            {logExpanded ? (
              <div
                ref={logBoxRef}
                style={{
                  marginTop: 12,
                  maxHeight: 240,
                  overflowY: 'auto',
                  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
                  fontSize: 12,
                  lineHeight: '20px',
                }}
              >
                {logs.length === 0 ? (
                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                    {isRunning ? '暂无日志' : '启动服务后显示日志'}
                  </span>
                ) : (
                  logs.map((line, i) => {
                    const level = logLevel(line)
                    const time = parseLogTime(line)
                    const text = stripLogMeta(line) || line
                    return (
                      <div key={i} style={{ display: 'flex', gap: 10 }}>
                        {time && (
                          <span style={{ color: 'rgba(255,255,255,0.25)', flexShrink: 0 }}>
                            {time}
                          </span>
                        )}
                        <span style={{ color: LOG_COLORS[level], wordBreak: 'break-all' }}>
                          {text}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            ) : (
              <div
                style={{
                  marginTop: 12,
                  minHeight: 54,
                  borderRadius: 10,
                  background: '#F8FAFC',
                  border: '1px solid rgba(15,23,42,0.08)',
                  padding: '12px 14px',
                  color: '#667085',
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                {latestLog
                  ? stripLogMeta(latestLog)
                  : isRunning
                    ? '服务已运行，等待新的事件。'
                    : '服务未启动，点击右侧状态面板启动。'}
              </div>
            )}
          </div>
        </section>
      </div>

      <style>{`
        .yt-dashboard-action {
          transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
        }
        .yt-dashboard-action:hover {
          transform: translateY(-2px);
          border-color: rgba(255,77,42,0.28) !important;
          box-shadow: 0 18px 38px rgba(15,23,42,0.10) !important;
        }
        @keyframes ccPulse {
          0%, 100% { opacity: 0.2; transform: scale(1); }
          50% { opacity: 0.45; transform: scale(1.4); }
        }
      `}</style>
    </div>
  )
}

function IconBox({
  icon,
  color,
  size = 40,
  dark = false,
}: {
  icon: ReactNode
  color: string
  size?: number
  dark?: boolean
}): React.ReactElement {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color,
        fontSize: Math.round(size * 0.48),
        background: dark ? 'rgba(255,255,255,0.1)' : `${color}14`,
        border: dark ? '1px solid rgba(255,255,255,0.16)' : `1px solid ${color}22`,
      }}
    >
      {icon}
    </span>
  )
}

function StatusRow({
  icon,
  title,
  value,
  color,
  extra,
}: {
  icon: ReactNode
  title: string
  value: string
  color: string
  extra?: string
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 10,
        background: '#F8FAFC',
        border: '1px solid rgba(15,23,42,0.08)',
      }}
    >
      <span style={{ color, fontSize: 16 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#667085' }}>{title}</div>
        <div
          style={{
            marginTop: 2,
            fontSize: 13,
            fontWeight: 800,
            color: '#111827',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
          {extra && (
            <span style={{ marginLeft: 6, color: '#98A2B3', fontWeight: 500 }}>{extra}</span>
          )}
        </div>
      </div>
      <span
        style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }}
      />
    </div>
  )
}

function SectionTitle({
  icon,
  title,
  subtitle,
  action,
  dark = false,
}: {
  icon: ReactNode
  title: string
  subtitle: string
  action?: ReactNode
  dark?: boolean
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <IconBox icon={icon} color={dark ? '#FF7A5C' : '#FF4D2A'} size={34} dark={dark} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 900, color: dark ? '#fff' : '#111827' }}>
          {title}
        </div>
        <div
          style={{ marginTop: 2, fontSize: 12, color: dark ? 'rgba(255,255,255,0.55)' : '#667085' }}
        >
          {subtitle}
        </div>
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div
      style={{
        borderRadius: 10,
        background: '#F8FAFC',
        border: '1px solid rgba(15,23,42,0.08)',
        padding: 12,
        minHeight: 76,
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 900, color: '#FF4D2A', lineHeight: 1 }}>{value}</div>
      <div style={{ marginTop: 8, fontSize: 12, color: '#667085' }}>{label}</div>
    </div>
  )
}

function EmptyLine({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        borderRadius: 10,
        background: '#F8FAFC',
        border: '1px dashed rgba(15,23,42,0.16)',
        padding: '12px 14px',
        color: '#667085',
        fontSize: 12,
      }}
    >
      {text}
    </div>
  )
}

export default DashboardPage
