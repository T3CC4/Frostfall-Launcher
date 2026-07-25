const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { selectors, util } = require("vortex-api");

const GAME_ID = "skyrimse";
const BRIDGE_ROOT =
  process.env.SKYMP_VORTEX_BRIDGE ||
  path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "SkyMP",
    "VortexBridge",
  );

function main(context) {
  const pending = new Map();

  function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function update(request, phase, message, error) {
    atomicJson(path.join(BRIDGE_ROOT, "status", `${request.serverInstance}.json`), {
      schemaVersion: 1,
      serverInstance: request.serverInstance,
      requestId: request.requestId,
      nonce: request.nonce,
      phase,
      message,
      ...(error ? { error: String(error.message || error) } : {}),
      updatedAt: Date.now(),
    });
  }

  function account(state) {
    const user =
      state.persistent?.nexus?.userInfo ||
      state.session?.nexus?.userInfo ||
      state.persistent?.nexus?.user;
    return {
      user: user?.name || user?.username || user?.email,
      premium: Boolean(user?.isPremium || user?.isSupporter || user?.premium),
    };
  }

  function valueId(value) {
    return value == null ? "" : String(value).toLowerCase();
  }

  function matchesReference(mod, reference) {
    const candidates = new Set(
      [
        mod.id,
        mod.archiveId,
        mod.installationPath,
        mod.attributes?.fileId,
        mod.attributes?.modId,
        mod.attributes?.nexusFileId,
        mod.attributes?.nexusModId,
      ]
        .filter((value) => value != null)
        .map(valueId),
    );
    return [
      reference?.id,
      reference?.idHint,
      reference?.archiveId,
      reference?.repo?.fileId,
      reference?.repo?.modId,
      reference?.fileId,
      reference?.modId,
    ]
      .filter((value) => value != null)
      .some((value) => candidates.has(valueId(value)));
  }

  function ids(mod) {
    return {
      modId: Number(
        mod.attributes?.modId ||
          mod.attributes?.nexusModId ||
          mod.attributes?.source?.modId,
      ),
      fileId: Number(
        mod.attributes?.fileId ||
          mod.attributes?.nexusFileId ||
          mod.attributes?.source?.fileId,
      ),
    };
  }

  function portableMetadata(value) {
    if (Array.isArray(value)) {
      return value.map(portableMetadata).filter((item) => item !== undefined);
    }
    if (typeof value === "string") {
      return path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)
        ? undefined
        : value;
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/token|archive|downloadUrl|stagingRoot|installationPath|absolutePath/i.test(
              key,
            ),
        )
        .map(([key, child]) => [key, portableMetadata(child)])
        .filter(([, child]) => child !== undefined),
    );
  }

  function hashTreeSync(root) {
    const files = [];
    function walk(directory) {
      const entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Symbolic links are not supported in Collection staging: ${entry.name}`);
        }
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile()) {
          const data = fs.readFileSync(absolute);
          files.push({
            path: path.relative(root, absolute).replaceAll("\\", "/"),
            size: data.length,
            sha256: crypto.createHash("sha256").update(data).digest("hex"),
          });
        }
      }
    }
    walk(root);
    const digest = files
      .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
      .join("");
    return {
      treeSha256: crypto.createHash("sha256").update(digest).digest("hex"),
      files,
    };
  }

  function collectionFor(state, request) {
    return Object.values(state.persistent?.mods?.[GAME_ID] || {}).find(
      (mod) =>
        mod?.type === "collection" &&
        mod.state === "installed" &&
        mod.attributes?.collectionSlug === request.collection.slug &&
        Number(mod.attributes?.revisionNumber) === request.collection.revision,
    );
  }

  function exportInstalledCollections() {
    const api = context.api;
    const state = api.getState();
    const stagingRoot = selectors.installPathForGame(state, GAME_ID);
    if (!stagingRoot) {
      throw new Error("Configure the Skyrim Special Edition staging folder first.");
    }
    const allMods = Object.values(state.persistent?.mods?.[GAME_ID] || {});
    const collections = allMods.filter(
      (mod) =>
        mod?.type === "collection" &&
        mod.state === "installed" &&
        mod.attributes?.collectionSlug &&
        Number.isInteger(Number(mod.attributes?.revisionNumber)),
    );
    if (collections.length === 0) {
      throw new Error("No installed pinned Skyrim Special Edition Collection was found.");
    }
    const rawLoadOrder = state.persistent?.loadOrder?.[GAME_ID] || [];
    const entries = Array.isArray(rawLoadOrder)
      ? rawLoadOrder
      : Object.values(rawLoadOrder);
    const loadOrder = entries
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry?.name || entry?.plugin || entry?.id,
      )
      .filter(
        (name) =>
          typeof name === "string" && /\.(esm|esp|esl)$/i.test(name),
      );
    const outputs = [];
    for (const collection of collections) {
      const references = (collection.rules || [])
        .map((rule) => rule?.reference)
        .filter(Boolean);
      const dependencies = [];
      for (const reference of references) {
        const mod = allMods.find(
          (candidate) =>
            candidate &&
            candidate.type !== "collection" &&
            candidate.state === "installed" &&
            matchesReference(candidate, reference),
        );
        if (!mod) continue;
        const nexus = ids(mod);
        if (
          !Number.isInteger(nexus.modId) ||
          nexus.modId < 1 ||
          !Number.isInteger(nexus.fileId) ||
          nexus.fileId < 1
        ) {
          continue;
        }
        const relativePath = String(mod.installationPath);
        const tree = hashTreeSync(path.resolve(stagingRoot, relativePath));
        dependencies.push({
          name: String(mod.attributes?.name || mod.id),
          version: String(mod.attributes?.version || mod.attributes?.logicalFileName || "unknown"),
          modId: nexus.modId,
          fileId: nexus.fileId,
          path: relativePath,
          installOrder: dependencies.length,
          fomod:
            portableMetadata(
              mod.attributes?.installerChoices ||
                mod.attributes?.fomod ||
                mod.attributes?.installerOptions ||
                null,
            ),
          plugins: tree.files
            .map((file) => file.path)
            .filter((file) => /\.(esm|esp|esl)$/i.test(file)),
          treeSha256: tree.treeSha256,
          files: tree.files,
        });
      }
      const slug = String(collection.attributes.collectionSlug);
      const revision = Number(collection.attributes.revisionNumber);
      const output = path.join(
        BRIDGE_ROOT,
        "exports",
        `${slug}-r${revision}.json`,
      );
      atomicJson(output, {
        schemaVersion: 1,
        collection: {
          game: "skyrimspecialedition",
          slug,
          revision,
        },
        mods: dependencies,
        loadOrder,
      });
      outputs.push(output);
    }
    api.sendNotification({
      type: "success",
      title: "SkyMP Collection export ready",
      message: `${outputs.length} pinned Collection export(s) written for skymp-buildtool.`,
    });
  }

  function writeReceipt(request) {
    const api = context.api;
    const state = api.getState();
    const collection = collectionFor(state, request);
    if (!collection) return false;
    const stagingRoot = selectors.installPathForGame(state, GAME_ID);
    if (!stagingRoot) {
      throw new Error("SkyMP Vortex staging is not configured for Skyrim Special Edition.");
    }
    if (path.resolve(stagingRoot) !== path.resolve(request.stagingDirectory)) {
      throw new Error("Vortex staging escaped the isolated SkyMP helper directory.");
    }
    const discovered = state.settings?.gameMode?.discovered?.[GAME_ID]?.path;
    if (path.resolve(discovered || "") !== path.resolve(request.gameSandbox)) {
      throw new Error("Vortex game deployment is not isolated from the real Skyrim installation.");
    }
    const references = (collection.rules || [])
      .map((rule) => rule?.reference)
      .filter(Boolean);
    const installed = Object.values(state.persistent?.mods?.[GAME_ID] || {}).filter(
      (mod) =>
        mod &&
        mod.type !== "collection" &&
        mod.state === "installed" &&
        references.some((reference) => matchesReference(mod, reference)),
    );
    const byKey = new Map();
    for (const mod of installed) {
      const nexus = ids(mod);
      if (Number.isInteger(nexus.modId) && Number.isInteger(nexus.fileId)) {
        byKey.set(`nexus:${nexus.modId}:${nexus.fileId}`, mod);
      }
    }
    const mods = request.mods.map((wanted) => {
      const mod = byKey.get(wanted.key);
      if (!mod) throw new Error(`${wanted.name} is not installed at the pinned Nexus file.`);
      const installationPath = String(mod.installationPath || "");
      const absolute = path.resolve(stagingRoot, installationPath);
      const staging = path.resolve(stagingRoot);
      if (absolute !== staging && !absolute.startsWith(`${staging}${path.sep}`)) {
        throw new Error(`Vortex returned an unsafe staging path for ${wanted.name}.`);
      }
      return {
        key: wanted.key,
        name: wanted.name,
        version: String(mod.attributes?.version || mod.attributes?.logicalFileName || ""),
        path: absolute,
      };
    });
    const nexus = account(state);
    atomicJson(
      path.join(BRIDGE_ROOT, "receipts", `${request.serverInstance}.json`),
      {
        schemaVersion: 1,
        serverInstance: request.serverInstance,
        nonce: request.nonce,
        collection: request.collection,
        stagingRoot: path.resolve(stagingRoot),
        premium: nexus.premium,
        ...(nexus.user ? { user: nexus.user } : {}),
        mods,
      },
    );
    pending.delete(request.serverInstance);
    update(request, "complete", "Collection installation exported to SkyMP.");
    api.sendNotification({
      type: "success",
      title: "SkyMP Collection ready",
      message: `${request.collection.slug} revision ${request.collection.revision} is ready.`,
    });
    return true;
  }

  async function startCollection(request) {
    const api = context.api;
    const state = api.getState();
    const nexus = account(state);
    if (!nexus.user) {
      update(request, "login", "Waiting for Nexus login in Vortex.");
      if (api.ext?.nexusRequestNexusLogin) await api.ext.nexusRequestNexusLogin();
      return;
    }
    pending.set(request.serverInstance, request);
    if (writeReceipt(request)) return;
    const page = `https://next.nexusmods.com/skyrimspecialedition/collections/${encodeURIComponent(
      request.collection.slug,
    )}/revisions/${request.collection.revision}`;
    update(
      request,
      nexus.premium ? "downloading" : "browser-wait",
      nexus.premium
        ? "Vortex is downloading the pinned Collection."
        : "Waiting for the required Nexus download confirmations.",
    );
    api.sendNotification({
      type: "info",
      title: "SkyMP Collection required",
      message: nexus.premium
        ? "Vortex will download the pinned Collection."
        : "Confirm each required download on Nexus Mods. Vortex will continue automatically.",
    });
    if (api.ext?.nexusOpenCollectionPage) {
      api.ext.nexusOpenCollectionPage(
        GAME_ID,
        request.collection.slug,
        request.collection.revision,
        "skymp",
      );
    } else {
      await util.opn(page);
    }
  }

  function isolateLauncherJob(request) {
    if (
      typeof request.gameSandbox !== "string" ||
      typeof request.stagingDirectory !== "string" ||
      !fs.existsSync(path.join(request.gameSandbox, "SkyrimSE.exe"))
    ) {
      throw new Error("SkyMP isolated Vortex game sandbox is invalid.");
    }
    fs.mkdirSync(path.join(request.gameSandbox, "Data"), { recursive: true });
    fs.mkdirSync(request.stagingDirectory, { recursive: true });
    context.api.store.dispatch({
      type: "SET_GAME_PATH",
      payload: {
        gameId: GAME_ID,
        gamePath: path.resolve(request.gameSandbox),
        store: "skymp",
        exePath: "SkyrimSE.exe",
      },
    });
    context.api.store.dispatch({
      type: "SET_MOD_INSTALL_PATH",
      payload: {
        gameId: GAME_ID,
        path: path.resolve(request.stagingDirectory),
      },
    });
    const state = context.api.getState();
    const discovered = state.settings?.gameMode?.discovered?.[GAME_ID]?.path;
    const staging = selectors.installPathForGame(state, GAME_ID);
    if (
      path.resolve(discovered || "") !== path.resolve(request.gameSandbox) ||
      path.resolve(staging || "") !== path.resolve(request.stagingDirectory)
    ) {
      throw new Error("Vortex refused the isolated SkyMP game or staging paths.");
    }
  }

  context.api.onStateChange?.(["persistent", "mods", GAME_ID], () => {
    for (const request of pending.values()) {
      try {
        writeReceipt(request);
      } catch (error) {
        update(request, "installing", String(error.message || error));
      }
    }
  });

  context.registerAction?.(
    "global-icons",
    100,
    "skymp-export-collection",
    {},
    "Export installed Collection for SkyMP",
    () => {
      try {
        exportInstalledCollections();
      } catch (error) {
        context.api.showErrorNotification?.("SkyMP Collection export failed", error);
      }
    },
  );

  context.registerProtocol("skymp", false, async (url) => {
    if (url.hostname !== "job") return;
    const requestId = url.pathname.replace(/^\/+/, "");
    const nonce = url.searchParams.get("nonce");
    if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[0-9a-f]{64}$/i.test(nonce || "")) {
      throw new Error("Invalid SkyMP Vortex request.");
    }
    const requestFile = path.join(BRIDGE_ROOT, "requests", `${requestId}.json`);
    const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    if (
      request.schemaVersion !== 1 ||
      request.requestId !== requestId ||
      request.nonce !== nonce ||
      !/^[0-9a-f]{64}$/i.test(request.serverInstance || "")
    ) {
      throw new Error("SkyMP Vortex request authentication failed.");
    }
    if (request.action === "login") {
      update(request, "login", "Waiting for Nexus login in Vortex.");
      if (context.api.ext?.nexusRequestNexusLogin) {
        await context.api.ext.nexusRequestNexusLogin();
      }
      return;
    }
    if (
      request.action !== "install" ||
      request.collection?.game !== "skyrimspecialedition" ||
      !request.collection.slug ||
      !Number.isInteger(request.collection.revision) ||
      !Array.isArray(request.mods)
    ) {
      throw new Error("Invalid SkyMP Collection request.");
    }
    isolateLauncherJob(request);
    await startCollection(request);
  });
}

module.exports = { default: main };
