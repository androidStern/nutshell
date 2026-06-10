export function looksLikeRateLimit(text: string): boolean {
  return /rate.?limit|too many requests|429/i.test(text);
}

export function looksLikeAuthFailure(text: string): boolean {
  // "auth cookies missing" is the product's own no-session message from
  // BirdClient.buildClient — a signed-out browser, not a transient failure.
  return /unauthorized|forbidden|login required|invalid.*cookie|auth.*failed|auth cookies missing/i.test(text);
}

