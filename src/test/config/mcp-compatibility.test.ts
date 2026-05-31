import { describe, expect, it } from 'vitest'

import {
  ensureBuiltInMcpServers,
  normalizeExternalMcpConfig,
  quarantineInvalidMcpServers,
  type OpenclawConfig,
} from '../../main/config/manager'

describe('normalizeExternalMcpConfig', () => {
  it('moves top-level mcpServers into mcp.servers', () => {
    const config = {
      mcpServers: {
        tongdaxin: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer test' },
        },
      },
    } as OpenclawConfig

    const result = normalizeExternalMcpConfig(config)

    expect(result.changed).toBe(true)
    expect(result.migrated).toEqual(['tongdaxin'])
    expect(config.mcp?.servers?.tongdaxin).toEqual({
      url: 'https://example.com/mcp',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer test' },
    })
    expect(config['mcpServers']).toBeUndefined()
  })

  it('keeps existing mcp.servers entries when external names conflict', () => {
    const config = {
      mcp: {
        servers: {
          tongdaxin: { command: 'existing-mcp' },
        },
      },
      mcpServers: {
        tongdaxin: { command: 'new-mcp' },
        market: { command: 'market-mcp', type: 'stdio' },
      },
    } as OpenclawConfig

    const result = normalizeExternalMcpConfig(config)

    expect(result.changed).toBe(true)
    expect(result.migrated).toEqual(['market'])
    expect(result.skipped).toEqual(['tongdaxin'])
    expect(config.mcp?.servers?.tongdaxin).toEqual({ command: 'existing-mcp' })
    expect(config.mcp?.servers?.market).toEqual({ command: 'market-mcp' })
    expect(config['mcpServers']).toBeUndefined()
  })

  it('removes malformed external MCP root keys', () => {
    const config = {
      mcpServers: true,
      mcp_servers: null,
    } as OpenclawConfig

    const result = normalizeExternalMcpConfig(config)

    expect(result.changed).toBe(true)
    expect(result.migrated).toEqual([])
    expect(result.skipped).toEqual(['mcpServers', 'mcp_servers'])
    expect(result.removedLegacyKeys).toEqual(['mcpServers', 'mcp_servers'])
    expect(config['mcpServers']).toBeUndefined()
    expect(config['mcp_servers']).toBeUndefined()
  })

  it('quarantines malformed mcp.servers entries before startup', () => {
    const config = {
      mcp: {
        servers: {
          broken: { args: ['serve'] },
          recursive: { command: 'mcp', args: ['serve'] },
          valid: { command: 'npx', args: ['-y', 'some-mcp-server'] },
          remote: { type: 'http', url: 'https://example.com/mcp' },
        },
      },
    } as OpenclawConfig

    const quarantined = quarantineInvalidMcpServers(config)

    expect(quarantined).toEqual(['broken', 'recursive'])
    expect(config.mcp?.servers?.broken).toBeUndefined()
    expect(config.mcp?.servers?.recursive).toBeUndefined()
    expect(config.mcp?.servers?.valid).toEqual({
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
    })
    expect(config.mcp?.servers?.remote).toEqual({
      url: 'https://example.com/mcp',
      transport: 'streamable-http',
    })
  })

  it('adds the built-in Chrome DevTools MCP server when missing', () => {
    const config = {} as OpenclawConfig

    const ensured = ensureBuiltInMcpServers(config)

    expect(ensured).toEqual(['chrome-devtools'])
    expect(config.mcp?.servers?.['chrome-devtools']?.command).toBeTruthy()
    expect(config.mcp?.servers?.['chrome-devtools']?.args).toEqual(
      expect.arrayContaining([expect.stringContaining('chrome-devtools-mcp')])
    )
  })

  it('does not replace a custom MCP server that uses the same name', () => {
    const config = {
      mcp: {
        servers: {
          'chrome-devtools': { command: 'custom-browser-tool', args: ['serve'] },
        },
      },
    } as OpenclawConfig

    const ensured = ensureBuiltInMcpServers(config)

    expect(ensured).toEqual([])
    expect(config.mcp?.servers?.['chrome-devtools']).toEqual({
      command: 'custom-browser-tool',
      args: ['serve'],
    })
  })
})
