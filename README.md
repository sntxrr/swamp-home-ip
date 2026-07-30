# swamp-home-ip

Swamp extension providing **`@sntxrr/home-ip`** — resolve this site's current
public IPv4 address and keep a 1Password field in sync with it via a
[1Password Connect](https://developer.1password.com/docs/connect/) server.

Built for a residential connection whose address changes occasionally. The
stored value is read by automation that allowlists the home address in a
firewall, so the field path has to be exact and stable.

| | |
| --- | --- |
| Model | [`extensions/models/home_ip.ts`](extensions/models/home_ip.ts) |
| Docs | [`extensions/models/README.md`](extensions/models/README.md) |
| Tests | `deno test --allow-all extensions/models/home_ip_test.ts` |
| Quality | `swamp extension quality extensions/models/manifest.yaml` |

## Quick start

```bash
swamp model create @sntxrr/home-ip home-ip \
  --global-arg 'connectHost=https://connect.example.internal' \
  --global-arg 'connectToken=${{ vault.get(my-1password, "op://Private/<item-uuid>/token.jwt") }}' \
  --global-arg 'opVault=homelab'

swamp model @sntxrr/home-ip method run sync home-ip --args '{"dryRun": true}'
```

Reference the Connect token by item **UUID**, not title: `op` rejects `(` and
`)` in a secret reference outright, and spaces require quoting. The UUID avoids
both and survives the item being renamed.

See the [model README](extensions/models/README.md) for configuration, the
IPv4 guard, write semantics, and scheduling under `swamp serve`.
