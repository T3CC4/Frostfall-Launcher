import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { config } from "./config.js";
import {
  DirectoryApi,
  DirectoryError,
  joinTargetFromUrl,
} from "./directory.js";
import { SettingsService } from "./settings.js";
import {
  assertManagedRoot,
  isMo2Runtime,
  VortexMo2Service,
} from "./vortex-mo2.js";
import { detectSkyrim, validateSkyrim } from "./discovery.js";
import { exportDiagnostics } from "./diagnostics.js";
import { initializeLogger } from "./logger.js";
import {
  externalUrlSchema,
  serverKeySchema,
  settingsPatchSchema,
} from "./schemas.js";
import { LauncherUpdater } from "./updater.js";
import type { PreflightReport } from "./types.js";
import { ClientPackService } from "./client-pack.js";

if (!app.isPackaged) dotenv.config();
app.setName(config.app.productName);
app.setAsDefaultProtocolClient("skymp");
if (process.env.E2E_USER_DATA)
  app.setPath("userData", process.env.E2E_USER_DATA);
if (process.env.E2E === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("no-sandbox");
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let settings: SettingsService;
let modpack: VortexMo2Service;
let clientPacks: ClientPackService;
let latestPreflight: PreflightReport | null = null;
let dashboardController: AbortController | null = null;
type JoinTarget = NonNullable<ReturnType<typeof joinTargetFromUrl>>;
let pendingJoinTarget =
  process.argv.map(joinTargetFromUrl).find((value) => value !== null) || null;
const log = initializeLogger();
let directory = new DirectoryApi(config.directory);
async function applyJoinCode(code: string) {
  if (!settings) return;
  try {
    const joined = await directory.resolveJoin(code);
    settings.addPrivateServer(joined, code);
    win?.reload();
  } catch (error) {
    log.warn("Private server join failed", error);
  }
}
async function configureDirectory(
  rawUrl: string,
  expectedFingerprint?: string,
): Promise<boolean> {
  const url = String(rawUrl || "").trim() || config.directory.url;
  const key = await DirectoryApi.signingKey(url);
  if (
    expectedFingerprint &&
    key.fingerprint.toLowerCase() !== expectedFingerprint.toLowerCase()
  ) {
    throw new Error(
      `Directory signing-key fingerprint mismatch. Expected ${expectedFingerprint}, received ${key.fingerprint}.`,
    );
  }
  const normalized = new URL(url).origin;
  const currentUrl = settings.store.get("directoryUrl");
  const currentFingerprint = settings.store.get("directoryFingerprint");
  if (
    currentUrl === normalized &&
    currentFingerprint.toLowerCase() === key.fingerprint.toLowerCase()
  ) {
    directory = new DirectoryApi({ url: normalized, publicKey: key.publicKey });
    return true;
  }
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Cancel", "Trust Directory"],
    defaultId: 0,
    cancelId: 0,
    title: "Trust Directory signing key?",
    message: normalized,
    detail: `SHA-256 fingerprint:\n${key.fingerprint}\n\nSessions, private join codes and cache are isolated when the Directory changes.`,
  };
  const answer = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  if (answer.response !== 1) return false;
  if (currentUrl !== normalized || currentFingerprint !== key.fingerprint) {
    settings.clearDirectorySession();
    settings.store.set("encryptedServerSessions", {});
    settings.store.set("serverProfileIds", {});
    settings.store.set("encryptedPrivateJoinCodes", {});
    settings.store.set("cachedServers", []);
    settings.store.set("discordUser", null);
  }
  settings.store.set("directoryUrl", normalized);
  settings.store.set("directoryFingerprint", key.fingerprint);
  settings.store.set("directoryPublicKey", key.publicKey);
  directory = new DirectoryApi({ url: normalized, publicKey: key.publicKey });
  return true;
}
async function applyJoinTarget(target: JoinTarget) {
  try {
    if (target.directory) {
      if (!(await configureDirectory(target.directory, target.fingerprint)))
        return;
    } else if (
      target.fingerprint &&
      settings.store.get("directoryFingerprint").toLowerCase() !==
        target.fingerprint.toLowerCase()
    ) {
      throw new Error(
        "Join-link fingerprint does not match the active Directory.",
      );
    }
    await applyJoinCode(target.code);
  } catch (error) {
    log.warn("Join link rejected", error);
    if (win)
      await dialog.showMessageBox(win, {
        type: "error",
        title: "Join link rejected",
        message: error instanceof Error ? error.message : String(error),
      });
  }
}
function receiveDeepLink(value: string) {
  const target = joinTargetFromUrl(value);
  if (!target) return;
  pendingJoinTarget = target;
  if (settings) void applyJoinTarget(target);
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveDeepLink(url);
});
const updater = new LauncherUpdater({
  app,
  config,
  emit: (state) => send("updates:state", state),
  log,
});

