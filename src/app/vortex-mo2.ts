import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shell } from "electron";
import type { SettingsService } from "./settings.js";
import type { ModpackStatus, PreflightReport } from "./types.js";
import { sha256File } from "./manifest.js";

interface VortexReceipt {
  serverId: string;
  collection: string;
  revision: number;
  stagingRoot: string;
  mods: Array<{ name: string; path: string }>;
}

export class VortexMo2Service {
  constructor(
    private readonly options: {
      settings: SettingsService;
      userData: string;
      runtimeSource: string;
    },
  ) {}

  root(): string {
    const server = this.options.settings.activeServer();
    if (!server) return "";
    return (
      this.options.settings.modpackPath(server.key) ||
      path.join(this.options.userData, "servers", server.key, "mo2")
    );
  }

  runtimeRoot(): string {
    return this.root();
  }

  async status(): Promise<ModpackStatus> {
    const server = this.options.settings.activeServer();
    const root = this.root();
    return {
      configured: Boolean(server && root),
      installed: Boolean(
        server && fs.existsSync(this.profileFile("modlist.txt")),
      ),
      currentVersion: server?.modpack
        ? String(server.modpack.revision)
        : undefined,
      availableVersion: server?.modpack
        ? String(server.modpack.revision)
        : undefined,
      root,
      nexus: { authenticated: false, premium: false },
    };
  }

  async login() {
    await shell.openExternal("vortex://skymp/nexus-login");
    return { authenticated: false, premium: false };
  }

  async preflight(): Promise<PreflightReport> {
    const server = this.options.settings.activeServer();
    const checks: PreflightReport["checks"] = [];
    const bundledRuntime = path.join(
      this.options.runtimeSource,
      "ModOrganizer.exe",
    );
    const installedRuntime = path.join(this.root(), "ModOrganizer.exe");
    if (!fs.existsSync(bundledRuntime)) {
      checks.push({
        id: "client-runtime",
        status: "error",
        message:
          "The signed Launcher distribution does not contain the global SkyMP/MO2 runtime. Reinstall or update the Launcher.",
      });
    } else if (!fs.existsSync(installedRuntime)) {
      checks.push({
        id: "client-runtime",
        status: "repairable",
        message:
          "The global SkyMP/MO2 runtime must be prepared for this server.",
      });
    } else {
      checks.push({
        id: "client-runtime",
        status: "ok",
        message: "Global Launcher runtime is available in this server profile.",
      });
    }
    if (!server) {
      checks.push({
        id: "server",
        status: "error",
        message: "No game server is selected.",
      });
    } else if (!server.modpack) {
      checks.push({
        id: "modpack",
        status: "ok",
        message: "This server has no Nexus Collection.",
      });
    } else {
      const receipt = await this.readReceipt(server.key);
      if (
        !receipt ||
        receipt.collection !== server.modpack.nexusCollection ||
        receipt.revision !== server.modpack.revision
      ) {
        checks.push({
          id: "modpack",
          status: "repairable",
          message: `Repair with Vortex: install ${server.modpack.nexusCollection} revision ${server.modpack.revision}.`,
        });
      } else {
        const invalid = await this.verifyHashes(server.modpack.hashes);
        checks.push(
          invalid.length
            ? {
                id: "modpack-integrity",
                status: "repairable",
                message: `Repair with Vortex: ${invalid[0]} is missing or changed.`,
              }
            : {
                id: "modpack-integrity",
                status: "ok",
                message:
                  "Nexus revision, plugins, load order and hashes are valid.",
              },
        );
      }
    }
    return {
      ready: !checks.some(
        (item) => item.status === "error" || item.status === "repairable",
      ),
      repairable: checks.some((item) => item.status === "repairable"),
      downloadBytes: 0,
      offline: false,
      checks,
    };
  }

  async install(): Promise<void> {
    const server = this.options.settings.activeServer();
    if (!server) throw new Error("Select a server first.");
    await materializeGlobalRuntime(this.options.runtimeSource, this.root());
    if (!server.modpack) return;
    const receipt = await this.readReceipt(server.key);
    if (
      !receipt ||
      receipt.collection !== server.modpack.nexusCollection ||
      receipt.revision !== server.modpack.revision
    ) {
      const target = new URL("vortex://skymp/install");
      target.searchParams.set("server", server.key);
      target.searchParams.set("collection", server.modpack.nexusCollection);
      target.searchParams.set("revision", String(server.modpack.revision));
      await shell.openExternal(target.toString());
      throw new Error(
        "Vortex was opened. Finish the Collection installation, then run Repair again.",
      );
    }
    await this.materialize(
      receipt,
      server.modpack.plugins,
      server.modpack.loadOrder,
    );
    const invalid = await this.verifyHashes(server.modpack.hashes);
    if (invalid.length)
      throw new Error(
        `Vortex staging does not match the Directory manifest: ${invalid[0]}`,
      );
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  close(): void {}

  private profileFile(name: string): string {
    return path.join(this.root(), "profiles", "Frostfall", name);
  }

  private receiptPath(serverId: string): string {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Vortex",
      "skymp",
      "receipts",
      `${serverId}.json`,
    );
  }

