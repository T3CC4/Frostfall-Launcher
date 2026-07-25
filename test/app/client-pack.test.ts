import AdmZip from "adm-zip";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientPackService } from "../../src/app/client-pack.js";
import { canonicalize, manifestPayload } from "../../src/app/manifest.js";
import type { ClientManifest, Server } from "../../src/app/types.js";

test("server Client Pack resumes, verifies, installs last and is isolated per MO2 root", async () => {
  const fixture = await packFixture({ interruptFirstArchive: true });
  try {
    const userData = path.join(fixture.root, "user-data");
    const first = path.join(userData, "servers", fixture.server.key, "mo2");
    const second = path.join(userData, "servers", "other-server", "mo2");
    await fs.promises.mkdir(path.join(first, "profiles", "Frostfall"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(first, "profiles", "Frostfall", "modlist.txt"),
      "+Core\n",
    );
    const service = new ClientPackService({
      userData,
      maxArchiveBytes: 64 * 1024 * 1024,
    });

    const before = await service.preflight(fixture.server, first);
    assert.equal(before.status, "repairable");
    await assert.rejects(() => service.install(fixture.server, first));
    await service.install(fixture.server, first);
    assert.equal(fixture.sawRange, true);
    assert.equal(
      await fs.promises.readFile(
        path.join(
          first,
          "mods",
          "SkyMP Server Client Pack",
          "Platform",
          "Plugins",
          "skymp-server-extension.js",
        ),
        "utf8",
      ),
      fixture.extension.toString(),
    );
    const modlist = await fs.promises.readFile(
      path.join(first, "profiles", "Frostfall", "modlist.txt"),
      "utf8",
    );
    assert.equal(
      modlist.trim().split(/\r?\n/).at(-1),
      "+SkyMP Server Client Pack",
    );
    assert.equal(
      fs.existsSync(path.join(second, "mods", "SkyMP Server Client Pack")),
      false,
    );
    assert.equal((await service.preflight(fixture.server, first)).status, "ok");
    assert.deepEqual(await service.runtimeAttestation(fixture.server, first), {
      version: fixture.manifest.version,
      manifestSha256: fixture.server.clientPack!.manifestSha256,
    });

    await fs.promises.writeFile(
      path.join(
        first,
        "mods",
        "SkyMP Server Client Pack",
        "Platform",
        "Plugins",
        "skymp-server-extension.js",
      ),
      "tampered",
    );
    assert.equal(
      (await service.preflight(fixture.server, first)).status,
      "repairable",
    );
    await service.install(fixture.server, first);

    const coreOnly = { ...fixture.server, clientPack: undefined };
    await service.install(coreOnly, first);
    assert.equal(
      fs.existsSync(path.join(first, "mods", "SkyMP Server Client Pack")),
      false,
    );
    assert.doesNotMatch(
      await fs.promises.readFile(
        path.join(first, "profiles", "Frostfall", "modlist.txt"),
        "utf8",
      ),
      /SkyMP Server Client Pack/u,
    );
  } finally {
    await fixture.close();
  }
});

test("manifest redirects, wrong identities and Directory hash rollback attempts are rejected", async () => {
  const fixture = await packFixture({});
  try {
    const service = new ClientPackService({
      userData: path.join(fixture.root, "user-data"),
      maxArchiveBytes: 64 * 1024 * 1024,
    });
    fixture.redirectManifest = true;
    assert.equal(
      (await service.preflight(fixture.server, path.join(fixture.root, "mo2")))
        .status,
      "error",
    );
    fixture.redirectManifest = false;

    const other = crypto.generateKeyPairSync("ed25519").publicKey;
    const otherDer = other.export({ format: "der", type: "spki" });
    const wrongIdentity: Server = {
      ...fixture.server,
      identity: {
        algorithm: "Ed25519",
        publicKey: otherDer.toString("base64"),
        fingerprint: `sha256:${crypto.createHash("sha256").update(otherDer).digest("base64url")}`,
      },
    };
    assert.equal(
      (await service.preflight(wrongIdentity, path.join(fixture.root, "mo2")))
        .status,
      "error",
    );

    const rollbackBinding: Server = {
      ...fixture.server,
      clientPack: {
        ...fixture.server.clientPack!,
        manifestSha256: "f".repeat(64),
      },
    };
    assert.equal(
      (await service.preflight(rollbackBinding, path.join(fixture.root, "mo2")))
        .status,
      "error",
    );
  } finally {
    await fixture.close();
  }
});

async function packFixture(options: { interruptFirstArchive?: boolean }) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "frostfall-client-pack-"),
  );
  const extension = Buffer.from(
    "globalThis.__skympServerExtensionQueue ??= [];",
  );
  const zip = new AdmZip();
  zip.addFile(
    "client-pack.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        clientApiVersion: 1,
        entrypoint: "Platform/Plugins/skymp-server-extension.js",
      }),
    ),
  );
  zip.addFile("Platform/Plugins/skymp-server-extension.js", extension);
  const archive = zip.toBuffer();
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const manifest: ClientManifest = {
    schemaVersion: 1,
    serverId: "server-a",
    version: "1.2.3",
    clientApiVersion: 1,
    permission: "full-skyrim-platform",
    entrypoint: "Platform/Plugins/skymp-server-extension.js",
    archive: {
      format: "zip",
      size: archive.length,
      sha256: sha256(archive),
    },
    files: [
      {
        path: "Platform/Plugins/skymp-server-extension.js",
        size: extension.length,
        sha256: sha256(extension),
      },
    ],
    signature: { algorithm: "Ed25519", value: "" },
  };
  manifest.signature.value = crypto
    .sign(
      null,
      Buffer.from(canonicalize(manifestPayload(manifest))),
      keys.privateKey,
    )
    .toString("base64url");
  const manifestRaw = Buffer.from(canonicalize(manifest));
  let interrupt = Boolean(options.interruptFirstArchive);
  const state = { sawRange: false, redirectManifest: false };
  const server = http.createServer((request, response) => {
    if (request.url === "/api/client-pack/manifest") {
      if (state.redirectManifest) {
        response.writeHead(302, { location: "/elsewhere" });
        return response.end();
      }
      response.writeHead(200, { "content-length": manifestRaw.length });
      return response.end(manifestRaw);
    }
    if (request.url === "/api/client-pack/archive") {
      const range = request.headers.range;
      const offset = range ? Number(/^bytes=(\d+)-$/u.exec(range)?.[1]) : 0;
      state.sawRange ||= Boolean(range);
      const content = archive.subarray(offset);
      response.writeHead(offset ? 206 : 200, {
        "content-length": content.length,
        ...(offset
          ? {
              "content-range": `bytes ${offset}-${archive.length - 1}/${archive.length}`,
            }
          : {}),
        etag: `"${manifest.archive.sha256}"`,
      });
      if (interrupt && !offset) {
        interrupt = false;
        response.flushHeaders();
        response.write(
          content.subarray(0, Math.max(1, Math.floor(content.length / 2))),
        );
        setTimeout(() => response.destroy(), 20);
        return;
      }
      return response.end(content);
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const directoryServer: Server = {
    key: "server-a",
    contract: "directory-managed",
    name: "Server A",
    address: "127.0.0.1",
    port: 7777,
    resourcesPort: 7778,
    description: "",
    region: "test",
    tags: [],
    versions: {},
    visibility: "public",
    status: { state: "online", online: 0, maxPlayers: 10 },
    lastHeartbeatAt: Date.now(),
    source: "directory",
    stale: false,
    listed: true,
    identity: {
      algorithm: "Ed25519",
      publicKey: publicDer.toString("base64"),
      fingerprint: `sha256:${crypto.createHash("sha256").update(publicDer).digest("base64url")}`,
    },
    clientPack: {
      port,
      version: manifest.version,
      clientApiVersion: 1,
      manifestSha256: sha256(manifestRaw),
    },
  };
  return {
    root,
    extension,
    manifest,
    server: directoryServer,
    get sawRange() {
      return state.sawRange;
    },
    set redirectManifest(value: boolean) {
      state.redirectManifest = value;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
