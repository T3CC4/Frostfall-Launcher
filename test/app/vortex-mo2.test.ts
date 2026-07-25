import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  linkTree,
  hashTree,
  isMo2Runtime,
  materializeGlobalRuntime,
  safeName,
  VortexMo2Service,
  writeMo2Profile,
} from "../../src/app/vortex-mo2.js";

test("Vortex staging is materialized independently for each server MO2 root", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skymp-vortex-mo2-"));
  try {
    const staging = path.join(root, "staging");
    await fs.promises.mkdir(staging);
    await fs.promises.writeFile(path.join(staging, "plugin.esp"), "content");
    const first = path.join(root, "server-a");
    const second = path.join(root, "server-b");
    await linkTree(staging, path.join(first, "mods", "Example"));
    await linkTree(staging, path.join(second, "mods", "Example"));
    await writeMo2Profile(first, ["Example"], ["Skyrim.esm", "plugin.esp"], ["Skyrim.esm", "plugin.esp"]);
    await writeMo2Profile(second, ["Example"], ["Skyrim.esm"], ["Skyrim.esm"]);
    assert.equal(await fs.promises.readFile(path.join(first, "mods", "Example", "plugin.esp"), "utf8"), "content");
    assert.match(await fs.promises.readFile(path.join(first, "profiles", "Frostfall", "plugins.txt"), "utf8"), /plugin\.esp/);
    assert.doesNotMatch(await fs.promises.readFile(path.join(second, "profiles", "Frostfall", "plugins.txt"), "utf8"), /plugin\.esp/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MO2 mod names cannot escape the portable root", () => {
  assert.equal(safeName("Normal Mod"), "Normal Mod");
  assert.equal(safeName("../unsafe"), ".._unsafe");
  assert.throws(() => safeName(".."));
});

test("global signed Launcher runtime is materialized per server", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skymp-runtime-"));
  try {
    const source = path.join(root, "distribution");
    const server = path.join(root, "server-a");
    await fs.promises.mkdir(path.join(source, "Data", "SKSE", "Plugins"), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(source, "ModOrganizer.exe"), "mo2");
    await fs.promises.writeFile(path.join(source, "ModOrganizer.ini"), "personal");
    await fs.promises.mkdir(path.join(source, "profiles", "Personal"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(source, "profiles", "Personal", "modlist.txt"),
      "+Private",
    );
    await fs.promises.writeFile(
      path.join(source, "Data", "SKSE", "Plugins", "MpClientPlugin.dll"),
      "client",
    );
    await materializeGlobalRuntime(source, server);
    assert.equal(
      await fs.promises.readFile(path.join(server, "ModOrganizer.exe"), "utf8"),
      "mo2",
    );
    assert.equal(
      await fs.promises.readFile(
        path.join(server, "Data", "SKSE", "Plugins", "MpClientPlugin.dll"),
        "utf8",
      ),
      "client",
    );
    assert.equal(fs.existsSync(path.join(server, "ModOrganizer.ini")), false);
    assert.equal(fs.existsSync(path.join(server, "profiles")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MO2 detection rejects an installer renamed to ModOrganizer.exe", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skymp-mo2-detect-"));
  try {
    await fs.promises.writeFile(path.join(root, "ModOrganizer.exe"), "installer");
    assert.equal(isMo2Runtime(root), false);
    await fs.promises.writeFile(path.join(root, "uibase.dll"), "ui");
    await fs.promises.writeFile(path.join(root, "usvfs_x64.dll"), "vfs");
    await fs.promises.mkdir(path.join(root, "plugins"));
    assert.equal(isMo2Runtime(root), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("canonical mod tree hash changes when a staged file is damaged", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skymp-tree-"));
  try {
    await fs.promises.writeFile(path.join(root, "file.txt"), "correct");
    const first = await hashTree(root);
    const repeated = await hashTree(root);
    assert.equal(first.sha256, repeated.sha256);
    await fs.promises.writeFile(path.join(root, "file.txt"), "damaged");
    assert.notEqual((await hashTree(root)).sha256, first.sha256);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("failed Client Pack phase can roll back the newly staged MO2 instance", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skymp-rollback-"));
  try {
    const target = path.join(root, "instance");
    const source = path.join(root, "mo2-source");
    const staging = path.join(root, "staging");
    await fs.promises.mkdir(path.join(source, "plugins"), { recursive: true });
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.mkdir(staging, { recursive: true });
    await fs.promises.writeFile(path.join(source, "ModOrganizer.exe"), "mo2");
    await fs.promises.writeFile(path.join(source, "uibase.dll"), "ui");
    await fs.promises.writeFile(path.join(source, "usvfs_x64.dll"), "vfs");
    await fs.promises.writeFile(path.join(target, "old.txt"), "last valid");
    await fs.promises.writeFile(path.join(staging, "mod.txt"), "mod");
    const tree = await hashTree(staging);
    const server = {
      key: "server-a",
      identity: { fingerprint: "sha256:test" },
    };
    const settings = {
      activeServer: () => server,
      modpackPath: () => target,
      store: {
        get: (key: string) =>
          key === "directoryFingerprint" ? "directory" : "",
      },
    };
    const service = new VortexMo2Service({
      settings: settings as any,
      userData: root,
      runtimeSource: source,
      vortexExtension: path.join(root, "extension"),
      skyrimPath: () => path.join(root, "game"),
      getManifest: async () => {
        throw new Error("unused");
      },
    });
    const manifest = {
      schemaVersion: 1 as const,
      collection: {
        game: "skyrimspecialedition" as const,
        slug: "example",
        revision: 1,
      },
      mods: [{
        key: "nexus:1:2",
        name: "Example",
        version: "1.0",
        nexus: { modId: 1, fileId: 2 },
        installOrder: 0,
        treeSha256: tree.sha256,
        plugins: [],
      }],
      plugins: [],
      loadOrder: [],
    };
    await (service as any).materialize(
      manifest,
      {
        schemaVersion: 1,
        serverInstance: (service as any).serverInstance(),
        nonce: "a".repeat(64),
        collection: manifest.collection,
        stagingRoot: staging,
        premium: false,
        mods: [{
          key: "nexus:1:2",
          name: "Example",
          version: "1.0",
          path: staging,
        }],
      },
      source,
    );
    assert.equal(fs.existsSync(path.join(target, "old.txt")), false);
    await service.rollback();
    assert.equal(
      await fs.promises.readFile(path.join(target, "old.txt"), "utf8"),
      "last valid",
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
