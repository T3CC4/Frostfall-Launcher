import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { shell } from "electron";
import type { SettingsService } from "./settings.js";
import type {
  ModpackStatus,
  NexusStatus,
  InstallState,
  PreflightReport,
  PublicModpackManifest,
  Server,
} from "./types.js";

const execFileAsync = promisify(execFile);
const PROFILE = "Frostfall";
const VORTEX_DOWNLOAD = "https://www.nexusmods.com/about/vortex/";
const FORBIDDEN_RUNTIME_DIRECTORIES = new Set([
  "mods",
  "profiles",
  "downloads",
  "overwrite",
  "logs",
  "crashdumps",
  "webcache",
]);
const FORBIDDEN_RUNTIME_FILES = new Set(["modorganizer.ini"]);

interface VortexReceipt {
  schemaVersion: 1;
  serverInstance: string;
  nonce: string;
  collection: PublicModpackManifest["collection"];
  stagingRoot: string;
  premium: boolean;
  user?: string;
  mods: Array<{
    key: string;
    name: string;
    version: string;
    path: string;
  }>;
}

interface InstanceMarker {
  schemaVersion: 1;
  serverInstance: string;
  manifestSha256: string;
  collection: PublicModpackManifest["collection"];
  mods: Array<{
    key: string;
    name: string;
    version: string;
    treeSha256: string;
  }>;
}

interface ServiceOptions {
  settings: SettingsService;
  userData: string;
  runtimeSource: string;
  vortexExtension: string;
  skyrimPath: () => string;
  getManifest: (
    serverId: string,
    signal?: AbortSignal,
  ) => Promise<PublicModpackManifest>;
  mo2Bootstrap?: { url: string; sha256: string };
  emit?: (state: InstallState) => void;
}

export class VortexMo2Service {
  private readonly options: ServiceOptions;
  private manifestCache = new Map<string, PublicModpackManifest>();
  private helper: ChildProcess | null = null;
  private cancelled = false;
  private pendingTransaction = false;

  constructor(options: ServiceOptions) {
    this.options = options;
  }

  private server(): Server | null {
    return this.options.settings.activeServer();
  }

  private serverInstance(server = this.server()): string {
    if (!server) return "";
    const directory = this.options.settings.store.get("directoryFingerprint");
    return crypto
      .createHash("sha256")
      .update(`${directory}\0${server.key}\0${server.identity.fingerprint}`)
      .digest("hex");
  }

  root(): string {
    const server = this.server();
    if (!server) return "";
    const configured = this.options.settings.modpackPath(server.key);
    return (
      configured ||
      path.join(
        this.options.userData,
        "server-instances",
        this.serverInstance(server),
        "mo2",
      )
    );
  }

  runtimeRoot(): string {
    return this.root();
  }

  isolatedRoot(parent: string): string {
    const skyrim = this.options.skyrimPath();
    const safeParent = assertManagedRoot(parent, skyrim);
    return path.join(safeParent, this.serverInstance(), "mo2");
  }

  private markerPath(): string {
    return path.join(this.root(), ".skymp-instance.json");
  }

