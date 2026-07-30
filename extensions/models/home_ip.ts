/**
 * Home public IP tracker — resolves the current public IPv4 address and keeps a
 * 1Password field in sync with it via a 1Password Connect server.
 *
 * Built for residential connections whose public address changes occasionally.
 * The value is consumed downstream by an Ansible role that allowlists the home
 * address in UFW, so the field path has to be exact and stable.
 *
 * Connect (not the `op` CLI) because this runs unattended under `swamp serve`:
 * Connect authenticates with a token from the environment and needs no
 * interactive session. Note a Connect server cannot read the built-in
 * Private/Personal/Employee or default Shared vaults — the item must live in a
 * vault the Connect token was granted.
 *
 * @module
 */
// extensions/models/home_ip.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  connectHost: z.string().url().describe(
    "1Password Connect base URL, e.g. http://connect:8080",
  ),
  connectToken: z.string().meta({ sensitive: true }).describe(
    "1Password Connect API token — supply via vault.get() or the environment, never inline",
  ),
  opVault: z.string().default("homelab").describe(
    "1Password vault holding the item. Must be Connect-readable; Connect cannot read Private/Shared.",
  ),
  itemTitle: z.string().default("home-network").describe(
    "Title of the 1Password item to update",
  ),
  fieldLabel: z.string().default("home-ip").describe(
    "Label of the field within the item that holds the address",
  ),
  ipEndpoint: z.string().url().default("https://api.ipify.org?format=json")
    .describe(
      "Endpoint returning the caller's public IP. Must return JSON containing an `ip` key.",
    ),
  timeoutMs: z.number().int().positive().default(10000).describe(
    "Abort any single HTTP call after this long. Guards the scheduled case: a hung request would otherwise stall the run forever and, because overlapping runs are skipped, silently stop every future tick.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const HomeIpSchema = z.object({
  ip: z.string().describe("Current public IPv4 address"),
  previousIp: z.string().nullable().describe(
    "Value the 1Password field held before this run, null if it was empty",
  ),
  changed: z.boolean().describe(
    "True when 1Password was actually written this run",
  ),
  itemId: z.string(),
  vaultId: z.string(),
  checkedAt: z.string(),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

/**
 * Reject anything that is not a dotted-quad IPv4 address.
 *
 * This guard is the difference between a transient upstream hiccup and a
 * corrupted firewall allowlist: a captive portal or error page that returns 200
 * with HTML would otherwise be written straight into 1Password and then into a
 * UFW rule. Refusing to write is always the safer failure here, because the
 * previous good value stays in place.
 */
function assertIpv4(candidate: string): string {
  const ip = candidate.trim();
  const octets = ip.split(".");
  // Leading zeros are rejected deliberately, not just for tidiness: "010.1.1.1"
  // is read as octal by some parsers (inet_aton among them), so a value that
  // looks benign here could mean a different address in the firewall rule it
  // ends up in.
  const valid = octets.length === 4 &&
    octets.every((o) => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255);
  if (!valid) {
    throw new Error(
      `Refusing to store "${ip}" — not a dotted-quad IPv4 address. ` +
        `Leaving the existing 1Password value untouched.`,
    );
  }
  return ip;
}

/** Connect returns errors as JSON; surface the message rather than a bare status. */
async function connectFetch(
  globalArgs: GlobalArgs,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${globalArgs.connectHost}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${globalArgs.connectToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(globalArgs.timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError"
      ? `timed out after ${globalArgs.timeoutMs}ms`
      : String(cause);
    throw new Error(
      `1Password Connect ${init.method ?? "GET"} ${path} failed: ${reason}`,
    );
  }

  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `1Password Connect ${
        init.method ?? "GET"
      } ${path} failed: ${res.status} ${body}`,
    );
  }
  return body ? JSON.parse(body) : null;
}

type ConnectField = {
  id: string;
  label?: string;
  value?: string;
  type?: string;
  purpose?: string;
};

type ConnectItem = {
  id: string;
  title: string;
  vault: { id: string };
  category: string;
  fields?: ConnectField[];
};

/** Resolve a vault title to its UUID. Connect filters use SCIM-ish `eq` syntax. */
async function resolveVaultId(
  globalArgs: GlobalArgs,
  logger: Logger,
): Promise<string> {
  const filter = encodeURIComponent(`title eq "${globalArgs.opVault}"`);
  const vaults = await connectFetch(
    globalArgs,
    `/v1/vaults?filter=${filter}`,
  ) as Array<{ id: string; name?: string }>;

  if (!Array.isArray(vaults) || vaults.length === 0) {
    throw new Error(
      `Vault "${globalArgs.opVault}" not found, or the Connect token has no access to it. ` +
        `Connect cannot read the built-in Private/Personal/Employee or default Shared vaults.`,
    );
  }
  if (vaults.length > 1) {
    logger.warn(
      "Multiple vaults titled {vault}; using the first",
      { vault: globalArgs.opVault },
    );
  }
  return vaults[0].id;
}

