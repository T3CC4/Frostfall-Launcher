import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  linkTree,
  materializeGlobalRuntime,
  safeName,
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
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
