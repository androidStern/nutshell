export function looksLikeRateLimit(text: string): boolean {
  return /rate.?limit|too many requests|429/i.test(text);
}

export function looksLikeAuthFailure(text: string): boolean {
  return /unauthorized|forbidden|login required|invalid.*cookie|auth.*failed/i.test(text);
}