function send(channel: string, value: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (
    !win ||
    event.sender.id !== win.webContents.id ||
    (event.senderFrame?.url && !event.senderFrame.url.startsWith("file:"))
  )
    throw new Error("Untrusted IPC sender");
}
function handle(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any,
) {
  ipcMain.handle(channel, (event, ...args) => {
    trusted(event);
    return handler(event, ...args);
  });
}

function createWindow() {
  win = new BrowserWindow({
    title: config.app.productName,
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: "#080503",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const rendererUrl = pathToFileURL(
    path.join(__dirname, "renderer", "index.html"),
  ).href;
  win.webContents.once("did-finish-load", () => {
    win?.webContents.on("will-navigate", (event, url) => {
      if (url !== rendererUrl) event.preventDefault();
    });
  });
  win.loadURL(rendererUrl);
  win.once("ready-to-show", () => win?.show());
  win.on("close", (event) => {
    if (!quitting && settings?.store.get("closeBehavior") === "tray") {
      event.preventDefault();
      win?.hide();
    }
  });
  if (process.argv.includes("--dev"))
    win.webContents.openDevTools({ mode: "detach" });
}

function ensureTray() {
  if (tray || process.platform !== "win32") return;
  tray = new Tray(
    nativeImage.createFromPath(
      path.join(app.getAppPath(), config.branding.icons.windows),
    ),
  );
  tray.setToolTip(config.app.productName);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open launcher",
        click: () => {
          win?.show();
          win?.focus();
        },
      },
      { label: "Check for updates", click: () => void updater.check() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => {
    win?.show();
    win?.focus();
  });
}

function authFile(): string {
  return path.join(
    modpack?.runtimeRoot() || "",
    "Data",
    "Platform",
    "PluginsNoLoad",
    "auth-data-no-load.js",
  );
}
function removeAuthFile() {
  try {
    fs.rmSync(authFile(), { force: true });
  } catch {
    /* best effort */
  }
}

async function writeClientSettings() {
  const root = modpack.runtimeRoot();
  const server = settings.activeServer();
  if (!root || !server) throw new Error("Skyrim path or server is missing.");
  const destination = path.join(
    root,
    "Data",
    "Platform",
    "Plugins",
    "skymp5-client-settings.txt",
  );
  const value: any = {
    launchMode: "directory-managed",
    "server-ip": server.address,
    "server-port": Number(server.port),
  };
  const clientPack = await clientPacks.runtimeAttestation(server, root);
  if (clientPack) {
    value["client-pack-version"] = clientPack.version;
    value["client-pack-manifest-sha256"] = clientPack.manifestSha256;
  }
  const profileId = settings.serverProfileId(server.key);
  const session = settings.getServerSession(server.key);
  if (!session)
    throw new Error("Launcher-managed server session is unavailable.");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
  const target = authFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `//${JSON.stringify({
      session,
      ...(profileId == null ? {} : { profileId }),
    })}`,
    {
      mode: 0o600,
    },
  );
}

