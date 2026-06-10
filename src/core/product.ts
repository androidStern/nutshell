import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_NAME = "Nutshell";
export const PRODUCT_VERSION = "0.1.25";
export const CLI_NAME = "nutshell";
export const CONFIG_FILENAME = "nutconfig.jsonc";
export const CONFIG_ENV = "NUTSHELL_CONFIG";
export const ROOT_ENV = "NUTSHELL_ROOT";
export const APP_PATH_ENV = "NUTSHELL_APP_PATH";
export const COMMAND_ENV = "NUTSHELL_COMMAND";
export const LAUNCHD_LABEL = "com.winterfell.nutshell";
export const DEFAULT_ROOT = join(homedir(), "Nutshell");
export const DEFAULT_APP_PATH = "/Applications/Nutshell.app";
