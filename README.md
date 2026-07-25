# Frostfall / SkyMP Launcher

Launcher for the self-hostable SkyMP Directory contract.

The official Directory URL and Ed25519 key are preinstalled. In Settings a user
can enter one custom HTTPS Directory, fetch `/api/signing-key`, inspect its
SHA-256 fingerprint and explicitly pin it. Catalog cache, Discord session,
private join codes and play tickets are isolated when the active Directory
changes.

Server status and player count come only from the signed Directory catalog.
There is no operator API or grant exchange. The
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

A server may additionally publish a mandatory Client Pack binding in its
Directory-signed descriptor. Frostfall downloads the manifest and ZIP directly
from that exact signed address and Client Pack port without following
redirects. It verifies the Directory manifest hash, the server's Ed25519
identity signature, the archive hash and every file before atomically replacing
the `SkyMP Server Client Pack` mod in that server's portable MO2 root. The mod
is always last in `modlist.txt`; receipts and active files are never shared
between servers.

Client Pack JavaScript has full Skyrim Platform and Node.js rights. Frostfall
therefore displays the server name, pack version and server-key fingerprint
with a full-trust warning before every download and every game start. Cancelling
the warning performs neither action.

```sh
npm ci
npm run typecheck
npm test
npm run build
```
