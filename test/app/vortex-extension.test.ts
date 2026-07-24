import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";

const nativeRequire = createRequire(import.meta.url);

test("Vortex extension writes a receipt only after the pinned Collection and its dependencies are installed", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skymp-vortex-extension-"));
  try {
    const source = await fs.promises.readFile(
      path.resolve("vortex-extension", "index.js"),
      "utf8",
    );
    const staging = path.join(root, "staging");
    await fs.promises.mkdir(path.join(staging, "dependency"), {
      recursive: true,
    });
    let protocolHandler: ((url: URL) => Promise<void>) | undefined;
    const state = {
      persistent: {
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
              attributes: { name: "Required Mod" },
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
    await protocolHandler!(
      new URL("skymp://install?server=server-a&collection=example&revision=7"),
    );
    const receipt = JSON.parse(
      await fs.promises.readFile(
        path.join(root, "skymp", "receipts", "server-a.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      receipt.mods.map((mod: { name: string }) => mod.name),
      ["Required Mod"],
    );
    assert.equal(receipt.revision, 7);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
