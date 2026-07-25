import { z } from "zod";

export const serverSchema = z
  .object({
    key: z.string().min(1).max(100),
    contract: z.literal("directory-managed"),
    name: z.string().min(1).max(120),
    address: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535),
    description: z.string().max(2000).default(""),
    region: z.string().max(100).default(""),
    tags: z.array(z.string().max(100)).max(50).default([]),
    versions: z.record(z.string(), z.string()).default({}),
    visibility: z.enum(["public", "private"]).default("public"),
    status: z
      .object({
        state: z.string(),
        online: z.coerce.number().int().nonnegative(),
        maxPlayers: z.coerce.number().int().positive(),
      })
      .default({ state: "offline", online: 0, maxPlayers: 1 }),
    lastHeartbeatAt: z.coerce.number().nonnegative().default(0),
    source: z.enum(["directory", "private"]).default("directory"),
    stale: z.boolean().default(false),
    listed: z.boolean().default(true),
    access: z
      .object({
        discordGuild: z
          .object({
            required: z.boolean(),
            guildId: z.string().optional(),
            inviteUrl: z.string().url().optional(),
          })
          .optional(),
      })
      .optional(),
    resourcesPort: z.coerce.number().int().min(1).max(65535).optional(),
    modpack: z
      .object({
        collection: z.object({
          game: z.literal("skyrimspecialedition"),
          slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
          revision: z.number().int().positive(),
        }),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
        modCount: z.number().int().positive().max(5000),
      })
      .optional(),
    identity: z.object({
      algorithm: z.literal("Ed25519"),
      publicKey: z.string().min(40).max(500),
      fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    }),
    clientPack: z
      .object({
        port: z.number().int().min(1).max(65535),
        version: z.string().min(1).max(100),
        clientApiVersion: z.literal(1),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
  })
  .passthrough();

export const manifestFileSchema = z.object({
  path: z.string().min(1).max(500),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const clientManifestSchema = z.object({
  schemaVersion: z.literal(1),
  serverId: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  clientApiVersion: z.literal(1),
  permission: z.literal("full-skyrim-platform"),
  entrypoint: z.literal("Platform/Plugins/skymp-server-extension.js"),
  ui: z.string().max(500).optional(),
  archive: z.object({
    format: z.literal("zip"),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }),
  files: z.array(manifestFileSchema).min(1).max(10000),
  signature: z.object({
    algorithm: z.literal("Ed25519"),
    value: z.string().min(40),
  }),
});

export const modpackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  collection: z.object({
    game: z.literal("skyrimspecialedition"),
    slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
    revision: z.number().int().positive(),
  }),
  mods: z
    .array(
      z.object({
        key: z.string().regex(/^nexus:\d+:\d+$/),
        name: z.string().min(1).max(300),
        version: z.string().min(1).max(100),
        nexus: z.object({
          modId: z.number().int().positive(),
          fileId: z.number().int().positive(),
        }),
        installOrder: z.number().int().nonnegative(),
        treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
        plugins: z.array(z.string().min(1).max(260)).max(500),
      }),
    )
    .min(1)
    .max(5000),
  plugins: z.array(
    z.object({
      name: z.string().min(1).max(260),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      masters: z.array(z.string().min(1).max(260)).max(500),
    }),
  ),
  loadOrder: z.array(z.string().min(1).max(260)).max(5000),
});

export const settingsPatchSchema = z
  .object({
    skyrimPath: z.string().max(500).optional(),
    activeServerKey: z.string().max(100).optional(),
    locale: z.enum(["en", "de"]).optional(),
    onboardingVersion: z.number().int().min(0).max(100).optional(),
    launchAtLogin: z.boolean().optional(),
    closeBehavior: z.enum(["exit", "tray"]).optional(),
    afterLaunch: z.enum(["keep", "minimize", "close"]).optional(),
    reduceMotion: z.boolean().optional(),
  })
  .strict();

export const serverKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/);
export const externalUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === "https:", "HTTPS required");
