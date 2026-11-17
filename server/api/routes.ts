/** REST API (plan §4). Every error body is {error: {code, message}}. */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import type { Config } from "../config";
import { ServiceError } from "../errors";
import { MEDIA_HEADERS } from "../security/headers";
import type { rateLimiters } from "../security/rateLimit";
import { fileUrl, type SessionService } from "../sessions/service";
import { isSessionId } from "../../src/shared/ids";
import { ID_RE, LIMITS } from "../../src/shared/limits";
import { importSchema, pushSchema } from "../../src/shared/protocol";

const BROWSER = { kind: "browser" as const, name: "A browser" };

const createSchema = z.strictObject({
  title: z
    .string()
    .max(LIMITS.title)
    // eslint-disable-next-line no-control-regex
    .refine((t) => !/[\u0000-\u001f\u007f]/.test(t), "must not contain control characters")
    .optional(),
});

const badRequest = (error: z.ZodError) => {
  const issue = error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "body";
  return new ServiceError(
    400,
    "invalid_request",
    `${where}: ${issue?.message ?? "invalid request"}`,
  );
};

export const apiRouter = (
  cfg: Config,
  service: SessionService,
  limiters: ReturnType<typeof rateLimiters>,
  version: string,
): Router => {
  const r = express.Router();
  const L = cfg.limits;
  const json = (limit: number) => express.json({ limit, type: "application/json" });

  r.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    next();
  });

  r.param("id", (_req, _res, next, id: string) => {
    if (!isSessionId(id))
      return next(
        new ServiceError(404, "session_not_found", "This board does not exist (or was deleted)."),
      );
    next();
  });

  r.get("/health", (_req, res) => {
    res.json({ ok: true, version });
  });

  r.post("/sessions", limiters.sessions, json(16 * 1024), (req, res) => {
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) throw badRequest(body.error);
    const { sessionId } = service.create(body.data.title ?? "");
    res.status(201).json({ session_id: sessionId, url: `/s/${sessionId}` });
  });

  r.get("/sessions/:id", (req, res) => {
    res.json(service.meta(req.params.id as string));
  });

  r.get("/sessions/:id/scene", (req, res) => {
    res.json(service.snapshot(req.params.id as string, { markOpened: true }));
  });

  r.post("/sessions/:id/ops", json(L.opsBodyBytes), (req, res) => {
    const body = pushSchema(L.maxOpsPerPush).safeParse(req.body);
    if (!body.success) throw badRequest(body.error);
    const atomic = req.query.atomic === "1";
    // the answer is an ack, as on the socket: refusals are listed in `rejected`
    // (with ?atomic=1 one refusal means nothing was applied and the rev is unchanged)
    res.json(service.apply(req.params.id as string, body.data, { origin: BROWSER, atomic }).ack);
  });

  r.post("/sessions/:id/import", json(L.importBodyBytes), (req, res) => {
    const body = importSchema.safeParse(req.body);
    if (!body.success) throw badRequest(body.error);
    // atomic: any entry in `rejected` means nothing was imported
    res.json(service.importScene(req.params.id as string, body.data, BROWSER).ack);
  });

  r.post(
    "/sessions/:id/files",
    limiters.uploads,
    express.raw({ type: () => true, limit: L.maxImageBytes }),
    (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const f = service.addFile(req.params.id as string, bytes, req.headers["content-type"]);
      res.status(201).json({
        file_id: f.id,
        url: fileUrl(req.params.id as string, f.id),
        mime: f.mime,
        size: f.size,
        width: f.width,
        height: f.height,
        duration_ms: f.durationMs,
      });
    },
  );

  r.get("/sessions/:id/files/:fileId", (req, res, next) => {
    const fileId = req.params.fileId as string;
    if (!ID_RE.test(fileId))
      throw new ServiceError(404, "file_not_found", "This file does not exist in this board.");
    const { file, path } = service.fileForDownload(req.params.id as string, fileId);
    res.removeHeader("Cache-Control");
    for (const [k, v] of Object.entries(MEDIA_HEADERS)) res.setHeader(k, v);
    res.setHeader("Content-Type", file.mime);
    res.sendFile(
      path,
      { acceptRanges: true, cacheControl: false, lastModified: false, dotfiles: "allow" },
      (err) => {
        if (err && !res.headersSent)
          next(new ServiceError(404, "file_not_found", "The file's bytes are missing."));
      },
    );
  });

  r.delete("/sessions/:id", (req, res) => {
    service.deleteSession(req.params.id as string);
    res.status(204).end();
  });

  r.use((_req, _res, next) => next(new ServiceError(404, "not_found", "No such API route.")));

  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: number; message?: string };
    if (err instanceof ServiceError) {
      res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message, ...err.details } });
    } else if (e.type === "entity.too.large" || e.status === 413) {
      res.status(413).json({
        error: { code: "too_large", message: "The request is larger than this route allows." },
      });
    } else if (e.type === "entity.parse.failed") {
      res
        .status(400)
        .json({ error: { code: "invalid_request", message: "The body is not valid JSON." } });
    } else if (typeof e.status === "number" && e.status >= 400 && e.status < 500) {
      res
        .status(e.status)
        .json({ error: { code: "invalid_request", message: e.message ?? "Bad request." } });
    } else {
      console.error("api error:", (err as Error)?.stack ?? err);
      res
        .status(500)
        .json({ error: { code: "internal", message: "Something went wrong on the server." } });
    }
  });

  return r;
};
