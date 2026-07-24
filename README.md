# Frostfall / SkyMP Launcher

Launcher for the self-hostable SkyMP Directory contract.

The official Directory URL and Ed25519 key are preinstalled. In Settings a user
can enter one custom HTTPS Directory, fetch `/api/signing-key`, inspect its
SHA-256 fingerprint and explicitly pin it. Catalog cache, Discord session,
private join codes and play tickets are isolated when the active Directory
changes.

Server status and player count come only from the signed Directory catalog.
There is no per-server `backendUrl`, operator API or grant exchange. The
Directory returns one base64url Ed25519 ticket and the launcher writes it
directly to SkyMP's existing `session` field. `profileId` is optional because
the game server assigns the authoritative local profile.

Private links use:

```text
skymp://join/<code>?directory=<https-url>&fingerprint=<sha256>
```

The signed modpack manifest contains only a Nexus Collection slug, pinned
revision, plugin list, load order and hashes. It never contains archives. The
bundled `vortex-extension/` delegates Nexus login, Collection dependencies,
downloads and FOMOD installation to Vortex. Frostfall then creates one portable
MO2 root per server using hardlinks on the same volume and copies as fallback.

```sh
npm ci
npm run typecheck
npm test
npm run build
```
