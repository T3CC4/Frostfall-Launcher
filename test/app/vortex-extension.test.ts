import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";

const nativeRequire = createRequire(path.resolve("package.json"));

test("Vortex extension writes a receipt only after the pinned Collection and its dependencies are installed", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "skymp-vortex-extension-"),
  );
  const previousBridge = process.env.SKYMP_VORTEX_BRIDGE;
  try {
    process.env.SKYMP_VORTEX_BRIDGE = path.join(root, "bridge");
    const source = await fs.promises.readFile(
      path.resolve("vortex-extension", "index.js"),
      "utf8",
    );
    const staging = path.join(root, "staging");
    const gameSandbox = path.join(root, "game-sandbox");
    await fs.promises.mkdir(path.join(staging, "dependency"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(gameSandbox, "Data"), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(gameSandbox, "SkyrimSE.exe"), "game");
    let protocolHandler: ((url: URL) => Promise<void>) | undefined;
    const state = {
      settings: {
        gameMode: { discovered: { skyrimse: { path: gameSandbox } } },
      },
      persistent: {
        nexus: { userInfo: { name: "Example", isPremium: false } },
        mods: {
          skyrimse: {
            collection: {
              id: "collection",
              type: "collection",
              state: "installed",
              installationPath: "collection",
              attributes: {
                collectionSlug: "example",
                revisionNumber: 7,
              },
              rules: [{ reference: { id: "dependency" } }],
            },
            dependency: {
              id: "dependency",
              type: "",
              state: "installed",
              installationPath: "dependency",
              attributes: {
                name: "Required Mod",
                version: "1.2.3",
                modId: 42,
                fileId: 84,
              },
            },
            unrelated: {
              id: "unrelated",
              type: "",
              state: "installed",
              installationPath: "unrelated",
              attributes: { name: "Unrelated Mod" },
            },
          },
        },
      },
    };
    const context = {
      api: {
        getState: () => state,
        getPath: () => root,
        onStateChange: () => undefined,
        sendNotification: () => undefined,
        ext: {},
        store: {
          dispatch: (action: any) => {
            if (action.type === "SET_GAME_PATH") {
              state.settings.gameMode.discovered.skyrimse.path =
                action.payload.gamePath;
            }
          },
        },
      },
      registerProtocol: (
        _protocol: string,
        _makeDefault: boolean,
        handler: (url: URL) => Promise<void>,
      ) => {
        protocolHandler = handler;
      },
    };
    const moduleValue = { exports: {} as any };
    vm.runInNewContext(source, {
      module: moduleValue,
      exports: moduleValue.exports,
      require: (id: string) =>
        id === "vortex-api"
          ? {
              selectors: { installPathForGame: () => staging },
              util: { opn: async () => undefined },
            }
          : nativeRequire(id),
      process,
      URL,
      Map,
      Set,
      String,
      Number,
      Object,
      JSON,
      Date,
      Error,
    });
    moduleValue.exports.default(context);
    assert.ok(protocolHandler);
    const requestId = "01517468-f1e4-47ef-a0f1-df39d31f7f75";
    const nonce = "a".repeat(64);
    const requestDirectory = path.join(root, "bridge", "requests");
    await fs.promises.mkdir(requestDirectory, { recursive: true });
    await fs.promises.writeFile(
      path.join(requestDirectory, `${requestId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        requestId,
        nonce,
        action: "install",
        serverInstance: "b".repeat(64),
        collection: {
          game: "skyrimspecialedition",
          slug: "example",
          revision: 7,
        },
        mods: [
          {
            key: "nexus:42:84",
            name: "Required Mod",
            version: "1.2.3",
            nexus: { modId: 42, fileId: 84 },
          },
        ],
        gameSandbox,
        stagingDirectory: staging,
      }),
    );
    await protocolHandler!(
      new URL(`skymp://job/${requestId}?nonce=${nonce}`),
    );
    const receipt = JSON.parse(
      await fs.promises.readFile(
        path.join(root, "bridge", "receipts", `${"b".repeat(64)}.json`),
        "utf8",
      ),
    );
    assert.deepEqual(
      receipt.mods.map((mod: { name: string }) => mod.name),
      ["Required Mod"],
    );
    assert.equal(receipt.collection.revision, 7);
    assert.equal(receipt.nonce, nonce);
  } finally {
    if (previousBridge === undefined) delete process.env.SKYMP_VORTEX_BRIDGE;
    else process.env.SKYMP_VORTEX_BRIDGE = previousBridge;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
