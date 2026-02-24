export function ensureProbableApiBase(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.includes('/public/api/v1')) {
    return trimmed;
  }
  return `${trimmed}/public/api/v1`;
}

export function joinProbablePath(base: string, path: string): string {
  const normalized = ensureProbableApiBase(base);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${normalized}${suffix}`;
}
