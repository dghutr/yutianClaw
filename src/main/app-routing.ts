export function resolveInitialRoute(params: {
  hasValidConfig: boolean
  hasProviders: boolean
  setupCompleted?: boolean
  hasSeenConfigFoundDialog?: boolean
}): { route: '/setup' | '/dashboard'; hasConfig: boolean; hasProviders?: boolean } {
  return {
    route: '/dashboard',
    hasConfig: params.hasValidConfig,
    hasProviders: params.hasValidConfig ? params.hasProviders : undefined,
  }
}
