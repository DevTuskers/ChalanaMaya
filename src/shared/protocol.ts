/**
 * Sync protocol shapes shared by the server and (from phase 2) the browser
 * (plan §3.6). The envelopes are checked with zod; elements inside `put` ops
 * are checked by `validateStoredElement` (strict, never normalising).
 */
import { z } from "zod";
import type { SceneElement } from "../scene/types";
import { ID_RE } from "./limits";
import { PUSH_ID_RE } from "./ids";

const elementId = z.string().regex(ID_RE, "must be an id of 1-64 letters, digits, _ or -");
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const putOpSchema = z.strictObject({
  t: z.literal("put"),
  el: z.unknown(),
  idx: z.string().min(1).max(192),
  baseVersion: version,
  layout: z.literal(true).optional(),
});
export const delOpSchema = z.strictObject({
  t: z.literal("del"),
  id: elementId,
  baseVersion: version,
});
export const settingsOpSchema = z.strictObject({ t: z.literal("settings"), settings: z.unknown() });
export const posterOpSchema = z.strictObject({
  t: z.literal("poster"),
  fileId: elementId,
  posterFileId: elementId,
});
export const fileMetaOpSchema = z.strictObject({
  t: z.literal("fileMeta"),
  fileId: elementId,
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600_000)
    .optional(),
});

export const opSchema = z.discriminatedUnion("t", [
  putOpSchema,
  delOpSchema,
  settingsOpSchema,
  posterOpSchema,
  fileMetaOpSchema,
]);

export type Op =
  | { t: "put"; el: SceneElement; idx: string; baseVersion: number; layout?: true }
  | { t: "del"; id: string; baseVersion: number }
  | {
      t: "settings";
      settings: { viewBackgroundColor?: string; gridEnabled?: boolean; title?: string };
    }
  | { t: "poster"; fileId: string; posterFileId: string }
  | { t: "fileMeta"; fileId: string; width: number; height: number; durationMs?: number };

/** An op as it arrives, before the element and settings are validated. */
export type RawOp = z.infer<typeof opSchema>;

export const pushId = z.string().regex(PUSH_ID_RE, "must be 16-64 base64url characters");

export const pushSchema = (maxOps: number) =>
  z.strictObject({
    pushId,
    baseRev: z.number().int().min(0),
    ops: z.array(opSchema).max(maxOps, `at most ${maxOps} ops per push`),
    mirrored: z.literal(true).optional(),
  });

export const importSchema = z.strictObject({
  importId: pushId,
  mode: z.enum(["replace", "add"]),
  elements: z.array(z.strictObject({ el: z.unknown(), idx: z.string().min(1).max(192) })),
  settings: z.unknown().optional(),
});

export type RejectReason =
  | "invalid"
  | "element_too_large"
  | "deleted"
  | "unknown_file"
  | "scene_too_large"
  | "layout_not_allowed";

export type IgnoreReason =
  "stale_replay" | "layout_done" | "already_deleted" | "not_found" | "poster_set" | "meta_known";

export interface Rejected {
  id: string;
  reason: RejectReason;
  path?: string;
  message?: string;
}

export interface Ack {
  pushId: string;
  rev: number;
  versions: Record<string, number>;
  rejected: Rejected[];
  ignored: { id: string; reason: IgnoreReason }[];
  duplicate?: true;
}

export interface StoredFile {
  id: string;
  mime: string;
  url: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  source: "upload" | "remote";
  posterFileId: string | null;
}

export interface SceneSnapshot {
  rev: number;
  title: string;
  settings: { viewBackgroundColor?: string; gridEnabled?: boolean };
  elements: { el: SceneElement; idx: string; version: number; needsLayout: boolean }[];
  tombstones: { id: string; version: number }[];
  files: StoredFile[];
}
