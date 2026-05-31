import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { App, Button, Form, Input, Modal, Popover, Segmented, Space, Typography } from 'antd'
import {
  GlobalOutlined,
  KeyOutlined,
  LoginOutlined,
  LogoutOutlined,
  ReloadOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import { hasInsufficientYutianBalance, YUTIAN_BALANCE_WARNING } from '../utils/yutianBalance'

type AuthMode = 'login' | 'phone' | 'register'
type ElectronStyle = CSSProperties & { WebkitAppRegion?: string }
const QUOTA_UNITS_PER_YUAN = 500_000

interface AuthFormValues {
  username?: string
  password?: string
  phone?: string
  code?: string
}

function getUserName(user: YutianUserInfo | null): string {
  if (!user) return '请登录'
  return user.display_name || user.username || user.email || `用户 ${user.id || ''}`.trim()
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

function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}

function normalizeBalance(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return value < 0 ? 0 : value
}

function formatQuotaCurrency(value: number): string {
  const amount = (value / QUOTA_UNITS_PER_YUAN).toFixed(2)
  return `\u00a5${amount}`
}

function formatBalance(user: YutianUserInfo | null): string {
  const points = getNumber(user, ['points', 'point', 'credits', 'credit'])
  const accountQuota = normalizeBalance(getNumber(user, ['quota']))
  const accountUsed = normalizeBalance(getNumber(user, ['used_quota']))
  const tokens = normalizeBalance(getNumber(user, ['tokens', 'token_balance', 'balance']))
  const used = getNumber(user, ['used_tokens'])

  if (accountQuota !== undefined || accountUsed !== undefined) {
    const parts: string[] = []
    if (accountQuota !== undefined) parts.push(`余额 ${formatQuotaCurrency(accountQuota)}`)
    if (accountUsed !== undefined) parts.push(`已用 ${formatQuotaCurrency(accountUsed)}`)
    return parts.join(' · ')
  }

  if (points !== undefined || tokens !== undefined) {
    const parts: string[] = []
    if (points !== undefined) parts.push(`积分 ${compactNumber(points)}`)
    if (tokens !== undefined) parts.push(`余额 ${compactNumber(tokens)}`)
    if (used !== undefined) parts.push(`已用 ${compactNumber(used)}`)
    return parts.join(' · ')
  }

  if (used !== undefined) return `已用 ${compactNumber(used)}`
  return '余额 --'
}

function formatBalanceSummary(user: YutianUserInfo | null): string {
  const accountQuota = normalizeBalance(getNumber(user, ['quota']))
  if (accountQuota !== undefined) return `余额 ${formatQuotaCurrency(accountQuota)}`
  const points = getNumber(user, ['points', 'point', 'credits', 'credit'])
  if (points !== undefined) return `积分 ${compactNumber(points)}`
  const tokens = normalizeBalance(getNumber(user, ['tokens', 'token_balance', 'balance']))
  if (tokens !== undefined) return `余额 ${compactNumber(tokens)}`
  return '余额 --'
}

function authErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err || '操作失败')
}

const YUTIAN_NO_API_KEY_MESSAGE = '尚未配置誉天模型秘钥'
const YUTIAN_WEBSITE_URL = 'https://claw.yutianedu.com/'
const ACCOUNT_REFRESH_REQUEST_EVENT = 'yutianclaw:account-refresh-request'
const OPEN_ACCOUNT_LOGIN_EVENT = 'yutianclaw:open-account-login'
const ACCOUNT_STATE_UPDATED_EVENT = 'yutianclaw:account-state-updated'
const BALANCE_WARNING_COOLDOWN_MS = 30_000

function emitAccountState(next: YutianAccountState): void {
  window.dispatchEvent(new CustomEvent(ACCOUNT_STATE_UPDATED_EVENT, { detail: next }))
}

