// extensions/models/home_ip_test.ts
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing";
import { model } from "./home_ip.ts";

type SyncContext = Parameters<typeof model.methods.sync.execute>[1];

const GLOBAL_ARGS = {
  connectHost: "http://connect:8080",
  connectToken: "connect-test-token",
  opVault: "homelab",
  itemTitle: "home-network",
  fieldLabel: "home-ip",
  ipEndpoint: "https://api.ipify.org?format=json",
};

function syncContext(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const ctx = createModelTestContext({ globalArgs, methodName: "sync" });
  return { ...ctx, context: ctx.context as unknown as SyncContext };
}

/** Item as Connect returns it from the single-item GET. */
function itemFixture(currentValue: string | undefined) {
  return {
    id: "item-abc",
    title: "home-network",
    vault: { id: "vault-xyz" },
    category: "LOGIN",
    fields: [
      { id: "f1", label: "notes", value: "hand maintained" },
      { id: "f2", label: "home-ip", value: currentValue },
    ],
  };
}

/**
 * Route the four calls a sync makes: ip endpoint, vault lookup, item lookup,
 * item fetch -- plus the PUT when it writes. Returns the PUT bodies seen.
 */
function connectRoutes(
  opts: { ip: string; currentValue: string | undefined },
) {
  const puts: Array<Record<string, unknown>> = [];
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.hostname === "api.ipify.org") {
      return Response.json({ ip: opts.ip });
    }
    if (req.method === "PUT") {
      puts.push(JSON.parse(await req.text()));
      return Response.json(itemFixture(opts.ip));
    }
    if (url.pathname === "/v1/vaults") {
      return Response.json([{ id: "vault-xyz", name: "homelab" }]);
    }
    if (url.pathname === "/v1/vaults/vault-xyz/items") {
      return Response.json([{ id: "item-abc" }]);
    }
    if (url.pathname === "/v1/vaults/vault-xyz/items/item-abc") {
      return Response.json(itemFixture(opts.currentValue));
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };
  return { handler, puts };
}

Deno.test("sync writes the new address when it differs", async () => {
  const { context, getWrittenResources } = syncContext();
  const { handler, puts } = connectRoutes({
    ip: "203.0.113.7",
    currentValue: "198.51.100.4",
  });

  await withMockedFetch(handler, async () => {
    await model.methods.sync.execute({ dryRun: false }, context);
  });

  assertEquals(puts.length, 1);
  const written = puts[0].fields as Array<{ label: string; value: string }>;
  assertEquals(written.find((f) => f.label === "home-ip")?.value, "203.0.113.7");
  // Untouched fields must survive the full-item PUT.
  assertEquals(
    written.find((f) => f.label === "notes")?.value,
    "hand maintained",
  );

  const resources = getWrittenResources();
  assertEquals(resources[0].data.ip, "203.0.113.7");
  assertEquals(resources[0].data.previousIp, "198.51.100.4");
  assertEquals(resources[0].data.changed, true);
});

Deno.test("sync does not write when the address is unchanged", async () => {
  const { context, getWrittenResources } = syncContext();
  const { handler, puts } = connectRoutes({
    ip: "203.0.113.7",
    currentValue: "203.0.113.7",
  });

  await withMockedFetch(handler, async () => {
    await model.methods.sync.execute({ dryRun: false }, context);
  });

  assertEquals(puts.length, 0, "unchanged IP must not issue a PUT");
  assertEquals(getWrittenResources()[0].data.changed, false);
});

Deno.test("dryRun never writes even when the address differs", async () => {
  const { context, getWrittenResources } = syncContext();
  const { handler, puts } = connectRoutes({
    ip: "203.0.113.7",
    currentValue: "198.51.100.4",
  });

  await withMockedFetch(handler, async () => {
    await model.methods.sync.execute({ dryRun: true }, context);
  });

  assertEquals(puts.length, 0);
  assertEquals(getWrittenResources()[0].data.changed, false);
});

Deno.test("an empty existing field is reported as previousIp null", async () => {
  const { context, getWrittenResources } = syncContext();
  const { handler, puts } = connectRoutes({
    ip: "203.0.113.7",
    currentValue: undefined,
  });

  await withMockedFetch(handler, async () => {
    await model.methods.sync.execute({ dryRun: false }, context);
  });

  assertEquals(puts.length, 1);
  assertEquals(getWrittenResources()[0].data.previousIp, null);
});

// The guard that matters most: a captive portal or error page returning 200 with
// non-IP content must never reach 1Password, because that value becomes a UFW rule.
Deno.test("a non-IPv4 response is refused and nothing is written", async () => {
  const { context } = syncContext();
  const puts: string[] = [];

  await withMockedFetch(
    (req) => {
      if (req.method === "PUT") puts.push(req.url);
      return Promise.resolve(Response.json({ ip: "<html>login</html>" }));
    },
    async () => {
      await assertRejects(
        () => model.methods.sync.execute({ dryRun: false }, context),
        Error,
        "not a dotted-quad IPv4 address",
      );
    },
  );

  assertEquals(puts.length, 0);
});

Deno.test("out-of-range octets are refused", async () => {
  const { context } = syncContext();

  await withMockedFetch(
    () => Promise.resolve(Response.json({ ip: "999.1.1.1" })),
    async () => {
      await assertRejects(
        () => model.methods.sync.execute({ dryRun: false }, context),
        Error,
        "not a dotted-quad IPv4 address",
      );
    },
  );
});

Deno.test("a missing vault explains the Connect visibility rule", async () => {
  const { context } = syncContext();

  await withMockedFetch(
    (req) => {
      const url = new URL(req.url);
      if (url.hostname === "api.ipify.org") {
        return Promise.resolve(Response.json({ ip: "203.0.113.7" }));
      }
      return Promise.resolve(Response.json([]));
    },
    async () => {
      const err = await assertRejects(
        () => model.methods.sync.execute({ dryRun: false }, context),
      );
      assertStringIncludes(
        (err as Error).message,
        "cannot read the built-in Private",
      );
    },
  );
});

Deno.test("a missing field lists the labels that do exist", async () => {
  const { context } = syncContext({ ...GLOBAL_ARGS, fieldLabel: "wrong-label" });
  const { handler } = connectRoutes({
    ip: "203.0.113.7",
    currentValue: "198.51.100.4",
  });

  await withMockedFetch(handler, async () => {
    const err = await assertRejects(
      () => model.methods.sync.execute({ dryRun: false }, context),
    );
    assertStringIncludes((err as Error).message, "home-ip");
  });
});
