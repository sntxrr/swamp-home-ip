# @sntxrr/home-ip

Resolve the current public IPv4 address and keep a 1Password field in sync with
it, via a [1Password Connect](https://developer.1password.com/docs/connect/)
server.

Built for residential connections whose public address changes occasionally. The
value is consumed downstream by automation that allowlists the home address in a
firewall, so the field path has to be exact and stable.

## Why Connect rather than the `op` CLI

This is designed to run unattended under `swamp serve`. Connect authenticates
with a token from the environment and needs no interactive session.

**A Connect server cannot read the built-in Private, Personal, Employee, or
default Shared vaults.** The item must live in a vault the Connect token was
explicitly granted, and the model says so in the error when the vault lookup
comes back empty.

## Prerequisites

- A reachable 1Password Connect server
- A Connect token with **read + write** on the target vault
- An existing item in that vault carrying the field to update — this model
  updates a field, it does not create the item

## Configuration

| Argument       | Default                            | Purpose                                            |
| -------------- | ---------------------------------- | -------------------------------------------------- |
| `connectHost`  | —                                  | Connect base URL, e.g. `http://connect:8080`        |
| `connectToken` | —                                  | Connect API token — supply via `vault.get()`        |
| `opVault`      | `homelab`                          | Vault holding the item (must be Connect-readable)   |
| `itemTitle`    | `home-network`                     | Title of the item to update                         |
| `fieldLabel`   | `home-ip`                          | Label of the field holding the address              |
| `ipEndpoint`   | `https://api.ipify.org?format=json` | Must return JSON with a string `ip` key            |

Never inline `connectToken`. Reference it with a vault expression so it is
resolved at runtime rather than persisted in the model definition.

## Methods

### `sync`

Resolves the public IP, compares it to the field's current value, and writes
only when they differ.

| Argument | Default | Purpose                                        |
| -------- | ------- | ---------------------------------------------- |
| `dryRun` | `false` | Resolve and compare, but never write           |

```bash
swamp model @sntxrr/home-ip method run sync home-ip
swamp model @sntxrr/home-ip method run sync home-ip --args '{"dryRun": true}'
```

## Behaviour worth knowing

**Non-IPv4 responses are refused.** A captive portal or error page that returns
`200` with HTML would otherwise be written straight into 1Password and from
there into a firewall rule. The model validates a dotted-quad address with
in-range octets and throws otherwise, leaving the previous good value in place.
Refusing to write is the safer failure: a stale address still works until the
next run, a corrupted one does not.

**Writes replace the whole item.** The model `GET`s the item, substitutes the
one field, and `PUT`s it back, so every other field survives byte-for-byte. This
matters because these items tend to be hand-maintained.

**Unchanged addresses issue no write at all**, so 1Password's item history stays
meaningful — an entry there means the address actually moved.

## Data

Each run writes a `homeIp` resource:

| Field        | Meaning                                                |
| ------------ | ------------------------------------------------------ |
| `ip`         | The address resolved this run                          |
| `previousIp` | What the field held before, `null` if it was empty     |
| `changed`    | Whether 1Password was actually written                 |
| `itemId`     | Resolved 1Password item UUID                           |
| `vaultId`    | Resolved 1Password vault UUID                          |
| `checkedAt`  | ISO timestamp of the check                             |

Inspect it with a single CEL predicate — note `content.`, and that the model name
is part of the predicate rather than a separate argument:

```bash
swamp data query 'modelName == "home-ip"' --json | jq '.results[].content'

# runs that actually wrote
swamp data query 'modelName == "home-ip" && content.changed == true' --json
```

## Scheduling

Give a workflow a `trigger.schedule` and run `swamp serve`; it registers cron
entries at startup and picks up schedule changes via a filesystem watcher
without a restart. Two behaviours to plan around: **overlap prevention** (a
trigger is skipped if the previous run is still going) and **no catch-up**
(schedules missed while `serve` was down do not fire on startup — the next tick
corrects it).
