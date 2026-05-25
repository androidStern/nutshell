# Nutshell Tarball Install

This tarball contains a standalone `nutshell` executable and, on macOS release builds, `Nutshell.app`. Bun is not required on the target machine.

`manifest.json` lists every file in the tarball with size and SHA-256 checksums. The release also ships an external `.sha256` file for the tarball itself.

```bash
./install.sh
nutshell setup
```

The installer copies `nutshell` into a stable PATH directory and copies `Nutshell.app` to `~/Applications/Nutshell.app` when the app bundle is present. Setup creates `~/nutconfig.jsonc`, prepares `~/Nutshell/`, guides permissions, and enables the app-owned background sync agent.

Uninstall keeps user data:

```bash
./uninstall.sh
```

If the installer cannot find a writable PATH directory, set one explicitly:

```bash
NUTSHELL_INSTALL_BIN="$HOME/.local/bin" ./install.sh
```

To install the app bundle somewhere else:

```bash
NUTSHELL_INSTALL_APP_DIR="/Applications" ./install.sh
```
