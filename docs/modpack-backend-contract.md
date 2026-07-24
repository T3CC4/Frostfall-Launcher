# Vortex to portable MO2 contract

The Directory publishes Nexus Collection, fixed revision, plugins, load order
and hashes. No service publishes mod archives.

The SkyMP Vortex extension installs through normal Vortex/Nexus flows into
Vortex staging and writes a receipt under
`%APPDATA%\Vortex\skymp\receipts\<serverId>.json`.

Frostfall reads the receipt, creates an isolated portable MO2 root per server,
hardlinks files when possible (copy fallback), generates the Frostfall profile
files and checks Directory hashes before launch. Missing or changed files
require “Repair with Vortex”.
