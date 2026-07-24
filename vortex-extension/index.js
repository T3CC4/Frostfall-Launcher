const fs = require("fs");
const path = require("path");
const { selectors, util } = require("vortex-api");

function main(context) {
  const pending = new Map();

  const writeCompletedReceipt = (request) => {
    const api = context.api;
    const state = api.getState();
    const gameId = "skyrimse";
    const allMods = Object.values(state.persistent.mods?.[gameId] || {});
    const collectionMod = allMods.find((mod) =>
      mod?.type === "collection"
      && mod.state === "installed"
      && mod.attributes?.collectionSlug === request.collection
      && Number(mod.attributes?.revisionNumber) === request.revision);
    if (!collectionMod) return false;
    const references = (collectionMod.rules || [])
      .map((rule) => rule?.reference)
      .filter(Boolean);
    const matchesReference = (mod, reference) => {
      const candidates = new Set([
        mod.id,
        mod.archiveId,
        mod.installationPath,
        String(mod.attributes?.fileId || ""),
        String(mod.attributes?.modId || ""),
      ].filter(Boolean).map((value) => String(value).toLowerCase()));
      return [
        reference.id,
        reference.idHint,
        reference.archiveId,
        reference.repo?.fileId,
        reference.repo?.modId,
      ].filter(Boolean).some((value) => candidates.has(String(value).toLowerCase()));
    };
    const mods = allMods
      .filter((mod) =>
        mod
        && mod.type !== "collection"
        && mod.state === "installed"
        && references.some((reference) => matchesReference(mod, reference)))
      .map((mod) => ({
        name: mod.attributes?.name || mod.id,
        path: mod.installationPath,
      }));
    if (!mods.length)
      throw new Error("The pinned Collection is installed, but its installed dependencies could not be resolved.");
    const stagingRoot = selectors.installPathForGame(state, gameId);
    if (!stagingRoot)
      throw new Error("Configure the Skyrim Special Edition staging folder in Vortex first.");
    const receiptDir = path.join(
      api.getPath?.("userData") || process.env.APPDATA,
      "skymp",
      "receipts",
    );
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, `${request.serverId}.json`), JSON.stringify({
      serverId: request.serverId,
      collection: request.collection,
      revision: request.revision,
      stagingRoot,
      mods,
      writtenAt: Date.now(),
    }, null, 2));
    pending.delete(request.serverId);
    api.sendNotification({
      type: "success",
      title: "SkyMP Collection ready",
      message: `${request.collection} revision ${request.revision} is ready for the Launcher.`,
    });
    return true;
  };

  context.api.onStateChange?.(["persistent", "mods", "skyrimse"], () => {
    for (const request of pending.values()) {
      try {
        writeCompletedReceipt(request);
      } catch (error) {
        context.api.showErrorNotification?.("SkyMP Collection receipt failed", error);
      }
    }
  });

  context.registerProtocol("skymp", false, async (url) => {
    if (url.hostname !== "install") return;
    const serverId = url.searchParams.get("server");
    const collection = url.searchParams.get("collection");
    const revision = Number(url.searchParams.get("revision"));
    if (!serverId || !collection || !Number.isInteger(revision) || revision < 1)
      throw new Error("Invalid SkyMP Collection request.");

    const api = context.api;
    const request = { serverId, collection, revision };
    pending.set(serverId, request);
    if (writeCompletedReceipt(request)) return;
    await api.sendNotification({
      type: "info",
      title: "SkyMP Collection required",
      message: `Install Nexus Collection ${collection}, pinned revision ${revision}.`,
    });
    if (api.ext?.nexusOpenCollectionPage)
      api.ext.nexusOpenCollectionPage("skyrimse", collection, revision, "skymp");
    else
      await util.opn(`https://next.nexusmods.com/skyrimspecialedition/collections/${encodeURIComponent(collection)}/revisions/${revision}`);
  });
}

module.exports = { default: main };