async function preflight(): Promise<PreflightReport> {
  const server = settings.activeServer();
  const skyrimRoot = settings.store.get("skyrimPath");
  const checks: PreflightReport["checks"] = [];
  checks.push(
    skyrimRoot && fs.existsSync(path.join(skyrimRoot, "SkyrimSE.exe"))
      ? { id: "skyrim", status: "ok", message: "Skyrim installation found." }
      : {
          id: "skyrim",
          status: "error",
          message: "Skyrim Special Edition was not found.",
        },
  );
  checks.push(
    server
      ? {
          id: "server",
          status: "ok",
          message: `Server ${server.name} selected.`,
        }
      : {
          id: "server",
          status: "error",
          message: "No game server is selected.",
        },
  );
  checks.push(
    settings.getDirectorySession()
      ? { id: "auth", status: "ok", message: "Directory login is ready." }
      : { id: "auth", status: "error", message: "Discord login is required." },
  );
  const report: PreflightReport = {
    ready: false,
    repairable: false,
    downloadBytes: 0,
    offline: false,
    checks,
  };
  const modpackReport = await modpack.preflight();
  report.checks.unshift(...modpackReport.checks);
  report.downloadBytes = Math.max(
    report.downloadBytes,
    modpackReport.downloadBytes,
  );
  report.offline ||= modpackReport.offline;
  report.repairable ||= modpackReport.repairable;
  if (server && modpack.root()) {
    const packReport = await clientPacks.preflight(server, modpack.root());
    report.checks.push({
      id: "client-pack",
      status: packReport.status,
      message: packReport.message,
    });
    report.downloadBytes += packReport.downloadBytes;
    report.offline ||= packReport.offline;
    report.repairable ||= packReport.status === "repairable";
  }
  report.ready = !report.checks.some(
    (check) => check.status === "error" || check.status === "repairable",
  );
  return report;
}

async function authorizeForPlay() {
  const server = settings.activeServer();
  if (!server) throw new Error("Select a server first.");
  if (!server.listed)
    throw new Error("This server is no longer listed and cannot be started.");
  const directorySession = settings.getDirectorySession();
  if (!directorySession) throw new Error("Discord login is required.");
  const grant = await directory.playGrant(server.key, directorySession);
  if (typeof grant?.ticket !== "string" || !grant.ticket)
    throw new Error("Directory returned an invalid play ticket.");
  settings.setServerSession(server.key, grant.ticket);
  return { access: { allowed: true }, server };
}