/** Resolve an item title to its full record within a vault. */
async function resolveItem(
  globalArgs: GlobalArgs,
  vaultId: string,
): Promise<ConnectItem> {
  const filter = encodeURIComponent(`title eq "${globalArgs.itemTitle}"`);
  const items = await connectFetch(
    globalArgs,
    `/v1/vaults/${vaultId}/items?filter=${filter}`,
  ) as Array<{ id: string }>;

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      `Item "${globalArgs.itemTitle}" not found in vault "${globalArgs.opVault}". ` +
        `Create it with a "${globalArgs.fieldLabel}" field before running this model.`,
    );
  }

  // The list endpoint omits field values; fetch the item to read them.
  return await connectFetch(
    globalArgs,
    `/v1/vaults/${vaultId}/items/${items[0].id}`,
  ) as ConnectItem;
}

/**
 * Model type `@sntxrr/home-ip`.
 *
 * Exposes a single `sync` method that resolves the caller's public IPv4 address
 * and reconciles a named 1Password field with it through a Connect server,
 * writing only when the address has actually moved.
 *
 * @example
 * ```bash
 * swamp model create @sntxrr/home-ip home-ip
 * swamp model @sntxrr/home-ip method run sync home-ip
 * ```
 */
export const model = {
  type: "@sntxrr/home-ip",
  description:
    "Resolve the current public IPv4 address and keep a 1Password field in sync with it via 1Password Connect",
  version: "2026.07.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "homeIp": {
      description:
        "Result of a home-IP reconciliation: the address, whether 1Password changed, and when",
      schema: HomeIpSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    sync: {
      description:
        "Resolve the public IP and write it to the configured 1Password field if it differs",
      arguments: z.object({
        dryRun: z.boolean().default(false).describe(
          "Resolve and compare, but never write to 1Password",
        ),
      }),
      execute: async (
        args: { dryRun: boolean },
        context: {
          globalArgs: GlobalArgs;
          logger: Logger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { globalArgs, logger } = context;

        let ipRes: Response;
        try {
          ipRes = await fetch(globalArgs.ipEndpoint, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(globalArgs.timeoutMs),
          });
        } catch (cause) {
          const reason = cause instanceof Error && cause.name === "TimeoutError"
            ? `timed out after ${globalArgs.timeoutMs}ms`
            : String(cause);
          throw new Error(
            `IP endpoint ${globalArgs.ipEndpoint} failed: ${reason}`,
          );
        }
        if (!ipRes.ok) {
          throw new Error(
            `IP endpoint ${globalArgs.ipEndpoint} returned ${ipRes.status}`,
          );
        }
        const payload = await ipRes.json() as { ip?: unknown };
        if (typeof payload.ip !== "string") {
          throw new Error(
            `IP endpoint ${globalArgs.ipEndpoint} returned no string "ip" field: ${
              JSON.stringify(payload)
            }`,
          );
        }
        const ip = assertIpv4(payload.ip);

        const vaultId = await resolveVaultId(globalArgs, logger);
        const item = await resolveItem(globalArgs, vaultId);

        const fields = item.fields ?? [];
        const target = fields.find((f) => f.label === globalArgs.fieldLabel);
        if (!target) {
          throw new Error(
            `Item "${globalArgs.itemTitle}" has no field labelled "${globalArgs.fieldLabel}". ` +
              `Existing labels: ${
                fields.map((f) => f.label ?? f.id).join(", ") || "(none)"
              }`,
          );
        }

        const previousIp = target.value && target.value.length > 0
          ? target.value
          : null;
        const changed = previousIp !== ip;

        if (!changed) {
          logger.info("Home IP unchanged at {ip}; leaving 1Password alone", {
            ip,
          });
        } else if (args.dryRun) {
          logger.info(
            "Dry run: would update {field} from {previous} to {ip}",
            { field: globalArgs.fieldLabel, previous: previousIp, ip },
          );
        } else {
          // PUT the whole item back with the one field replaced. Connect also
          // accepts JSON Patch, but a full replace keeps every other field
          // exactly as read, which matters because this item is hand-maintained.
          const updated: ConnectItem = {
            ...item,
            fields: fields.map((f) =>
              f.label === globalArgs.fieldLabel ? { ...f, value: ip } : f
            ),
          };
          await connectFetch(
            globalArgs,
            `/v1/vaults/${vaultId}/items/${item.id}`,
            { method: "PUT", body: JSON.stringify(updated) },
          );
          logger.info("Updated {field} from {previous} to {ip}", {
            field: globalArgs.fieldLabel,
            previous: previousIp,
            ip,
          });
        }

        const handle = await context.writeResource("homeIp", "current", {
          ip,
          previousIp,
          changed: changed && !args.dryRun,
          itemId: item.id,
          vaultId,
          checkedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
