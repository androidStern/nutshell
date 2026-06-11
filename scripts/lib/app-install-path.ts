import { homedir } from "node:os";
import { join, resolve } from "node:path";

const APP_NAME = "Nutshell.app";

export function defaultAppInstallDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.NUTSHELL_INSTALL_APP_DIR ? resolve(env.NUTSHELL_INSTALL_APP_DIR) : join(home, "Applications");
}

export function appInstallPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(defaultAppInstallDir(env, home), APP_NAME);
}
