import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Storage } from "@google-cloud/storage";
import { config } from "./config";
import { safeEqual } from "./hmac";

export const SIGNED_URL_TTL_SECONDS = 5 * 60;
export const LOCAL_FILES_ROUTE = "/api/v1/files";

/** PDFs são imutáveis: nunca sobrescreva um objeto. Sem acesso ao banco. */
export interface ObjectStorage {
  putIfAbsent(path: string, bytes: Buffer, contentType: string): Promise<"created" | "exists">;
  read(path: string): Promise<Buffer>;
  signedUrl(path: string): Promise<{ url: string; expiresAt: Date }>;
}

export function documentPath(schoolId: string, batchId: string, documentId: string): string {
  return `schools/${schoolId}/documents/${batchId}/${documentId}.pdf`;
}

function expiry(): Date {
  return new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
}

function gcsStorage(bucketName: string): ObjectStorage {
  const bucket = new Storage().bucket(bucketName);
  return {
    async putIfAbsent(path, bytes, contentType) {
      try {
        await bucket.file(path).save(bytes, { contentType, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
        return "created";
      } catch (err) {
        if ((err as { code?: unknown }).code === 412) return "exists";
        throw err;
      }
    },
    async read(path) {
      const [bytes] = await bucket.file(path).download();
      return bytes;
    },
    async signedUrl(path) {
      // No Cloud Run a assinatura V4 usa a IAM signBlob da própria conta de serviço (docs/deploy.md).
      const expiresAt = expiry();
      const [url] = await bucket.file(path).getSignedUrl({ version: "v4", action: "read", expires: expiresAt, responseType: "application/pdf" });
      return { url, expiresAt };
    },
  };
}

// Disco local (desenvolvimento): URL servida pela própria API, assinada com uma chave derivada de SESSION_SECRET.
function urlKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", config().sessionSecret, "", "app-lanche/local-storage-url/v1", 32));
}

function mac(payload: string): string {
  return createHmac("sha256", urlKey()).update(payload).digest("base64url");
}

export function signLocalToken(path: string, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ p: path, e: Math.floor(expiresAtMs / 1000) })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

/** Caminho do objeto, ou null se o token foi alterado ou venceu. */
export function verifyLocalToken(token: string, nowMs = Date.now()): string | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, mac(payload))) return null;
  try {
    const { p, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { p?: unknown; e?: unknown };
    if (typeof p !== "string" || typeof e !== "number" || e * 1000 < nowMs) return null;
    return p;
  } catch {
    return null;
  }
}

function diskStorage(root: string): ObjectStorage {
  const base = resolve(root);
  const full = (path: string) => {
    const target = resolve(base, path);
    if (!target.startsWith(base + sep)) throw new Error("path outside storage root");
    return target;
  };
  return {
    async putIfAbsent(path, bytes) {
      const target = full(path);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      try {
        // link() falha com EEXIST se o destino existe: criação atômica sem sobrescrever.
        await link(tmp, target);
        return "created";
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw err;
      } finally {
        await rm(tmp, { force: true });
      }
    },
    read: (path) => readFile(full(path)),
    async signedUrl(path) {
      const expiresAt = expiry();
      return { url: `${LOCAL_FILES_ROUTE}?t=${signLocalToken(path, expiresAt.getTime())}`, expiresAt };
    },
  };
}

let cached: ObjectStorage | undefined;

export function storage(): ObjectStorage {
  if (!cached) {
    const c = config().storage;
    cached = c.driver === "gcs" ? gcsStorage(c.bucket) : diskStorage(c.dir);
  }
  return cached;
}

/** Apenas para testes. */
export function resetStorageForTests(): void {
  cached = undefined;
}
