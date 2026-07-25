import AdmZip from "adm-zip";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { clientManifestSchema } from "./schemas.js";
import {
  pathInside,
  safeRelativePath,
  sha256File,
  verifyManifestSignature,
} from "./manifest.js";
import type { ClientManifest, ManifestFile, Server } from "./types.js";

const MOD_NAME = "SkyMP Server Client Pack";
const ENTRYPOINT = "Platform/Plugins/skymp-server-extension.js";
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

interface ClientPackReceipt {
  schemaVersion: 1;
  serverId: string;
  version: string;
  manifestSha256: string;
  archiveSha256: string;
  files: ManifestFile[];
}

export interface ClientPackPreflight {
  status: "ok" | "repairable" | "error";
  message: string;
  downloadBytes: number;
  offline: boolean;
  manifest?: ClientManifest;
}

export class ClientPackService {
  private abortController: AbortController | null = null;
  private readonly manifests = new Map<string, ClientManifest>();

  constructor(
    private readonly options: {
      userData: string;
      maxArchiveBytes: number;
    },
  ) {}

  async preflight(
    server: Server,
    mo2Root: string,
  ): Promise<ClientPackPreflight> {
    if (!server.clientPack) {
      const stale =
        fs.existsSync(this.activeMod(mo2Root)) ||
        fs.existsSync(this.receiptPath(server.key));
      return stale
        ? {
            status: "repairable",
            message:
              "This server no longer publishes a Client Pack; remove its old server-local pack.",
            downloadBytes: 0,
            offline: false,
          }
        : {
            status: "ok",
            message: "This server uses only the global SkyMP client.",
            downloadBytes: 0,
            offline: false,
          };
    }
    try {
      const loaded = await this.loadManifest(server);
      this.manifests.set(server.key, loaded.manifest);
      const valid = await this.verifyInstalled(
        server,
        mo2Root,
        loaded.manifest,
      );
      return valid
        ? {
            status: "ok",
            message: `Server Client Pack ${loaded.manifest.version} is verified.`,
            downloadBytes: 0,
            offline: loaded.offline,
            manifest: loaded.manifest,
          }
        : {
            status: "repairable",
            message: `Server Client Pack ${loaded.manifest.version} must be installed or repaired.`,
            downloadBytes: loaded.manifest.archive.size,
            offline: loaded.offline,
            manifest: loaded.manifest,
          };
    } catch (cause) {
      return {
        status: "error",
        message: `Client Pack security check failed: ${errorMessage(cause)}`,
        downloadBytes: 0,
        offline: false,
      };
    }
  }

  async install(server: Server, mo2Root: string): Promise<void> {
    if (!server.clientPack) {
      await fs.promises.rm(this.activeMod(mo2Root), {
        recursive: true,
        force: true,
      });
      await fs.promises.rm(this.receiptPath(server.key), { force: true });
      await setPackModEnabled(mo2Root, false);
      this.manifests.delete(server.key);
      return;
    }
    this.abortController = new AbortController();
    try {
      const { manifest } = await this.loadManifest(server);
      const archive = await this.ensureArchive(
        server,
        manifest,
        this.abortController.signal,
      );
      await this.installArchive(server, mo2Root, manifest, archive);
      this.manifests.set(server.key, manifest);
    } finally {
      this.abortController = null;
    }
  }

