import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { collectResponse } from "./client";

let server: http.Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

function get(handler: http.RequestListener) {
  server = http.createServer(handler);
  return new Promise<Awaited<ReturnType<typeof collectResponse>>>((resolve, reject) => {
    server!.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      http.get({ host: "127.0.0.1", port }, (res) => resolve(collectResponse(res))).on("error", reject);
    });
  });
}

describe("collectResponse", () => {
  it("parses a normal JSON response", async () => {
    const result = get((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    expect(await result).toEqual({ status: 201, body: { ok: true } });
  });

  it("rejects when the connection is reset after the headers", async () => {
    const result = get((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write('{"par');
      setTimeout(() => res.destroy(), 20);
    });
    await expect(result).rejects.toThrow();
  });
});