async function launchGame() {
  const root = modpack.root();
  const server = settings.activeServer();
  if (!root || !server) throw new Error("Skyrim path and server are required.");
  await writeClientSettings();
  const exe = path.join(root, "ModOrganizer.exe");
  if (!fs.existsSync(exe))
    throw new Error("Managed ModOrganizer.exe is missing.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, ["-p", "Frostfall", "run", "-e", "SKSE"], {
      detached: true,
      stdio: "ignore",
      cwd: root,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  const behavior = settings.store.get("afterLaunch");
  if (behavior === "minimize") win?.minimize();
  if (behavior === "close") win?.close();
}

async function confirmClientPackTrust(
  server: NonNullable<ReturnType<SettingsService["activeServer"]>>,
): Promise<boolean> {
  if (!server.clientPack) return true;
  const answer = await dialog.showMessageBox(win!, {
    type: "warning",
    buttons: ["Cancel", "Trust and Continue"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Full-trust server Client Pack",
    message: `${server.name} — Client Pack ${server.clientPack.version}`,
    detail: [
      `Server identity fingerprint:\n${server.identity.fingerprint}`,
      "",
      "This pack runs JavaScript with full Skyrim Platform and Node.js rights.",
      "It can read and write files accessible to the game, access the network,",
      "inspect your game state and execute native Skyrim Platform APIs.",
      "",
      "Only continue if you trust this server operator.",
    ].join("\n"),
  });
  return answer.response === 1;
}

async function loadSettings() {
  try {
    const servers = await directory.servers();
    settings.applyDirectoryCatalog(servers);
    const sessionToken = settings.getDirectorySession();
    if (sessionToken) {
      try {
        const session = await directory.session(sessionToken);
        settings.store.set("discordUser", {
          username: session.user.username,
          tag: session.user.username,
          avatar: session.user.avatar || null,
        });
      } catch {
        settings.clearDirectorySession();
        settings.store.set("discordUser", null);
      }
    }
    await Promise.all(
      settings.privateJoinEntries().map(async ({ code }) => {
        try {
          settings.addPrivateServer(
            await directory.resolveJoin(code),
            code,
            false,
          );
        } catch (error) {
          log.warn("Private server revalidation failed", error);
        }
      }),
    );
  } catch (error) {
    log.warn("Using cached server list", error);
    settings.markDirectoryUnavailable((error as Error).message);
  }
  return settings.publicSettings();
}

function registerIpc() {
  ipcMain.on("window:minimize", (event) => {
    trusted(event);
    win?.minimize();
  });
  ipcMain.on("window:maximize", (event) => {
    trusted(event);
    if (win?.isMaximized()) win.unmaximize();
    else win?.maximize();
  });
  ipcMain.on("window:close", (event) => {
    trusted(event);
    win?.close();
  });
  handle("app:getConfig", () => config.public);
  handle("settings:load", loadSettings);
  handle("directory:configure", async (_event, rawUrl) => {
    await configureDirectory(String(rawUrl || ""));
    return await loadSettings();
  });
  handle("settings:save", async (_event, input) => {
    const patch = settingsPatchSchema.parse(input);
    if (
      patch.skyrimPath !== undefined &&
      patch.skyrimPath &&
      !validateSkyrim(patch.skyrimPath)
    )
      throw new Error(
        "Selected folder is not a valid Skyrim Special Edition installation.",
      );
    const allowed = [
      "skyrimPath",
      "activeServerKey",
      "locale",
      "onboardingVersion",
      "launchAtLogin",
      "closeBehavior",
      "afterLaunch",
      "reduceMotion",
    ] as const;
    for (const key of allowed)
      if (patch[key] !== undefined)
        settings.store.set(key as any, patch[key] as any);
    if (patch.launchAtLogin !== undefined)
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    if (patch.closeBehavior === "tray") ensureTray();
    return settings.publicSettings();
  });
  handle("server:select", async (_event, value) => {
    const key = serverKeySchema.parse(value);
    if (
      !settings.store.get("cachedServers").some((server) => server.key === key)
    )
      throw new Error("Unknown server.");
    dashboardController?.abort();
    settings.selectServer(key);
    return settings.publicSettings();
  });
  handle("server:toggleFavorite", async (_event, value) => {
    const key = serverKeySchema.parse(value);
    if (
      !settings.store.get("cachedServers").some((server) => server.key === key)
    )
      throw new Error("Unknown server.");
    settings.toggleFavorite(key);
    return settings.publicSettings();
  });
  handle("server:browser", () => {
    dashboardController?.abort();
    settings.showServerBrowser();
    return settings.publicSettings();
  });
  handle("dialog:openFolder", async (_event, kind) => {
    const result = await dialog.showOpenDialog(win!, {
      title:
        kind === "modpack"
          ? "Select the server modpack folder"
          : "Select Skyrim installation",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  handle("skyrim:detect", async () => {
    const found = await detectSkyrim();
    return { found: Boolean(found), path: found };
  });
  handle("modpack:status", () => modpack.status());
  handle("modpack:nexusLogin", () => modpack.login());
  handle("modpack:selectMo2", async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: "Select the Mod Organizer 2 installation folder",
      properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths[0]) {
      if (!isMo2Runtime(result.filePaths[0])) {
        throw new Error(
          "The selected folder is not a complete MO2 runtime. Installer executables are not accepted.",
        );
      }
      settings.store.set("mo2Path", result.filePaths[0]);
    }
    return modpack.status();
  });
  handle("modpack:selectLocation", async () => {
    const server = settings.activeServer();
    const skyrim = settings.store.get("skyrimPath");
    if (!server || !skyrim)
      throw new Error("Select Skyrim and a server first.");
    const result = await dialog.showOpenDialog(win!, {
      title: "Select the managed server modpack folder",
      defaultPath: modpack.root(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result.canceled && result.filePaths[0])
      settings.setModpackPath(
        server.key,
        modpack.isolatedRoot(
          assertManagedRoot(result.filePaths[0], skyrim, server.key),
        ),
      );
    return settings.publicSettings();
  });
  handle("dashboard:load", async () => {
    dashboardController?.abort();
    dashboardController = new AbortController();
    const server = settings.activeServer();
    if (!server) return { error: "No server selected." };
    const capabilities = {
      authentication: "directory-discord",
      news: false,
      mods: false,
      metrics: false,
      clientDistribution: false,
      modpack: Boolean(server.modpack),
    };
    return {
      server,
      status: server.status,
      info: { key: server.key, access: { allowed: true }, capabilities },
      capabilities,
      news: [],
      mods: server.modpack ? await modpack.modEntries() : [],
      metrics: null,
    };
  });
  handle("discord:login", async () => {
    try {
      const flow = await directory.authStart();
      await shell.openExternal(flow.authorizationUrl);
      const expiresAt = Math.min(
        Number(flow.expiresAt) || Date.now() + 2 * 60 * 1000,
        Date.now() + 10 * 60 * 1000,
      );
      while (Date.now() < expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const data = await directory.authStatus(flow.flowId, flow.pollToken);
          if (data?.status !== "complete" || !data.sessionToken) continue;
          settings.setDirectorySession(data.sessionToken);
          const user = {
            username: data.user?.username || "Discord user",
            tag: data.user?.username,
            avatar: data.user?.avatar || null,
          };
          settings.store.set("discordUser", user);
          return { success: true, user };
        } catch (error) {
          log.warn("Directory Discord polling failed", error);
          if (
            error instanceof DirectoryError &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          )
            return { success: false, error: error.message };
        }
      }
      return { success: false, error: "Discord login timed out." };
    } catch (error) {
      log.warn("Directory Discord login failed", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Discord login failed.",
      };
    }
  });
  handle("discord:logout", async () => {
    const token = settings.getDirectorySession();
    if (token)
      await directory
        .revokeSession(token)
        .catch((error) => log.warn("Directory logout failed", error));
    settings.clearDirectorySession();
    settings.store.set("encryptedServerSessions", {});
    settings.store.set("serverProfileIds", {});
    settings.store.set("discordUser", null);
    removeAuthFile();
  });
  handle("play:preflight", async () => {
    latestPreflight = await preflight();
    return latestPreflight;
  });
  handle("install:repair", async () => {
    try {
      const server = settings.activeServer();
      if (!server) throw new Error("Select a server first.");
      if (!(await confirmClientPackTrust(server))) {
        return {
          success: false,
          error: "Client Pack permission was not granted.",
        };
      }
      await modpack.install();
      await clientPacks.install(server, modpack.root());
      await modpack.commit();
      send("install:state", {
        phase: "complete",
        message: "The isolated server MO2 instance is ready.",
      });
      latestPreflight = await preflight();
      return { success: latestPreflight.ready };
    } catch (error) {
      await modpack.rollback().catch((rollbackError) =>
        log.error("MO2 transaction rollback failed", rollbackError),
      );
      return { success: false, error: (error as Error).message };
    }
  });
  handle("install:cancel", async () => {
    return clientPacks.cancel() || (await modpack.cancel());
  });
  handle("play:start", async () => {
    try {
      const selected = settings.activeServer();
      if (!selected) throw new Error("Select a server first.");
      if (!(await confirmClientPackTrust(selected))) {
        return {
          success: false,
          error: "Client Pack permission was not granted.",
        };
      }
      await authorizeForPlay();
      latestPreflight = await preflight();
      if (!latestPreflight.ready)
        return {
          success: false,
          needsRepair: latestPreflight.repairable,
          preflight: latestPreflight,
          error: "Preflight checks failed.",
        };
      await launchGame();
      return { success: true };
    } catch (error) {
      const directoryError = error instanceof DirectoryError ? error : null;
      return {
        success: false,
        error: (error as Error).message,
        errorCode: directoryError?.body?.error?.code,
        inviteUrl: directoryError?.body?.error?.inviteUrl,
      };
    }
  });
  handle("diagnostics:export", () =>
    exportDiagnostics(settings, log, latestPreflight),
  );
  handle("external:open", async (_event, value) => {
    const url = externalUrlSchema.parse(value);
    const host = new URL(url).hostname.toLowerCase();
    const configured = new Set([
      new URL(config.directory.url).hostname,
      ...config.security.externalHosts,
      ...Object.values(config.links)
        .filter(Boolean)
        .map((item: any) => new URL(item).hostname),
    ]);
    if (!configured.has(host)) {
      const answer = await dialog.showMessageBox(win!, {
        type: "question",
        buttons: ["Cancel", "Open"],
        defaultId: 0,
        cancelId: 0,
        title: "Open external website?",
        message: host,
        detail: "This website is outside the configured launcher hosts.",
      });
      if (answer.response !== 1) return false;
    }
    await shell.openExternal(url);
    return true;
  });
  handle("updates:getState", () => updater.getState());
  handle("updates:check", () => updater.check());
  handle("updates:install", () => updater.install());
}

if (gotLock)
  app
    .whenReady()
    .then(async () => {
      settings = new SettingsService();
      if (!settings.store.get("directoryUrl")) {
        const officialKey = crypto
          .createPublicKey({
            key: Buffer.from(config.directory.publicKey, "base64"),
            format: "der",
            type: "spki",
          })
          .export({ format: "der", type: "spki" });
        settings.store.set("directoryUrl", config.directory.url);
        settings.store.set("directoryPublicKey", config.directory.publicKey);
        settings.store.set(
          "directoryFingerprint",
          crypto.createHash("sha256").update(officialKey).digest("hex"),
        );
      } else {
        const pinned = settings.store.get("directoryPublicKey");
        if (!pinned) throw new Error("Pinned Directory public key is missing.");
        directory = new DirectoryApi({
          url: settings.store.get("directoryUrl"),
          publicKey: pinned,
        });
      }
      if (pendingJoinTarget) await applyJoinTarget(pendingJoinTarget);
      modpack = new VortexMo2Service({
        settings,
        userData: app.getPath("userData"),
        runtimeSource: app.isPackaged
          ? path.join(process.resourcesPath, "runtime")
          : path.join(app.getAppPath(), "runtime"),
        vortexExtension: app.isPackaged
          ? path.join(process.resourcesPath, "vortex-extension")
          : path.join(app.getAppPath(), "vortex-extension"),
        skyrimPath: () => settings.store.get("skyrimPath"),
        getManifest: (serverId, signal) =>
          directory.modpack(serverId, signal),
        mo2Bootstrap: config.tools?.mo2,
        emit: (state) => send("install:state", state),
      });
      clientPacks = new ClientPackService({
        userData: app.getPath("userData"),
        maxArchiveBytes: config.behavior.maxClientPackageBytes,
      });
      registerIpc();
      createWindow();
      if (settings.store.get("closeBehavior") === "tray") ensureTray();
      updater.start();
      app.on("activate", () => {
        if (!win) createWindow();
        else win.show();
      });
      app.on("second-instance", (_event, argv) => {
        for (const argument of argv) receiveDeepLink(argument);
        win?.show();
        win?.focus();
      });
    })
    .catch((error) => {
      log.error("Startup failed", error);
      app.quit();
    });

process.on("uncaughtException", (error) => {
  log.error("Uncaught exception", error);
  settings?.store.set("lastCrash", new Date().toISOString());
});
process.on("unhandledRejection", (error) => {
  log.error("Unhandled rejection", error);
  settings?.store.set("lastCrash", new Date().toISOString());
});
app.on("before-quit", () => {
  quitting = true;
  modpack?.close();
});
app.on("window-all-closed", () => {
  if (
    process.platform !== "darwin" &&
    settings?.store.get("closeBehavior") !== "tray"
  )
    app.quit();
});
