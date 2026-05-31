import { describe, expect, it } from 'vitest'
import { resolveInitialRoute } from '../../main/app-routing'

describe('resolveInitialRoute', () => {
  it('opens dashboard for a completed setup with valid providers', () => {
    expect(
      resolveInitialRoute({
        hasValidConfig: true,
        hasProviders: true,
        setupCompleted: true,
        hasSeenConfigFoundDialog: false,
      })
    ).toEqual({
      route: '/dashboard',
      hasConfig: true,
      hasProviders: true,
    })
  })

  it('opens dashboard even when no provider has been configured yet', () => {
    expect(
      resolveInitialRoute({
        hasValidConfig: true,
        hasProviders: false,
        setupCompleted: true,
        hasSeenConfigFoundDialog: true,
      })
    ).toEqual({
      route: '/dashboard',
      hasConfig: true,
      hasProviders: false,
    })
  })

  it('opens dashboard when an existing config is detected before setup completion', () => {
    expect(
      resolveInitialRoute({
        hasValidConfig: true,
        hasProviders: true,
        setupCompleted: false,
        hasSeenConfigFoundDialog: false,
      })
    ).toEqual({
      route: '/dashboard',
      hasConfig: true,
      hasProviders: true,
    })
  })

  it('opens dashboard for a brand-new profile without config', () => {
    expect(
      resolveInitialRoute({
        hasValidConfig: false,
        hasProviders: false,
        hasSeenConfigFoundDialog: true,
      })
    ).toEqual({
      route: '/dashboard',
      hasConfig: false,
      hasProviders: undefined,
    })
  })
})
