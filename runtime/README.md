# Global SkyMP runtime payload

Release builds place the signed, global SkyMP client and portable MO2 runtime
in this directory before `electron-builder` runs. The directory is copied to
the application's resources and never comes from an individual game server or
Directory.

The payload must contain `ModOrganizer.exe` plus the SkyMP/SKSE client files.
At repair time the Launcher hardlinks these files into the selected server's
isolated MO2 root, falling back to copies across filesystems.
