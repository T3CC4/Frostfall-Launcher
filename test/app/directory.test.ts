import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import {
  DirectoryApi,
  joinCodeFromUrl,
  joinTargetFromUrl,
} from "../../src/app/directory.js";

test("private join URLs accept only the expected scheme and safe code", () => {
  assert.equal(joinCodeFromUrl("skymp://join/friends-only"), "friends-only");
  assert.equal(joinCodeFromUrl("https://join/friends-only"), null);
  assert.equal(joinCodeFromUrl("skymp://join/%2Fescape"), null);
  assert.deepEqual(
    joinTargetFromUrl(
      "skymp://join/friends-only?directory=https%3A%2F%2Fdirectory.example&fingerprint=" +
        "a".repeat(64),
    ),
    {
      code: "friends-only",
      directory: "https://directory.example",
      fingerprint: "a".repeat(64),
    },
  );
});

test("directory verifies the exact signed catalog without operator backends", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  let valid = true;
  const server = http.createServer((_req, res) => {
    const raw = JSON.stringify({
      items: [
        {
          serverId: "eu",
          descriptor: {
            contract: "directory-managed",
            name: "EU",
            address: "game.example",
            gamePort: 7777,
            resourcesPort: 7778,
            region: "eu",
            tags: [],
            versions: {},
          },
          status: { state: "online", online: 1, maxPlayers: 10 },
          identity: {
            algorithm: "Ed25519",
            publicKey: publicKey
              .export({ format: "der", type: "spki" })
              .toString("base64"),
            fingerprint: `sha256:${crypto
              .createHash("sha256")
              .update(publicKey.export({ format: "der", type: "spki" }))
              .digest("base64url")}`,
          },
        },
      ],
    });
    const signature = crypto.sign(null, Buffer.from(raw), privateKey);
    if (!valid) signature[0] = (signature[0] ?? 0) ^ 0xff;
    res.setHeader("x-skymp-signature", signature.toString("base64url"));
    res.end(raw);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = new DirectoryApi({
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  });
  try {
    assert.deepEqual(await api.servers(), [
      {
        key: "eu",
        contract: "directory-managed",
        name: "EU",
        address: "game.example",
        port: 7777,
        resourcesPort: 7778,
        description: "",
        status: { state: "online", online: 1, maxPlayers: 10 },
        region: "eu",
        tags: [],
        versions: {},
        visibility: "public",
        lastHeartbeatAt: 0,
        source: "directory",
        stale: false,
        listed: true,
        access: undefined,
        modpack: undefined,
        identity: {
          algorithm: "Ed25519",
          publicKey: publicKey
            .export({ format: "der", type: "spki" })
            .toString("base64"),
          fingerprint: `sha256:${crypto
            .createHash("sha256")
            .update(publicKey.export({ format: "der", type: "spki" }))
            .digest("base64url")}`,
        },
        clientPack: undefined,
      },
    ]);
    valid = false;
    await assert.rejects(api.servers(), /signature is invalid/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("directory auth client keeps poll and session tokens in authorization headers", async () => {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const seen: Array<{ url: string; method: string; authorization?: string }> =
    [];
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url || "",
      method: req.method || "",
      authorization: req.headers.authorization,
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/discord/start")
      return res.end(
        JSON.stringify({
          flowId: "flow",
          pollToken: "poll",
          authorizationUrl: "https://discord.com/oauth",
          expiresAt: Date.now() + 1000,
        }),
      );
    if (req.url === "/api/auth/discord/status/flow")
      return res.end(
        JSON.stringify({
          status: "complete",
          sessionToken: "session",
          user: { username: "Player" },
        }),
      );
    if (req.url === "/api/servers/server/play-grants")
      return res.end(
        JSON.stringify({
          ticket: "direct-ticket",
          expiresAt: Date.now() + 60000,
        }),
      );
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "missing" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = new DirectoryApi({
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  });
  try {
    assert.equal((await api.authStart()).flowId, "flow");
    assert.equal(
      (await api.authStatus("flow", "poll")).sessionToken,
      "session",
    );
    assert.equal(
      (await api.playGrant("server", "session")).ticket,
      "direct-ticket",
    );
    assert.deepEqual(
      seen.map((item) => [item.method, item.url, item.authorization]),
      [
        ["POST", "/api/auth/discord/start", undefined],
        ["GET", "/api/auth/discord/status/flow", "Bearer poll"],
        ["POST", "/api/servers/server/play-grants", "Bearer session"],
      ],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
