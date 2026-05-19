function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeGraphqlEndpoint(value: string): string {
  const trimmed = trimTrailingSlash(value.trim());
  if (!trimmed) {
    return trimmed;
  }

  return trimmed.endsWith("/graphql") ? trimmed : `${trimmed}/graphql`;
}