  private bridgeRoot(): string {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "SkyMP",
      "VortexBridge",
    );
  }

  private receiptPath(): string {
    return path.join(
      this.bridgeRoot(),
      "receipts",
      `${this.serverInstance()}.json`,
    );
  }

  private async manifest(refresh = false): Promise<PublicModpackManifest | null> {
    const server = this.server();
    if (!server?.modpack) return null;
    if (!refresh && this.manifestCache.has(server.key)) {
      return this.manifestCache.get(server.key)!;
    }
    const manifest = await this.options.getManifest(server.key);
    const digest = sha256(canonicalJson(manifest));
    if (digest !== server.modpack.manifestSha256) {
      throw new Error("Directory mod manifest does not match its signed summary.");
    }
    if (
      canonicalJson(manifest.collection) !==
      canonicalJson(server.modpack.collection)
    ) {
      throw new Error("Directory mod manifest belongs to another Collection.");
    }
    this.manifestCache.set(server.key, manifest);
    return manifest;
  }

  private async findMo2(): Promise<string | null> {
    const manual = this.options.settings.store.get("mo2Path");
    if (manual) {
      const found = await detectMo2(manual);
      if (found) return found;
    }
    return detectMo2(this.options.runtimeSource);
  }

  async status(): Promise<ModpackStatus> {
    const server = this.server();
    const [mo2, vortex] = await Promise.all([
      this.findMo2(),
      detectVortex(),
    ]);
    const marker = await readJson<InstanceMarker>(this.markerPath());
    let manifest: PublicModpackManifest | null = null;
    try {
      manifest = await this.manifest();
    } catch {
      // Preflight displays the actionable network/contract error.
    }
    const manifestSha256 = manifest ? sha256(canonicalJson(manifest)) : undefined;
    const markerMatches =
      Boolean(server && marker && manifestSha256) &&
      marker!.serverInstance === this.serverInstance(server) &&
      marker!.manifestSha256 === manifestSha256 &&
      isMo2Runtime(this.root());
    const installed =
      markerMatches && manifest
        ? await this.verifyInstance(manifest)
        : false;
    const receipt = await readJson<VortexReceipt>(this.receiptPath());
    return {
      configured: Boolean(server?.modpack),
      installed,
      currentVersion: marker?.collection
        ? `${marker.collection.slug} r${marker.collection.revision}`
        : undefined,
      availableVersion: server?.modpack
        ? `${server.modpack.collection.slug} r${server.modpack.collection.revision}`
        : undefined,
      root: this.root(),
      nexus: {
        authenticated: Boolean(receipt?.user),
        premium: Boolean(receipt?.premium),
        user: receipt?.user,
      },
      mo2: { found: Boolean(mo2), path: mo2 || undefined, managed: installed },
      vortex: { found: Boolean(vortex), path: vortex || undefined },
    };
  }

  async modEntries() {
    const manifest = await this.manifest();
    if (!manifest) return [];
    const marker = await readJson<InstanceMarker>(this.markerPath());
    const vortexStatus = await readJson<{ phase?: string }>(
      path.join(
        this.bridgeRoot(),
        "status",
        `${this.serverInstance()}.json`,
      ),
    );
    const installed = new Map((marker?.mods || []).map((mod) => [mod.key, mod]));
    return Promise.all(manifest.mods.map(async (mod) => {
      const local = installed.get(mod.key);
      let actualTree: string | null = null;
      if (local) {
        try {
          actualTree = (
            await hashTree(path.join(this.root(), "mods", safeName(mod.name)))
          ).sha256;
        } catch {
          actualTree = null;
        }
      }
      const status = !local || !actualTree
        ? ["downloading", "installing"].includes(vortexStatus?.phase || "")
          ? "downloading"
          : vortexStatus?.phase === "browser-wait"
            ? "pending"
            : "missing"
        : local.version !== mod.version
          ? "wrongVersion"
          : local.treeSha256 !== mod.treeSha256 ||
              actualTree !== mod.treeSha256
            ? "damaged"
            : "installed";
      return {
        key: mod.key,
        name: mod.name,
        version: mod.version,
        nexusId: mod.nexus.modId,
        nexusUrl: `https://www.nexusmods.com/skyrimspecialedition/mods/${mod.nexus.modId}`,
        source: "nexus",
        required: true,
        status,
      };
    }));
  }

  private async verifyInstance(manifest: PublicModpackManifest) {
    try {
      for (const mod of manifest.mods) {
        const tree = await hashTree(
          path.join(this.root(), "mods", safeName(mod.name)),
        );
        if (tree.sha256 !== mod.treeSha256) return false;
      }
      const profile = path.join(this.root(), "profiles", PROFILE);
      const [modlist, plugins, loadOrder] = await Promise.all([
        fs.promises.readFile(path.join(profile, "modlist.txt"), "utf8"),
        fs.promises.readFile(path.join(profile, "plugins.txt"), "utf8"),
        fs.promises.readFile(path.join(profile, "loadorder.txt"), "utf8"),
      ]);
      const expectedModLines = [...manifest.mods]
        .sort((left, right) => left.installOrder - right.installOrder)
        .map((mod) => `+${safeName(mod.name)}`)
      if (this.server()?.clientPack) {
        expectedModLines.push("+SkyMP Server Client Pack");
      }
      const expectedMods = `${expectedModLines.join("\n")}\n`;
      const expectedPlugins = `${manifest.loadOrder
        .map((name) => `*${name}`)
        .join("\n")}\n`;
      const expectedLoadOrder = `${manifest.loadOrder.join("\n")}\n`;
      return (
        modlist === expectedMods &&
        plugins === expectedPlugins &&
        loadOrder === expectedLoadOrder
      );
    } catch {
      return false;
    }
  }

  async preflight(): Promise<PreflightReport> {
    const checks: PreflightReport["checks"] = [];
    if (process.platform !== "win32") {
      checks.push({
        id: "platform",
        status: "error",
        message: "Managed ModCollections are currently available on Windows only.",
      });
      return {
        ready: false,
        repairable: false,
        downloadBytes: 0,
        offline: false,
        checks,
      };
    }
    const server = this.server();
    if (!server?.modpack) {
      checks.push({
        id: "modcollection",
        status: "ok",
        message: "This server does not require a ModCollection.",
      });
      return {
        ready: true,
        repairable: false,
        downloadBytes: 0,
        offline: false,
        checks,
      };
    }
    try {
      await this.manifest(true);
    } catch (error) {
      checks.push({
        id: "manifest",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const status = await this.status();
    checks.push(
      status.mo2?.found
        ? {
            id: "mo2",
            status: "ok",
            message: `Mod Organizer 2 found at ${status.mo2.path}.`,
          }
        : this.options.mo2Bootstrap
          ? {
              id: "mo2",
              status: "repairable",
              message: "Mod Organizer 2 will be installed into the managed cache.",
            }
          : {
              id: "mo2",
              status: "error",
              message:
                "A complete Mod Organizer 2 runtime was not found and no pinned bootstrap is configured.",
            },
    );
    checks.push(
      status.vortex?.found
        ? {
            id: "vortex",
            status: "ok",
            message: `Vortex found at ${status.vortex.path}.`,
          }
        : {
            id: "vortex",
            status: "repairable",
            message: "Install Vortex from Nexus Mods, then retry.",
          },
    );
    checks.push(
      status.installed
        ? {
            id: "server-mods",
            status: "ok",
            message: "The isolated server MO2 instance is ready.",
          }
        : {
            id: "server-mods",
            status: "repairable",
            message: "This server's exact Collection must be installed or repaired.",
          },
    );
    return {
      ready: !checks.some(
        (check) => check.status === "error" || check.status === "repairable",
      ),
      repairable: checks.some((check) => check.status === "repairable"),
      downloadBytes: 0,
      offline: false,
      checks,
    };
  }

  async login(): Promise<NexusStatus> {
    const vortex = await detectVortex();
    if (!vortex) {
      await shell.openExternal(VORTEX_DOWNLOAD);
      return { authenticated: false, premium: false };
    }
    await this.installExtension();
    await this.launchVortexJob(vortex, "login");
    return { authenticated: false, premium: false };
  }

  async install(): Promise<void> {
    const server = this.server();
    if (!server?.modpack) return;
    await this.recoverPendingTransaction();
    this.cancelled = false;
    this.options.emit?.({
      phase: "preflight",
      message: "Checking the signed server ModCollection.",
      canCancel: true,
    });
    const manifest = await this.manifest(true);
    if (!manifest) return;
    const mo2 = await this.ensureMo2();
    const vortex = await detectVortex();
    if (!vortex) {
      await shell.openExternal(VORTEX_DOWNLOAD);
      throw new Error(
        "Vortex is required for Nexus downloads. Its official download page has been opened.",
      );
    }
    await this.installExtension();
    let receipt = await readJson<VortexReceipt>(this.receiptPath());
    if (!receipt || !receiptMatches(receipt, manifest, this.serverInstance())) {
      await this.launchVortexJob(vortex, "install");
      receipt = await this.waitForReceipt(manifest);
    }
    if (this.cancelled) throw new Error("Installation was cancelled.");
    validateReceipt(receipt, manifest, this.serverInstance());
    await this.materialize(manifest, receipt, mo2);
    this.options.emit?.({
      phase: "verifying",
      message: "MO2 Collection ready; verifying the server Client Pack.",
    });
  }

  async commit(): Promise<void> {
    if (!this.pendingTransaction) return;
    await fs.promises.rm(`${this.root()}.rollback`, {
      recursive: true,
      force: true,
    });
    this.pendingTransaction = false;
  }

  async rollback(): Promise<void> {
    if (!this.pendingTransaction) return;
    const target = this.root();
    const previous = `${target}.rollback`;
    await fs.promises.rm(target, { recursive: true, force: true });
    if (fs.existsSync(previous)) await fs.promises.rename(previous, target);
    this.pendingTransaction = false;
  }

  private async recoverPendingTransaction() {
    const target = this.root();
    const previous = `${target}.rollback`;
    if (!fs.existsSync(previous)) return;
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.rename(previous, target);
    this.pendingTransaction = false;
  }

  private async waitForReceipt(manifest: PublicModpackManifest) {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      if (this.cancelled) throw new Error("Installation was cancelled.");
      const receipt = await readJson<VortexReceipt>(this.receiptPath());
      if (
        receipt &&
        receiptMatches(receipt, manifest, this.serverInstance())
      ) {
        return receipt;
      }
      const status = await readJson<{
        phase?: string;
        message?: string;
        error?: string;
      }>(
        path.join(
          this.bridgeRoot(),
          "status",
          `${this.serverInstance()}.json`,
        ),
      );
      if (status?.phase === "error") {
        throw new Error(status.error || "Vortex Collection installation failed.");
      }
      const phase = {
        login: "authenticating",
        "browser-wait": "manual-download",
        downloading: "downloading",
        installing: "installing-modpack",
      }[status?.phase || ""] as InstallState["phase"] | undefined;
      if (phase) {
        this.options.emit?.({
          phase,
          message:
            status?.message ||
            (phase === "manual-download"
              ? "Waiting for Nexus download confirmation."
              : "Vortex is preparing the Collection."),
          canCancel: true,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      "Vortex did not finish the Collection within 30 minutes. The operation can be resumed safely.",
    );
  }

  async cancel(): Promise<boolean> {
    if (!this.helper) return false;
    this.cancelled = true;
    this.helper.kill();
    this.helper = null;
    return true;
  }

  close() {
    this.helper?.kill();
    this.helper = null;
  }

  private async ensureMo2(): Promise<string> {
    const existing = await this.findMo2();
    if (existing) return existing;
    const bootstrap = this.options.mo2Bootstrap;
    if (!bootstrap) {
      throw new Error(
        "Mod Organizer 2 is missing and this release has no pinned MO2 bootstrap.",
      );
    }
    if (
      !/^https:\/\//i.test(bootstrap.url) ||
      !/^[a-f0-9]{64}$/i.test(bootstrap.sha256)
    ) {
      throw new Error("The pinned MO2 bootstrap configuration is invalid.");
    }
    const cache = path.join(
      this.options.userData,
      "tool-cache",
      `mo2-${bootstrap.sha256.toLowerCase()}`,
    );
    if (isMo2Runtime(cache)) return cache;
    await fs.promises.mkdir(cache, { recursive: true });
    const installer = path.join(cache, "mo2-installer.exe");
    const response = await fetch(bootstrap.url);
    if (!response.ok || !response.body) {
      throw new Error(`MO2 download failed with HTTP ${response.status}.`);
    }
    await fs.promises.writeFile(
      installer,
      Buffer.from(await response.arrayBuffer()),
    );
    if (await hashFile(installer) !== bootstrap.sha256.toLowerCase()) {
      await fs.promises.rm(installer, { force: true });
      throw new Error("Downloaded MO2 installer failed SHA-256 verification.");
    }
    const runtime = path.join(cache, "runtime");
    await fs.promises.mkdir(runtime, { recursive: true });
    await execFileAsync(installer, [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      `/DIR=${runtime}`,
    ]);
    if (!isMo2Runtime(runtime)) {
      throw new Error("MO2 bootstrap completed without a valid portable runtime.");
    }
    return runtime;
  }

  private async installExtension() {
    const source = this.options.vortexExtension;
    if (
      !fs.existsSync(path.join(source, "info.json")) ||
      !fs.existsSync(path.join(source, "index.js"))
    ) {
      throw new Error("The bundled SkyMP Vortex extension is incomplete.");
    }
    const destination = path.join(
      this.options.userData,
      "vortex-helper",
      "plugins",
      "skymp",
    );
    await fs.promises.rm(destination, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.cp(source, destination, {
      recursive: true,
      errorOnExist: false,
    });
  }

  private async launchVortexJob(
    executable: string,
    action: "login" | "install",
  ) {
    const requestId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString("hex");
    const server = this.server();
    const manifest = action === "install" ? await this.manifest() : null;
    const helperRoot = path.join(this.options.userData, "vortex-helper");
    const gameSandbox = path.join(helperRoot, "game-sandbox");
    const vortexStaging = path.join(helperRoot, "staging", "skyrimse");
    if (action === "install") {
      const skyrim = this.options.skyrimPath();
      const executable = path.join(skyrim, "SkyrimSE.exe");
      if (!fs.existsSync(executable)) {
        throw new Error("SkyrimSE.exe is required before starting Vortex.");
      }
      await fs.promises.mkdir(path.join(gameSandbox, "Data"), {
        recursive: true,
      });
      await fs.promises.mkdir(vortexStaging, { recursive: true });
      const sandboxExecutable = path.join(gameSandbox, "SkyrimSE.exe");
      if (!fs.existsSync(sandboxExecutable)) {
        try {
          await fs.promises.link(executable, sandboxExecutable);
        } catch {
          await fs.promises.copyFile(executable, sandboxExecutable);
        }
      }
    }
    const request = {
      schemaVersion: 1,
      requestId,
      nonce,
      action,
      serverInstance: this.serverInstance(),
      collection: manifest?.collection,
      mods: manifest?.mods.map((mod) => ({
        key: mod.key,
        name: mod.name,
        version: mod.version,
        nexus: mod.nexus,
      })),
      serverName: server?.name,
      ...(action === "install"
        ? { gameSandbox, stagingDirectory: vortexStaging }
        : {}),
    };
    const requests = path.join(this.bridgeRoot(), "requests");
    await fs.promises.mkdir(requests, { recursive: true });
    await writeJsonAtomic(path.join(requests, `${requestId}.json`), request);
    this.helper = spawn(
      executable,
      [
        "--user-data",
        helperRoot,
        "--start-minimized",
        "--game",
        "skyrimse",
        "-i",
        `skymp://job/${requestId}?nonce=${nonce}`,
      ],
      { detached: true, stdio: "ignore" },
    );
    this.helper.once("error", () => {
      this.helper = null;
    });
    this.helper.once("spawn", () => {
      this.helper?.unref();
    });
  }

  private async materialize(
    manifest: PublicModpackManifest,
    receipt: VortexReceipt,
    mo2Source: string,
  ) {
    const target = this.root();
    const parent = path.dirname(target);
    await fs.promises.mkdir(parent, { recursive: true });
    const next = path.join(
      parent,
      `${path.basename(target)}.next-${crypto.randomUUID()}`,
    );
    const previous = `${target}.rollback`;
    try {
      this.options.emit?.({
        phase: "staging",
        message: "Building a new isolated MO2 instance.",
        canCancel: true,
      });
      await materializeGlobalRuntime(mo2Source, next);
      const receiptMods = new Map(receipt.mods.map((mod) => [mod.key, mod]));
      for (const mod of [...manifest.mods].sort(
        (left, right) => left.installOrder - right.installOrder,
      )) {
        if (this.cancelled) throw new Error("Installation was cancelled.");
        const downloaded = receiptMods.get(mod.key)!;
        const resolved = path.resolve(downloaded.path);
        const staging = path.resolve(receipt.stagingRoot);
        if (
          resolved !== staging &&
          !resolved.startsWith(`${staging}${path.sep}`)
        ) {
          throw new Error(`Vortex returned an unsafe path for ${mod.name}.`);
        }
        const actual = await hashTree(resolved);
        if (actual.sha256 !== mod.treeSha256) {
          throw new Error(`${mod.name} has the wrong files or FOMOD result.`);
        }
        const cached = await this.importModCache(resolved, mod.treeSha256);
        await linkTree(cached, path.join(next, "mods", safeName(mod.name)));
      }
      await writeMo2Profile(
        next,
        [...manifest.mods]
          .sort((left, right) => left.installOrder - right.installOrder)
          .map((mod) => safeName(mod.name)),
        manifest.loadOrder,
        manifest.loadOrder,
        this.options.skyrimPath(),
      );
      const marker: InstanceMarker = {
        schemaVersion: 1,
        serverInstance: this.serverInstance(),
        manifestSha256: sha256(canonicalJson(manifest)),
        collection: manifest.collection,
        mods: manifest.mods.map((mod) => ({
          key: mod.key,
          name: mod.name,
          version: mod.version,
          treeSha256: mod.treeSha256,
        })),
      };
      await writeJsonAtomic(path.join(next, ".skymp-instance.json"), marker);
      if (!isMo2Runtime(next)) {
        throw new Error("Generated MO2 instance is incomplete.");
      }
      if (fs.existsSync(target)) await fs.promises.rename(target, previous);
      this.options.emit?.({
        phase: "committing",
        message: "Activating the verified server instance.",
      });
      await fs.promises.rename(next, target);
      this.pendingTransaction = true;
    } catch (error) {
      await fs.promises.rm(next, { recursive: true, force: true });
      if (!fs.existsSync(target) && fs.existsSync(previous)) {
        await fs.promises.rename(previous, target);
      }
      throw error;
    }
  }

  private async importModCache(source: string, treeSha256: string) {
    const cacheRoot = path.join(this.options.userData, "mod-cache");
    const target = path.join(cacheRoot, treeSha256);
    if (fs.existsSync(target)) {
      try {
        if ((await hashTree(target)).sha256 === treeSha256) return target;
      } catch {
        // Rebuild only this Launcher-owned cache entry below.
      }
      await fs.promises.rm(target, { recursive: true, force: true });
    }
    const temporary = path.join(
      cacheRoot,
      `${treeSha256}.next-${crypto.randomUUID()}`,
    );
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    try {
      await fs.promises.cp(source, temporary, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      });
      if ((await hashTree(temporary)).sha256 !== treeSha256) {
        throw new Error("Mod cache verification failed after import.");
      }
      await makeTreeReadOnly(temporary);
      await fs.promises.rename(temporary, target);
      return target;
    } catch (error) {
      await fs.promises.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function detectMo2(preferred?: string): Promise<string | null> {
  const candidates = new Set<string>();
  if (preferred) candidates.add(path.resolve(preferred));
  for (const root of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
  ]) {
    if (!root) continue;
    candidates.add(path.join(root, "Mod Organizer 2"));
    candidates.add(path.join(root, "ModOrganizer"));
  }
  if (process.platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      try {
        const { stdout } = await execFileAsync("reg.exe", [
          "query",
          `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
          "/s",
          "/v",
          "InstallLocation",
        ]);
        for (const line of stdout.split(/\r?\n/)) {
          const match = line.match(/InstallLocation\s+REG_\w+\s+(.+)$/i);
          if (match?.[1]) candidates.add(match[1].trim());
        }
      } catch {
        // Registry discovery is best effort.
      }
    }
  }
  for (const candidate of candidates) {
    if (
      isMo2Runtime(candidate) &&
      (process.platform !== "win32" || (await hasSupportedMo2Version(candidate)))
    ) {
      return candidate;
    }
  }
  return null;
}

async function hasSupportedMo2Version(root: string) {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Item -LiteralPath $env:SKYMP_MO2_EXE).VersionInfo.ProductVersion",
      ],
      {
        env: {
          ...process.env,
          SKYMP_MO2_EXE: path.join(root, "ModOrganizer.exe"),
        },
      },
    );
    const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 2 || (major === 2 && minor >= 5);
  } catch {
    return false;
  }
}

export function isMo2Runtime(root: string): boolean {
  if (!root) return false;
  return [
    "ModOrganizer.exe",
    "uibase.dll",
    "usvfs_x64.dll",
    "plugins",
  ].every((item) => fs.existsSync(path.join(root, item)));
}

export async function detectVortex(): Promise<string | null> {
  const candidates = new Set([
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", "Vortex", "Vortex.exe"),
    process.env.ProgramFiles &&
      path.join(
        process.env.ProgramFiles,
        "Black Tree Gaming Ltd",
        "Vortex",
        "Vortex.exe",
      ),
    process.env["ProgramFiles(x86)"] &&
      path.join(
        process.env["ProgramFiles(x86)"]!,
        "Black Tree Gaming Ltd",
        "Vortex",
        "Vortex.exe",
      ),
  ].filter((value): value is string => Boolean(value)));
  if (process.platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      try {
        const { stdout } = await execFileAsync("reg.exe", [
          "query",
          `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
          "/s",
        ]);
        const blocks = stdout.split(/\r?\n\r?\n/);
        for (const block of blocks) {
          if (!/Vortex/i.test(block)) continue;
          const location = block.match(
            /InstallLocation\s+REG_\w+\s+(.+)$/im,
          )?.[1];
          const icon = block.match(/DisplayIcon\s+REG_\w+\s+(.+)$/im)?.[1];
          if (location) candidates.add(path.join(location.trim(), "Vortex.exe"));
          if (icon) {
            candidates.add(
              icon.trim().replace(/^"|"$/g, "").replace(/,\d+$/, ""),
            );
          }
        }
      } catch {
        // Registry discovery is best effort.
      }
    }
  }
  return [...candidates].find((candidate) => fs.existsSync(candidate)) || null;
}

export async function materializeGlobalRuntime(
  source: string,
  destination: string,
) {
  if (!fs.existsSync(source)) throw new Error(`MO2 runtime is missing: ${source}`);
  await fs.promises.mkdir(destination, { recursive: true });
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    const lower = entry.name.toLowerCase();
    if (
      FORBIDDEN_RUNTIME_DIRECTORIES.has(lower) ||
      FORBIDDEN_RUNTIME_FILES.has(lower) ||
      lower.endsWith(".log")
    ) {
      continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await fs.promises.cp(from, to, {
        recursive: true,
        dereference: false,
        errorOnExist: false,
      });
    } else if (entry.isFile()) {
      await fs.promises.copyFile(from, to);
    }
  }
}

export async function linkTree(source: string, destination: string) {
  await fs.promises.mkdir(destination, { recursive: true });
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in Vortex staging: ${entry.name}`);
    }
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await linkTree(from, to);
    } else if (entry.isFile()) {
      try {
        await fs.promises.link(from, to);
      } catch (error: any) {
        if (!["EXDEV", "EPERM", "EACCES"].includes(error?.code)) throw error;
        await fs.promises.copyFile(from, to);
      }
    }
  }
}

export async function writeMo2Profile(
  root: string,
  mods: string[],
  plugins: string[],
  loadOrder: string[],
  gamePath = "",
) {
  const profile = path.join(root, "profiles", PROFILE);
  await fs.promises.mkdir(profile, { recursive: true });
  await fs.promises.mkdir(path.join(root, "overwrite"), { recursive: true });
  await fs.promises.mkdir(path.join(root, "downloads"), { recursive: true });
  await fs.promises.writeFile(
    path.join(profile, "modlist.txt"),
    `${mods.map((name) => `+${name}`).join("\n")}\n`,
  );
  await fs.promises.writeFile(
    path.join(profile, "plugins.txt"),
    `${plugins.map((name) => `*${name}`).join("\n")}\n`,
  );
  await fs.promises.writeFile(
    path.join(profile, "loadorder.txt"),
    `${loadOrder.join("\n")}\n`,
  );
  const normalizedGame = gamePath.replaceAll("\\", "/");
  await fs.promises.writeFile(
    path.join(root, "ModOrganizer.ini"),
    [
      "[General]",
      "selected_profile=Frostfall",
      "gameName=Skyrim Special Edition",
      `gamePath=${normalizedGame}`,
      `base_directory=${root.replaceAll("\\", "/")}`,
      "",
      "[customExecutables]",
      "1\\title=SKSE",
      `1\\binary=${path.join(gamePath, "skse64_loader.exe").replaceAll("\\", "/")}`,
      `1\\workingDirectory=${normalizedGame}`,
      "size=1",
      "",
    ].join("\n"),
  );
}

export function safeName(value: string): string {
  const withoutControlCharacters = [...value]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("");
  const safe = withoutControlCharacters.replace(/[<>:"/\\|?*]/g, "_").trim();
  if (!safe || safe === "." || safe === "..") {
    throw new Error("Unsafe or empty MO2 mod name.");
  }
  return safe;
}

export function assertManagedRoot(
  candidate: string,
  skyrimRoot: string,
  _serverKey?: string,
) {
  const resolved = path.resolve(candidate);
  const game = path.resolve(skyrimRoot);
  if (
    resolved === game ||
    resolved.startsWith(`${game}${path.sep}`) ||
    game.startsWith(`${resolved}${path.sep}`)
  ) {
    throw new Error("The managed MO2 instance must be outside Skyrim.");
  }
  return resolved;
}

export async function hashTree(root: string) {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  async function walk(directory: string) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic link is not allowed: ${absolute}`);
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const info = await fs.promises.stat(absolute);
        files.push({
          path: path.relative(root, absolute).replaceAll("\\", "/"),
          size: info.size,
          sha256: await hashFile(absolute),
        });
      }
    }
  }
  await walk(root);
  return {
    sha256: sha256(
      files
        .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
        .join(""),
    ),
    files,
  };
}

