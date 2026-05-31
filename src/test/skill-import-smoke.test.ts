import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { importLocalSkillsFromPath } from '../main/services/skills-manager'

const harmonyosPaidSkillMd = [
  '---',
  'name: harmonyos-dev',
  'description: Paid HarmonyOS ArkTS development skill import smoke test.',
  '---',
  '',
  '# HarmonyOS Dev',
  '',
  'Use this paid external skill for HarmonyOS ArkTS development, SDK lookup, and performance review.',
  '',
].join('\n')

describe('local skill import smoke', () => {
  it('imports a parent directory containing a custom SKILL.md folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'yutian-skill-import-'))
    try {
      const parentDir = join(root, 'custom-skills')
      const skillDir = join(parentDir, 'raw-harmony-skill')
      const installDir = join(root, 'installed')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: harmonyos-import-test',
          'description: Custom HarmonyOS import smoke test.',
          '---',
          '',
          '# HarmonyOS Import Test',
          '',
        ].join('\n'),
        'utf-8'
      )

      const result = importLocalSkillsFromPath(parentDir, installDir)

      expect(result.errors).toEqual([])
      expect(result.imported).toEqual(['harmonyos-import-test'])
      const importedSkill = join(installDir, 'harmonyos-import-test', 'SKILL.md')
      expect(existsSync(importedSkill)).toBe(true)
      expect(readFileSync(importedSkill, 'utf-8')).toContain('harmonyos-import-test')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('imports a paid HarmonyOS skill from an external directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'yutian-harmony-skill-import-'))
    try {
      const sourceDir = join(root, 'external-paid-skills', 'harmonyos-dev')
      const installDir = join(root, 'installed')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'SKILL.md'), harmonyosPaidSkillMd, 'utf-8')

      const result = importLocalSkillsFromPath(sourceDir, installDir)

      expect(result.errors).toEqual([])
      expect(result.imported).toEqual(['harmonyos-dev'])
      expect(existsSync(join(installDir, 'harmonyos-dev', 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('imports a paid HarmonyOS skill from an external zip upload', () => {
    const root = mkdtempSync(join(tmpdir(), 'yutian-harmony-skill-zip-'))
    try {
      const zipPath = join(root, 'harmonyos-dev.zip')
      const installDir = join(root, 'installed')
      const zip = new AdmZip()
      zip.addFile('SKILL.md', Buffer.from(harmonyosPaidSkillMd, 'utf-8'))
      zip.writeZip(zipPath)

      const result = importLocalSkillsFromPath(zipPath, installDir)

      expect(result.errors).toEqual([])
      expect(result.imported).toEqual(['harmonyos-dev'])
      expect(existsSync(join(installDir, 'harmonyos-dev', 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
