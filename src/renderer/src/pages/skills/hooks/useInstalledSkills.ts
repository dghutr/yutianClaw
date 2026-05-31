import { App } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useGatewayContext } from '../../../contexts/GatewayContext'
import { pathBasename } from '../skills-page.utils'

export function useInstalledSkills() {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { callRpc, status: wsStatus } = useGatewayContext()
  const wsReady = wsStatus === 'ready'

  const [installedSkills, setInstalledSkills] = useState<InstalledSkillInfo[]>([])
  const [skillsDir, setSkillsDir] = useState('~/.openclaw/skills')
  const [installedLoading, setInstalledLoading] = useState(false)

  const loadInstalled = useCallback(async () => {
    if (!wsReady) return
    setInstalledLoading(true)
    try {
      const payload = (await callRpc('skills.status', {})) as {
        workspaceDir: string
        managedSkillsDir: string
        skills: Array<{
          name: string
          description?: string
          source: string
          bundled: boolean
          filePath: string
          baseDir: string
          skillKey: string
          primaryEnv?: string
          emoji?: string
          eligible: boolean
          disabled: boolean
          always: boolean
          error?: string
          missing?: {
            bins?: string[]
            anyBins?: string[]
            env?: string[]
            config?: string[]
            os?: string[]
          }
        }>
      }
      const workspaceDir = payload.workspaceDir ?? ''
      const managedSkillsDir = payload.managedSkillsDir ?? ''
      const skills: InstalledSkillInfo[] = payload.skills.map((entry) => {
        const rawSource = entry.source
        const isSystem = rawSource.startsWith('openclaw-')
        let source: InstalledSkillInfo['source']
        if (isSystem) source = 'bundled'
        else if (workspaceDir && entry.baseDir.startsWith(workspaceDir)) source = 'workspace'
        else if (managedSkillsDir && entry.baseDir.startsWith(managedSkillsDir)) source = 'managed'
        else source = 'extra'
        return {
          dirName: pathBasename(entry.baseDir),
          filePath: entry.filePath,
          baseDir: entry.baseDir,
          name: entry.name,
          description: entry.description,
          emoji: entry.emoji,
          source,
          rawSource,
          isSystem,
          eligible: entry.eligible,
          missing: entry.missing,
          skillKey: entry.skillKey,
          enabled: !entry.disabled,
          error: entry.error,
          primaryEnv: entry.primaryEnv,
          always: entry.always,
        }
      })
      setInstalledSkills(skills)
      if (managedSkillsDir) setSkillsDir(managedSkillsDir)
    } catch (err) {
      message.error(t('skills.loadFailed', { error: String(err) }))
    } finally {
      setInstalledLoading(false)
    }
  }, [callRpc, message, t, wsReady])

  useEffect(() => {
    if (wsReady) {
      loadInstalled()
    } else {
      setInstalledSkills([])
    }
  }, [loadInstalled, wsReady])

  const handleUninstall = useCallback(
    async (baseDir: string, _name: string) => {
      try {
        await window.api.skill.uninstall(baseDir)
        message.success(t('skills.uninstallSuccess'))
        await loadInstalled()
      } catch (err) {
        message.error(String(err))
      }
    },
    [loadInstalled, message, t]
  )

  const handleToggleEnabled = useCallback(
    (skillKey: string, enabled: boolean) => {
      setInstalledSkills((prev) =>
        prev.map((s) => (s.skillKey === skillKey ? { ...s, enabled } : s))
      )
      callRpc('skills.update', { skillKey, enabled }).catch((err) => {
        message.error(t('skills.enableFailed', { error: String(err) }))
        setInstalledSkills((prev) =>
          prev.map((s) => (s.skillKey === skillKey ? { ...s, enabled: !enabled } : s))
        )
      })
    },
    [callRpc, message, t]
  )

  const handleSaveApiKey = useCallback(
    async (skillKey: string, apiKey: string) => {
      await callRpc('skills.update', { skillKey, apiKey })
    },
    [callRpc]
  )

  const handleExport = useCallback(
    async (skill: InstalledSkillInfo) => {
      try {
        const result = await window.api.skill.exportZip(skill.baseDir, skill.name)
        if (!result.canceled) {
          message.success(t('skills.exportSuccess'))
        }
      } catch (err) {
        message.error(t('skills.exportFailed', { error: String(err) }))
      }
    },
    [message, t]
  )

  const handleImportLocal = useCallback(
    async (kind: 'directory' | 'zip') => {
      try {
        const result = await window.api.skill.importLocal(kind, skillsDir)
        if (result.canceled) return
        if (result.imported.length > 0) {
          message.success(t('skills.importSuccess', { count: result.imported.length }))
        }
        if (result.errors.length > 0) {
          const firstError = result.errors[0]?.error ?? ''
          message.warning(
            t('skills.importPartialFailed', { count: result.errors.length, error: firstError })
          )
        }
        if (result.imported.length === 0 && result.errors.length === 0) return
        await loadInstalled()
      } catch (err) {
        message.error(t('skills.importFailed', { error: String(err) }))
      }
    },
    [loadInstalled, message, skillsDir, t]
  )

  const handleOpenDir = useCallback(async () => {
    await window.api.skill.openDir()
  }, [])

  const installedSlugs = useMemo(
    () => new Set(installedSkills.map((s) => s.name)),
    [installedSkills]
  )

  return {
    wsReady,
    installedSkills,
    setInstalledSkills,
    skillsDir,
    installedLoading,
    loadInstalled,
    handleUninstall,
    handleToggleEnabled,
    handleSaveApiKey,
    handleExport,
    handleImportLocal,
    handleOpenDir,
    installedSlugs,
  }
}
