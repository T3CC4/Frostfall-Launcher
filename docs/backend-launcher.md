# Directory launcher contract

Frostfall talks only to one selected SkyMP Directory. It verifies every catalog,
server, join-code and modpack response with the pinned Directory Ed25519 key.

`POST /api/servers/:serverId/play-grants` returns a base64url ticket. Frostfall
stores that exact value in SkyMP's `session` field; no backend exchange exists.

Custom Directories use HTTPS, key discovery at `/api/signing-key`, fingerprint
confirmation and per-Directory state isolation.