  private async readReceipt(serverId: string): Promise<VortexReceipt | null> {
    try {
      const value = JSON.parse(
        await fs.promises.readFile(this.receiptPath(serverId), "utf8"),
      ) as VortexReceipt;
      return value.serverId === serverId && Array.isArray(value.mods)
        ? value
        : null;
    } catch {
      return null;
    }
  }

  private async materialize(
    receipt: VortexReceipt,
    plugins: string[],
    loadOrder: string[],
  ): Promise<void> {
    const root = this.root();
    await Promise.all(
      ["mods", "profiles/Frostfall", "downloads", "overwrite"].map((item) =>
        fs.promises.mkdir(path.join(root, item), { recursive: true }),
      ),
    );
    for (const mod of receipt.mods) {
      const source = path.resolve(receipt.stagingRoot, mod.path);
      if (!source.startsWith(path.resolve(receipt.stagingRoot) + path.sep))
        throw new Error("Vortex receipt contains an unsafe staging path.");
      await linkTree(source, path.join(root, "mods", safeName(mod.name)));
    }
    await writeMo2Profile(
      root,
      receipt.mods.map((mod) => mod.name),
      plugins,
      loadOrder,
    );
  }

  private async verifyHashes(
    hashes: Record<string, string>,
  ): Promise<string[]> {
    const invalid: string[] = [];
    for (const [relative, expected] of Object.entries(hashes)) {
      const target = path.resolve(this.root(), relative);
      if (!target.startsWith(path.resolve(this.root()) + path.sep)) {
        invalid.push(relative);
        continue;
      }
      try {
        if ((await sha256File(target)).toLowerCase() !== expected.toLowerCase())
          invalid.push(relative);
      } catch {
        invalid.push(relative);
      }
    }
    return invalid;
  }
}

export async function materializeGlobalRuntime(
  source: string,
  destination: string,
): Promise<void> {
  if (!fs.existsSync(path.join(source, "ModOrganizer.exe")))
    throw new Error(
      "Global SkyMP/MO2 runtime is missing from the Launcher distribution.",
    );
  await linkTree(source, destination);
}

export function assertManagedRoot(
  root: string,
  skyrimPath: string,
  serverKey: string,
): string {
  if (!root || !path.isAbsolute(root))
    throw new Error("MO2 location must be an absolute local path.");
  if (
    process.platform === "win32" &&
    (!/^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\"))
  )
    throw new Error("MO2 location must be on a local Windows drive.");
  if (root.length > 180) throw new Error("MO2 location is too long.");
  const normalized = path.resolve(root);
  const game = path.resolve(skyrimPath);
  if (
    normalized.toLowerCase() === game.toLowerCase() ||
    normalized.toLowerCase().startsWith(`${game.toLowerCase()}${path.sep}`)
  )
    throw new Error(
      "The managed MO2 root must not be inside the Steam game folder.",
    );
  if (
    !new RegExp(`(?:^|[\\\\/])${escapeRegex(serverKey)}$`, "i").test(normalized)
  )
    throw new Error("The server folder must end with the server key.");
  return normalized;
}

export async function linkTree(
  source: string,
  destination: string,
): Promise<void> {
  const info = await fs.promises.stat(source);
  if (info.isDirectory()) {
    await fs.promises.mkdir(destination, { recursive: true });
    for (const name of await fs.promises.readdir(source))
      await linkTree(path.join(source, name), path.join(destination, name));
    return;
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.rm(destination, { force: true });
  try {
    await fs.promises.link(source, destination);
  } catch {
    await fs.promises.copyFile(source, destination);
  }
}

export async function writeMo2Profile(
  root: string,
  mods: string[],
  plugins: string[],
  loadOrder: string[],
): Promise<void> {
  const profile = path.join(root, "profiles", "Frostfall");
  await fs.promises.mkdir(profile, { recursive: true });
  await fs.promises.writeFile(
    path.join(profile, "modlist.txt"),
    `${mods.map((item) => `+${safeName(item)}`).join("\n")}\n`,
  );
  await fs.promises.writeFile(
    path.join(profile, "plugins.txt"),
    `${plugins.map((item) => `*${item}`).join("\n")}\n`,
  );
  await fs.promises.writeFile(
    path.join(profile, "loadorder.txt"),
    `${loadOrder.join("\n")}\n`,
  );
}

export function safeName(value: string): string {
  const forbidden = '<>:"/\\|?*';
  const result = [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || forbidden.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .trim();
  if (!result || result === "." || result === "..")
    throw new Error("Vortex receipt contains an invalid mod name.");
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
