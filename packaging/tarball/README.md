# Nutshell Tarball Install

This tarball contains a standalone `nutshell` executable. Bun is not required on the target machine.

`manifest.json` lists every file in the tarball with size and SHA-256 checksums. The release also ships an external `.sha256` file for the tarball itself.

```bash
./install.sh
nutshell health
```

The installer copies `nutshell` into a stable PATH directory, initializes `~/nutconfig.jsonc` and `~/Nutshell/`, and installs one launchd job.

Uninstall keeps user data:

```bash
./uninstall.sh
```

If the installer cannot find a writable PATH directory, set one explicitly:

```bash
NUTSHELL_INSTALL_BIN="$HOME/.local/bin" ./install.sh
```