export default function AccountMenu(): React.ReactElement {
  const { message } = App.useApp()
  const [state, setState] = useState<YutianAccountState>({
    loggedIn: false,
    user: null,
    hasAccessToken: false,
    hasApiKey: false,
  })
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AuthMode>('login')
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [smsSending, setSmsSending] = useState(false)
  const [smsCountdown, setSmsCountdown] = useState(0)
  const [form] = Form.useForm<AuthFormValues>()
  const accountRefreshInFlightRef = useRef(false)
  const balanceWarningAtRef = useRef(0)

  const notifyBalanceIfNeeded = useCallback(
    (next: YutianAccountState): void => {
      if (!next.loggedIn || !hasInsufficientYutianBalance(next.user)) return
      const now = Date.now()
      if (now - balanceWarningAtRef.current < BALANCE_WARNING_COOLDOWN_MS) return
      balanceWarningAtRef.current = now
      message.warning(YUTIAN_BALANCE_WARNING)
    },
    [message]
  )

  useEffect(() => {
    let mounted = true
    window.api.account
      .getState()
      .then((next) => {
        if (mounted) {
          setState(next)
          emitAccountState(next)
          notifyBalanceIfNeeded(next)
        }
        if (!next.loggedIn) return
        window.api.account
          .refresh()
          .then((fresh) => {
            if (mounted) {
              setState(fresh)
              emitAccountState(fresh)
              notifyBalanceIfNeeded(fresh)
            }
          })
          .catch(() => {})
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [notifyBalanceIfNeeded])

  useEffect(() => {
    if (smsCountdown <= 0) return undefined
    const timer = window.setTimeout(() => setSmsCountdown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [smsCountdown])

  useEffect(() => {
    const openLogin = (): void => {
      setMode('login')
      form.resetFields(['code'])
      setOpen(true)
    }
    window.addEventListener(OPEN_ACCOUNT_LOGIN_EVENT, openLogin)
    return () => window.removeEventListener(OPEN_ACCOUNT_LOGIN_EVENT, openLogin)
  }, [form])

  useEffect(() => {
    const refreshAfterChatResult = (): void => {
      if (accountRefreshInFlightRef.current) return
      accountRefreshInFlightRef.current = true
      window.api.account
        .refresh()
        .then((next) => {
          setState(next)
          emitAccountState(next)
          notifyBalanceIfNeeded(next)
        })
        .catch(() => {})
        .finally(() => {
          accountRefreshInFlightRef.current = false
        })
    }

    window.addEventListener(ACCOUNT_REFRESH_REQUEST_EVENT, refreshAfterChatResult)
    return () => window.removeEventListener(ACCOUNT_REFRESH_REQUEST_EVENT, refreshAfterChatResult)
  }, [notifyBalanceIfNeeded])

  const displayName = getUserName(state.user)
  const balanceText = useMemo(() => formatBalance(state.user), [state.user])
  const balanceSummary = useMemo(() => formatBalanceSummary(state.user), [state.user])

  const handleSubmit = async (values: AuthFormValues): Promise<void> => {
    setSubmitting(true)
    try {
      let next: YutianAccountState
      if (mode === 'phone') {
        next = await window.api.account.loginPhone({
          phone: values.phone || '',
          code: values.code || '',
        })
      } else if (mode === 'register') {
        next = await window.api.account.register({
          username: values.username || '',
          password: values.password || '',
          phone: values.phone,
          code: values.code,
        })
      } else {
        next = await window.api.account.login({
          username: values.username || '',
          password: values.password || '',
        })
      }

      setState(next)
      emitAccountState(next)
      notifyBalanceIfNeeded(next)
      setOpen(false)
      form.resetFields()
      if (next.hasApiKey) {
        message.success('已登录，并已同步誉天模型默认秘钥')
      } else {
        message.warning(next.message || YUTIAN_NO_API_KEY_MESSAGE)
      }
    } catch (err) {
      message.error(authErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleSendSms = async (): Promise<void> => {
    try {
      const values = await form.validateFields(['phone'])
      const phone = values.phone?.trim()
      if (!phone) return
      setSmsSending(true)
      await window.api.account.sendSms({
        phone,
        scene: mode === 'register' ? 'register' : 'login',
      })
      setSmsCountdown(60)
      message.success('验证码已发送')
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return
      message.error(authErrorMessage(err))
    } finally {
      setSmsSending(false)
    }
  }

  const handleRefresh = async (): Promise<void> => {
    try {
      const next = await window.api.account.refresh()
      setState(next)
      emitAccountState(next)
      notifyBalanceIfNeeded(next)
      message.success('账号信息已刷新')
    } catch (err) {
      message.error(authErrorMessage(err))
    }
  }

  const handleSyncKey = async (): Promise<void> => {
    setSyncing(true)
    try {
      const next = await window.api.account.syncKey()
      setState(next)
      emitAccountState(next)
      notifyBalanceIfNeeded(next)
      message.success('已重新同步誉天模型秘钥')
    } catch (err) {
      message.error(authErrorMessage(err))
    } finally {
      setSyncing(false)
    }
  }

  const handleLogout = async (): Promise<void> => {
    try {
      const next = await window.api.account.logout()
      setState(next)
      emitAccountState(next)
      message.success('已退出登录')
    } catch (err) {
      message.error(authErrorMessage(err))
    }
  }

  const openWebsite = (): void => {
    window.api.shell.openExternal(YUTIAN_WEBSITE_URL).catch((err) => {
      message.error(authErrorMessage(err))
    })
  }

  const phoneRules = [
    { required: true, message: '请输入手机号' },
    { pattern: /^1\d{10}$/, message: '请输入正确的手机号' },
  ]

  const panel = (
    <div style={{ width: 360, maxWidth: 'calc(100vw - 32px)', display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <Typography.Text strong ellipsis={{ tooltip: displayName }}>
          {displayName}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
          {state.user?.group ? `用户组 ${state.user.group}` : '誉天账号'}
        </Typography.Text>
      </div>
      <div
        style={{
          display: 'grid',
          gap: 8,
          padding: 10,
          borderRadius: 8,
          background: 'rgba(255,77,42,0.06)',
          border: '1px solid rgba(255,77,42,0.16)',
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <WalletOutlined style={{ color: '#ff4d2a' }} />
          <Typography.Text style={{ minWidth: 0 }} ellipsis={{ tooltip: balanceText }}>
            {balanceText}
          </Typography.Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <KeyOutlined style={{ color: state.hasApiKey ? '#52c41a' : '#faad14' }} />
          <Typography.Text
            type={state.hasApiKey ? undefined : 'secondary'}
            style={{ minWidth: 0 }}
            ellipsis={{
              tooltip: state.hasApiKey ? '誉天模型秘钥已配置' : YUTIAN_NO_API_KEY_MESSAGE,
            }}
          >
            {state.hasApiKey ? '誉天模型秘钥已配置' : YUTIAN_NO_API_KEY_MESSAGE}
          </Typography.Text>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={handleRefresh}
          style={{ flex: '1 1 76px' }}
        >
          刷新
        </Button>
        <Button
          size="small"
          icon={<GlobalOutlined />}
          onClick={openWebsite}
          style={{ flex: '1 1 76px' }}
        >
          官网
        </Button>
        <Button
          size="small"
          loading={syncing}
          icon={<KeyOutlined />}
          onClick={handleSyncKey}
          style={{ flex: '1 1 92px' }}
        >
          同步秘钥
        </Button>
        <Button
          size="small"
          icon={<LogoutOutlined />}
          onClick={handleLogout}
          style={{ flex: '1 1 76px' }}
        >
          退出
        </Button>
      </div>
    </div>
  )

  const submitText =
    mode === 'register' ? '注册并同步秘钥' : mode === 'phone' ? '验证码登录' : '登录并同步秘钥'

  return (
    <div
      style={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center' } as ElectronStyle}
    >
      {state.loggedIn ? (
        <Popover trigger="click" placement="bottomRight" content={panel}>
          <Button
            type="text"
            size="small"
            title={`${displayName} · ${balanceText}`}
            style={{
              height: 30,
              maxWidth: 'min(34vw, 260px)',
              padding: '0 8px',
              color: 'rgba(255,255,255,0.86)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.14)',
                color: 'rgba(255,255,255,0.9)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayName}
            </span>
            <span
              style={{
                color: 'rgba(255,255,255,0.56)',
                fontSize: 12,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {balanceSummary}
            </span>
          </Button>
        </Popover>
      ) : (
        <Button
          type="text"
          size="small"
          icon={<LoginOutlined />}
          onClick={() => setOpen(true)}
          style={{ color: 'rgba(255,255,255,0.86)' }}
        >
          请登录
        </Button>
      )}

      <Modal
        open={open}
        title="誉天账号"
        footer={null}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Segmented
          block
          value={mode}
          onChange={(value) => {
            setMode(value as AuthMode)
            form.resetFields(['code'])
          }}
          options={[
            { label: '密码登录', value: 'login' },
            { label: '验证码登录', value: 'phone' },
            { label: '注册', value: 'register' },
          ]}
          style={{ marginBottom: 18 }}
        />
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          {mode !== 'phone' && (
            <Form.Item
              name="username"
              label="账号"
              rules={[{ required: true, message: '请输入账号' }]}
            >
              <Input autoFocus placeholder="请输入誉天账号" />
            </Form.Item>
          )}

          {mode !== 'login' && (
            <>
              <Form.Item name="phone" label="手机号" rules={phoneRules}>
                <Input autoFocus={mode === 'phone'} placeholder="请输入手机号" />
              </Form.Item>
              <Form.Item
                name="code"
                label="短信验证码"
                rules={[{ required: true, message: '请输入短信验证码' }]}
              >
                <Space.Compact block>
                  <Input placeholder="请输入验证码" />
                  <Button
                    loading={smsSending}
                    disabled={smsCountdown > 0}
                    onClick={handleSendSms}
                    style={{ width: 112 }}
                  >
                    {smsCountdown > 0 ? `${smsCountdown}s` : '发送验证码'}
                  </Button>
                </Space.Compact>
              </Form.Item>
            </>
          )}

          {mode !== 'phone' && (
            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: '请输入密码' },
                { min: 8, message: '密码至少 8 位' },
              ]}
            >
              <Input.Password placeholder="至少 8 位密码" />
            </Form.Item>
          )}

          <Space.Compact block>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              {submitText}
            </Button>
            <Button icon={<GlobalOutlined />} onClick={openWebsite}>
              官网
            </Button>
          </Space.Compact>
        </Form>
      </Modal>
    </div>
  )
}
