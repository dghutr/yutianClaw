export function getCompactVersionLabel(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) return ''

  const [base] = trimmed.split('-', 1)
  const parts = base.split('.').filter(Boolean)
  return parts.slice(0, 3).join('.')
}
