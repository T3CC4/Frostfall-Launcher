# SkyMP Vortex extension

The extension keeps Nexus authentication, Collection downloads, dependencies and
FOMOD installation in Vortex. It writes only a staging receipt for Frostfall;
it never deploys into the Skyrim instance started by the launcher.

Release installers include this folder under
`resources/vortex-extension`. Install that folder as a Vortex extension. A
`skymp://install` request opens the exact pinned Collection revision; the
receipt is written only after Vortex reports the Collection and its referenced
dependencies as installed.

Frostfall materializes that receipt into one portable MO2 root per server using
hardlinks on the same volume and copies as fallback, then generates the MO2
profile files and verifies the signed Directory hashes.
