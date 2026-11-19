import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentPath, signLocalToken, storage, verifyLocalToken } from "./storage";

const id = () => crypto.randomUUID();

describe("local storage", () => {
  it("writes once and never overwrites", async () => {
    const path = documentPath(id(), id(), id());
    expect(path).toMatch(/^schools\/[0-9a-f-]+\/documents\/[0-9a-f-]+\/[0-9a-f-]+\.pdf$/);
    expect(await storage().putIfAbsent(path, Buffer.from("first"), "application/pdf")).toBe("created");
    expect(await storage().putIfAbsent(path, Buffer.from("second"), "application/pdf")).toBe("exists");
    expect((await storage().read(path)).toString()).toBe("first");
  });

  it("refuses a path outside the storage root", async () => {
    await expect(storage().putIfAbsent("../escape.pdf", Buffer.from("x"), "application/pdf")).rejects.toThrow(/outside/);
  });

  it("signs a 5-minute URL whose token verifies only intact and unexpired", async () => {
    const path = documentPath(id(), id(), id());
    const { url, expiresAt } = await storage().signedUrl(path);
    expect(url).toMatch(/^\/api\/v1\/files\?t=/);
    const minutes = (expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4.9);
    expect(minutes).toBeLessThanOrEqual(5);
    const token = new URL(url, "https://x").searchParams.get("t")!;
    expect(verifyLocalToken(token)).toBe(path);
    expect(verifyLocalToken(token, Date.now() + 6 * 60_000)).toBeNull();
    const [payload, sig] = token.split(".");
    const other = Buffer.from(JSON.stringify({ p: "schools/x/documents/y/z.pdf", e: 9_999_999_999 })).toString("base64url");
    expect(verifyLocalToken(`${other}.${sig}`)).toBeNull();
    expect(verifyLocalToken(`${payload}.${createHash("sha256").update("x").digest("base64url")}`)).toBeNull();
    expect(verifyLocalToken("garbage")).toBeNull();
    expect(verifyLocalToken(signLocalToken(path, Date.now() - 1))).toBeNull();
  });
});