async function makeTreeReadOnly(root: string) {
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(absolute);
    else if (entry.isFile()) await fs.promises.chmod(absolute, 0o444);
  }
}

function validateReceipt(
  receipt: VortexReceipt,
  manifest: PublicModpackManifest,
  serverInstance: string,
) {
  if (!receiptMatches(receipt, manifest, serverInstance)) {
    throw new Error("Vortex receipt does not match the selected server.");
  }
  const expected = new Map(manifest.mods.map((mod) => [mod.key, mod]));
  const seen = new Set<string>();
  for (const mod of receipt.mods) {
    const wanted = expected.get(mod.key);
    if (!wanted || seen.has(mod.key)) {
      throw new Error(`Vortex receipt contains unexpected mod ${mod.key}.`);
    }
    seen.add(mod.key);
    if (mod.name !== wanted.name || mod.version !== wanted.version) {
      throw new Error(`Vortex installed the wrong version of ${wanted.name}.`);
    }
  }
  if (seen.size !== expected.size) {
    throw new Error("Vortex has not installed every required Collection mod.");
  }
}

function receiptMatches(
  receipt: VortexReceipt,
  manifest: PublicModpackManifest,
  serverInstance: string,
) {
  return (
    receipt.schemaVersion === 1 &&
    receipt.serverInstance === serverInstance &&
    canonicalJson(receipt.collection) === canonicalJson(manifest.collection)
  );
}

async function hashFile(file: string) {
  return sha256(await fs.promises.readFile(file));
}

function sha256(value: crypto.BinaryLike) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  const sort = (item: any): any => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, `${canonicalJson(value)}\n`, {
    mode: 0o600,
  });
  await fs.promises.rename(temporary, file);
}