  cancel(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async runtimeAttestation(
    server: Server,
    mo2Root: string,
  ): Promise<{ version: string; manifestSha256: string } | null> {
    if (!server.clientPack) return null;
    const manifest = this.manifests.get(server.key);
    if (!manifest || !(await this.verifyInstalled(server, mo2Root, manifest))) {
      throw new Error(
        "The server Client Pack receipt changed after preflight. Repair is required.",
      );
    }
    return {
      version: manifest.version,
      manifestSha256: server.clientPack.manifestSha256,
    };
  }

  private async loadManifest(
    server: Server,
  ): Promise<{ manifest: ClientManifest; offline: boolean }> {
    if (!server.clientPack)
      throw new Error("Server has no Client Pack metadata.");
    const expectedHash = server.clientPack.manifestSha256;
    let raw: Buffer;
    let offline = false;
    try {
      raw = await requestBuffer(
        packUrl(server, "/api/client-pack/manifest"),
        MAX_MANIFEST_BYTES,
      );
    } catch (cause) {
      if (!(cause instanceof ClientPackTransportError)) throw cause;
      raw = await fs.promises.readFile(
        this.manifestCachePath(server.key, expectedHash),
      );
      offline = true;
    }
    const actualHash = sha256(raw);
    if (actualHash !== expectedHash) {
      throw new Error(
        `Directory manifest hash mismatch (expected ${expectedHash}, received ${actualHash}).`,
      );
    }
    let manifest: ClientManifest;
    try {
      manifest = clientManifestSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch (cause) {
      throw new Error(
        `Client Pack manifest is invalid: ${errorMessage(cause)}`,
        { cause },
      );
    }
    this.validateManifest(server, manifest);
    if (!offline) {
      await atomicWrite(this.manifestCachePath(server.key, expectedHash), raw);
    }
    return { manifest, offline };
  }

  private validateManifest(server: Server, manifest: ClientManifest): void {
    if (!server.clientPack)
      throw new Error("Server Client Pack metadata disappeared.");
    if (server.identity.algorithm !== "Ed25519")
      throw new Error("Unsupported server identity algorithm.");
    const identity = crypto.createPublicKey({
      key: Buffer.from(server.identity.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const fingerprint = crypto
      .createHash("sha256")
      .update(identity.export({ format: "der", type: "spki" }))
      .digest("base64url");
    if (`sha256:${fingerprint}` !== server.identity.fingerprint) {
      throw new Error(
        "Directory server identity fingerprint does not match its public key.",
      );
    }
    if (!verifyManifestSignature(manifest, server.identity.publicKey)) {
      throw new Error(
        "Client Pack manifest signature is invalid for this server identity.",
      );
    }
    if (
      manifest.serverId !== server.key ||
      manifest.version !== server.clientPack.version ||
      manifest.clientApiVersion !== server.clientPack.clientApiVersion ||
      manifest.archive.size > this.options.maxArchiveBytes
    ) {
      throw new Error(
        "Client Pack manifest does not match the Directory binding or Launcher limits.",
      );
    }
    const names = new Set<string>();
    let expanded = 0;
    for (const file of manifest.files) {
      const safe = safeRelativePath(file.path);
      if (safe !== file.path || !allowedInstallPath(safe)) {
        throw new Error(
          `Client Pack manifest contains a forbidden path: ${file.path}`,
        );
      }
      const key = safe.toLowerCase();
      if (names.has(key))
        throw new Error(
          `Client Pack manifest contains a duplicate path: ${safe}`,
        );
      names.add(key);
      if (file.size > MAX_FILE_BYTES)
        throw new Error(`Client Pack file is too large: ${safe}`);
      expanded += file.size;
      if (expanded > MAX_EXPANDED_BYTES)
        throw new Error("Client Pack expands beyond the Launcher limit.");
    }
    if (!names.has(ENTRYPOINT.toLowerCase()))
      throw new Error(`Client Pack is missing ${ENTRYPOINT}.`);
    if (
      manifest.ui &&
      (manifest.ui !== "Platform/UI/index.html" ||
        !names.has(manifest.ui.toLowerCase()))
    )
      throw new Error("Client Pack UI entry is invalid.");
  }

  private async ensureArchive(
    server: Server,
    manifest: ClientManifest,
    signal: AbortSignal,
  ): Promise<string> {
    const archive = this.archiveCachePath(server.key, manifest.archive.sha256);
    if (
      await fileMatches(archive, manifest.archive.size, manifest.archive.sha256)
    )
      return archive;
    const partial = `${archive}.part`;
    await fs.promises.mkdir(path.dirname(archive), { recursive: true });
    await this.downloadArchive(server, manifest, partial, signal);
    if (
      !(await fileMatches(
        partial,
        manifest.archive.size,
        manifest.archive.sha256,
      ))
    ) {
      await fs.promises.rm(partial, { force: true });
      await this.downloadArchive(server, manifest, partial, signal);
    }
    if (
      !(await fileMatches(
        partial,
        manifest.archive.size,
        manifest.archive.sha256,
      ))
    ) {
      await fs.promises.rm(partial, { force: true });
      throw new Error(
        "Downloaded Client Pack archive failed SHA-256 verification.",
      );
    }
    await fs.promises.rm(archive, { force: true });
    await fs.promises.rename(partial, archive);
    return archive;
  }

  private async downloadArchive(
    server: Server,
    manifest: ClientManifest,
    partial: string,
    signal: AbortSignal,
  ): Promise<void> {
    let offset = await fileSize(partial);
    if (offset >= manifest.archive.size) {
      await fs.promises.rm(partial, { force: true });
      offset = 0;
    }
    const target = packUrl(server, "/api/client-pack/archive");
    await new Promise<void>((resolvePromise, reject) => {
      const request = http.get(
        target,
        {
          signal,
          headers: {
            "accept-encoding": "identity",
            ...(offset ? { range: `bytes=${offset}-` } : {}),
          },
        },
        (response) => {
          if (isRedirect(response.statusCode)) {
            response.resume();
            return reject(new Error("Client Pack redirects are forbidden."));
          }
          if (offset && response.statusCode === 200) {
            response.resume();
            fs.promises
              .rm(partial, { force: true })
              .then(() =>
                this.downloadArchive(server, manifest, partial, signal),
              )
              .then(resolvePromise, reject);
            return;
          }
          const expectedStatus = offset ? 206 : 200;
          if (response.statusCode !== expectedStatus) {
            response.resume();
            return reject(
              new ClientPackTransportError(
                `Client Pack archive returned HTTP ${response.statusCode}.`,
              ),
            );
          }
          const expectedBytes = manifest.archive.size - offset;
          const contentLength = Number(response.headers["content-length"]);
          if (
            !Number.isSafeInteger(contentLength) ||
            contentLength !== expectedBytes
          ) {
            response.resume();
            return reject(
              new Error("Client Pack archive Content-Length is invalid."),
            );
          }
          if (
            offset &&
            response.headers["content-range"] !==
              `bytes ${offset}-${manifest.archive.size - 1}/${manifest.archive.size}`
          ) {
            response.resume();
            return reject(
              new Error("Client Pack archive Content-Range is invalid."),
            );
          }
          const etag = response.headers.etag;
          if (etag && etag !== `"${manifest.archive.sha256}"`) {
            response.resume();
            return reject(
              new Error(
                "Client Pack archive ETag does not match its signed SHA-256.",
              ),
            );
          }
          const output = fs.createWriteStream(partial, {
            flags: offset ? "a" : "w",
          });
          response.pipe(output);
          response.once("error", (cause) => output.destroy(cause));
          output.once("error", reject);
          output.once("finish", () => output.close(() => resolvePromise()));
        },
      );
      request.once("error", (cause) => {
        reject(
          cause instanceof Error && cause.name === "AbortError"
            ? cause
            : new ClientPackTransportError(errorMessage(cause)),
        );
      });
      request.setTimeout(30_000, () =>
        request.destroy(
          new ClientPackTransportError(
            "Client Pack archive request timed out.",
          ),
        ),
      );
    });
  }

  private async installArchive(
    server: Server,
    mo2Root: string,
    manifest: ClientManifest,
    archivePath: string,
  ): Promise<void> {
    const stageRoot = path.join(
      this.serverRoot(server.key),
      `staging-${crypto.randomUUID()}`,
    );
    const stagedMod = path.join(stageRoot, MOD_NAME);
    await fs.promises.mkdir(stagedMod, { recursive: true });
    try {
      const zip = new AdmZip(archivePath);
      const entries = zip.getEntries();
      const archiveFiles = new Map<string, AdmZip.IZipEntry>();
      let expandedSize = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const safe = safeRelativePath(entry.entryName);
        const key = safe.toLowerCase();
        if (archiveFiles.has(key))
          throw new Error(
            `Client Pack archive contains duplicate path ${safe}.`,
          );
        const mode = ((entry as unknown as { attr?: number }).attr ?? 0) >>> 16;
        if ((mode & 0o170000) === 0o120000)
          throw new Error(
            `Client Pack archive contains a symbolic link: ${safe}.`,
          );
        const declaredSize = entry.header.size;
        if (
          !Number.isSafeInteger(declaredSize) ||
          declaredSize < 0 ||
          declaredSize > MAX_FILE_BYTES
        ) {
          throw new Error(`Client Pack archive entry is too large: ${safe}.`);
        }
        expandedSize += declaredSize;
        if (expandedSize > MAX_EXPANDED_BYTES)
          throw new Error(
            "Client Pack archive expands beyond the Launcher limit.",
          );
        archiveFiles.set(key, entry);
      }
      const metadataEntry = archiveFiles.get("client-pack.json");
      if (!metadataEntry)
        throw new Error("Client Pack archive is missing client-pack.json.");
      if (metadataEntry.header.size > 64 * 1024)
        throw new Error("client-pack.json exceeds 64 KiB.");
      const metadata = JSON.parse(
        metadataEntry.getData().toString("utf8"),
      ) as Record<string, unknown>;
      if (
        metadata.schemaVersion !== 1 ||
        metadata.version !== manifest.version ||
        metadata.clientApiVersion !== 1 ||
        metadata.entrypoint !== ENTRYPOINT ||
        metadata.ui !== manifest.ui
      ) {
        throw new Error(
          "Client Pack archive metadata does not match its signed manifest.",
        );
      }
      const expected = new Set(["client-pack.json"]);
      for (const file of manifest.files) {
        expected.add(file.path.toLowerCase());
        const entry = archiveFiles.get(file.path.toLowerCase());
        if (!entry)
          throw new Error(`Client Pack archive is missing ${file.path}.`);
        if (entry.header.size !== file.size)
          throw new Error(`Client Pack file size is invalid: ${file.path}.`);
        const content = entry.getData();
        if (content.length !== file.size || sha256(content) !== file.sha256) {
          throw new Error(
            `Client Pack file verification failed: ${file.path}.`,
          );
        }
        const destination = pathInside(stagedMod, file.path);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.writeFile(destination, content, { mode: 0o644 });
      }
      for (const key of archiveFiles.keys()) {
        if (!expected.has(key))
          throw new Error(`Client Pack archive contains unsigned file ${key}.`);
      }
      const receipt: ClientPackReceipt = {
        schemaVersion: 1,
        serverId: server.key,
        version: manifest.version,
        manifestSha256: server.clientPack!.manifestSha256,
        archiveSha256: manifest.archive.sha256,
        files: manifest.files,
      };
      await this.commit(server, mo2Root, stagedMod, receipt);
    } finally {
      await fs.promises.rm(stageRoot, { recursive: true, force: true });
    }
  }

  private async commit(
    server: Server,
    mo2Root: string,
    stagedMod: string,
    receipt: ClientPackReceipt,
  ): Promise<void> {
    const active = this.activeMod(mo2Root);
    const backup = path.join(
      path.dirname(active),
      `.client-pack-backup-${crypto.randomUUID()}`,
    );
    const receiptPath = this.receiptPath(server.key);
    const previousReceipt = await readOptional(receiptPath);
    const modlistPath = path.join(
      mo2Root,
      "profiles",
      "Frostfall",
      "modlist.txt",
    );
    const previousModlist = await readOptional(modlistPath);
    let backedUp = false;
    try {
      await fs.promises.mkdir(path.dirname(active), { recursive: true });
      if (fs.existsSync(active)) {
        await fs.promises.rename(active, backup);
        backedUp = true;
      }
      await fs.promises.rename(stagedMod, active);
      await atomicWrite(
        receiptPath,
        Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
      );
      await setPackModEnabled(mo2Root, true);
      await fs.promises.rm(backup, { recursive: true, force: true });
    } catch (cause) {
      await fs.promises.rm(active, { recursive: true, force: true });
      if (backedUp && fs.existsSync(backup))
        await fs.promises.rename(backup, active);
      await restoreOptional(receiptPath, previousReceipt);
      await restoreOptional(modlistPath, previousModlist);
      throw cause;
    }
  }

  private async verifyInstalled(
    server: Server,
    mo2Root: string,
    manifest: ClientManifest,
  ): Promise<boolean> {
    let receipt: ClientPackReceipt;
    try {
      receipt = JSON.parse(
        await fs.promises.readFile(this.receiptPath(server.key), "utf8"),
      ) as ClientPackReceipt;
    } catch {
      return false;
    }
    if (
      receipt.schemaVersion !== 1 ||
      receipt.serverId !== server.key ||
      receipt.version !== manifest.version ||
      receipt.manifestSha256 !== server.clientPack?.manifestSha256 ||
      receipt.archiveSha256 !== manifest.archive.sha256 ||
      JSON.stringify(receipt.files) !== JSON.stringify(manifest.files)
    )
      return false;
    const active = this.activeMod(mo2Root);
    const actual = await listFiles(active).catch(() => []);
    if (actual.length !== manifest.files.length) return false;
    const expectedNames = new Set(
      manifest.files.map((file) => file.path.toLowerCase()),
    );
    if (actual.some((file) => !expectedNames.has(file.toLowerCase())))
      return false;
    for (const file of manifest.files) {
      const target = pathInside(active, file.path);
      try {
        const info = await fs.promises.stat(target);
        if (
          !info.isFile() ||
          info.size !== file.size ||
          (await sha256File(target)) !== file.sha256
        )
          return false;
      } catch {
        return false;
      }
    }
    const modlist = await readOptional(
      path.join(mo2Root, "profiles", "Frostfall", "modlist.txt"),
    );
    const lines = modlist?.toString("utf8").trim().split(/\r?\n/) ?? [];
    return lines.at(-1) === `+${MOD_NAME}`;
  }

  private serverRoot(serverId: string): string {
    return path.join(this.options.userData, "servers", serverId, "client-pack");
  }
  private manifestCachePath(serverId: string, hash: string): string {
    return path.join(this.serverRoot(serverId), "cache", `${hash}.json`);
  }
  private archiveCachePath(serverId: string, hash: string): string {
    return path.join(this.serverRoot(serverId), "cache", `${hash}.zip`);
  }
  private receiptPath(serverId: string): string {
    return path.join(this.serverRoot(serverId), "receipt.json");
  }
  private activeMod(mo2Root: string): string {
    return path.join(mo2Root, "mods", MOD_NAME);
  }
}

export async function setPackModEnabled(
  mo2Root: string,
  enabled: boolean,
): Promise<void> {
  const target = path.join(mo2Root, "profiles", "Frostfall", "modlist.txt");
  const current = (await readOptional(target))?.toString("utf8") ?? "";
  const lines = current
    .split(/\r?\n/)
    .filter(
      (line) => line && line !== `+${MOD_NAME}` && line !== `-${MOD_NAME}`,
    );
  if (enabled) lines.push(`+${MOD_NAME}`);
  await atomicWrite(
    target,
    Buffer.from(lines.length ? `${lines.join("\n")}\n` : ""),
  );
}

function packUrl(server: Server, pathname: string): URL {
  if (!server.clientPack)
    throw new Error("Server has no Client Pack endpoint.");
  const host =
    server.address.includes(":") && !server.address.startsWith("[")
      ? `[${server.address}]`
      : server.address;
  const url = new URL(`http://${host}:${server.clientPack.port}${pathname}`);
  if (url.username || url.password || url.pathname !== pathname) {
    throw new Error("Directory Client Pack endpoint is invalid.");
  }
  return url;
}

function requestBuffer(url: URL, limit: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const request = http.get(
      url,
      { headers: { "accept-encoding": "identity" } },
      (response) => {
        if (isRedirect(response.statusCode)) {
          response.resume();
          return reject(new Error("Client Pack redirects are forbidden."));
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(
            new ClientPackTransportError(
              `Client Pack manifest returned HTTP ${response.statusCode}.`,
            ),
          );
        }
        const declared = Number(response.headers["content-length"]);
        if (
          !Number.isSafeInteger(declared) ||
          declared < 1 ||
          declared > limit
        ) {
          response.resume();
          return reject(
            new Error("Client Pack manifest Content-Length is invalid."),
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > limit)
            request.destroy(
              new Error("Client Pack manifest exceeds the size limit."),
            );
          else chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => {
          if (size !== declared)
            return reject(
              new Error("Client Pack manifest download is incomplete."),
            );
          resolvePromise(Buffer.concat(chunks));
        });
      },
    );
    request.once("error", (cause) =>
      reject(
        cause instanceof ClientPackTransportError
          ? cause
          : new ClientPackTransportError(errorMessage(cause)),
      ),
    );
    request.setTimeout(10_000, () =>
      request.destroy(
        new ClientPackTransportError("Client Pack manifest request timed out."),
      ),
    );
  });
}

function allowedInstallPath(value: string): boolean {
  if (/\.(?:dll|pex|esp|esm|esl|bsa)$/i.test(value)) return false;
  return (
    value === ENTRYPOINT ||
    value.startsWith("Platform/UI/") ||
    value.startsWith("Platform/Fonts/") ||
    value.startsWith("Platform/ServerAssets/")
  );
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string) => {
    for (const child of await fs.promises.readdir(directory, {
      withFileTypes: true,
    })) {
      const absolute = path.join(directory, child.name);
      if (child.isSymbolicLink())
        throw new Error("Client Pack installation contains a symbolic link.");
      if (child.isDirectory()) await visit(absolute);
      else if (child.isFile())
        result.push(path.relative(root, absolute).split(path.sep).join("/"));
      else
        throw new Error(
          "Client Pack installation contains an unsupported entry.",
        );
    }
  };
  await visit(root);
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

async function fileMatches(
  filename: string,
  size: number,
  hash: string,
): Promise<boolean> {
  try {
    const info = await fs.promises.stat(filename);
    return (
      info.isFile() &&
      info.size === size &&
      (await sha256File(filename)) === hash
    );
  } catch {
    return false;
  }
}

async function fileSize(filename: string): Promise<number> {
  try {
    const info = await fs.promises.stat(filename);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function atomicWrite(filename: string, value: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, value);
    await fs.promises.rm(filename, { force: true });
    await fs.promises.rename(temporary, filename);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function readOptional(filename: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(filename);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function restoreOptional(
  filename: string,
  value: Buffer | null,
): Promise<void> {
  if (value) await atomicWrite(filename, value);
  else await fs.promises.rm(filename, { force: true });
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isRedirect(status: number | undefined): boolean {
  return status !== undefined && status >= 300 && status < 400;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

class ClientPackTransportError extends Error {}
