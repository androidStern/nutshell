export const CHROME_SAFE_STORAGE_REASON = "chrome_safe_storage_keychain";

export function isChromeSafeStorageAccessIssue(text: string): boolean {
  return /Chrome Safe Storage|Safe Storage|macOS Keychain|keychain|security find-generic-password|cookie.*decrypt|decrypt.*cookie/i.test(text);
}

export function chromeSafeStorageAccessMessage(sourceLabel: string): string {
  return `${sourceLabel} browser session is signed in, but macOS blocked access to Chrome Safe Storage. Allow Nutshell.app to use Chrome Safe Storage in Keychain, then try again.`;
}
