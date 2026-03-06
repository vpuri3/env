# env

Personal shell and editor configuration, with a bootstrap script for setting up a new machine.

## Layout

- `bootstrap.sh`: interactive machine bootstrap
- `bash_vars`: exported environment variables and cache paths
- `bash_alias`: interactive aliases
- `sshconfig`: shared SSH config checked into the repo
- `sshconfig.local.example`: template for machine-local SSH overrides
- `nvim/`: Neovim config
- `bin/`: small helper scripts linked into `~/bin`

## Bootstrap

Run:

```bash
~/env/bootstrap.sh
```

The bootstrap script is idempotent for shell profile entries and installs Neovim under `~/.local/neovim`, with `~/.local/bin/nvim` and `~/.local/bin/nv` symlinks.

## SSH overrides

Shared SSH host definitions live in [`sshconfig`](/home/vedantpu/env/sshconfig). Machine-specific secrets or identities should not be committed there.

Use a local override file instead:

```bash
cp ~/env/sshconfig.local.example ~/.ssh/config.local
```

Then add host-specific entries such as GitHub identities or workstation-only hosts to `~/.ssh/config.local`.

## Validation

Shell changes are validated in CI with `shellcheck` for:

- `bootstrap.sh`
- `bash_alias`
- `bash_vars`
- `misc.sh`
