import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fromBase64 } from "@atproto/lex-data";
import { SyncEngine } from "./engine";
import { isBoardAbsentError } from "./errors";
import { com } from "../lexicons";
import {
  verifySpaceDeletionNotification,
  verifySyncNotification,
} from "./service-auth";

export type SyncServiceOptions = {
  internalUrl: string;
  managingAppService: string;
  pollInterval?: number;
};

export class SyncService {
  readonly #clients = new Map<string, Set<ServerResponse>>();
  readonly #engine: SyncEngine;
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response);
  });
  readonly #options: SyncServiceOptions;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #reconcileTimer: NodeJS.Timeout | undefined;
  #resumeTask: Promise<void> | undefined;
  #started = false;
  #closeTask: Promise<void> | undefined;

  constructor(options: SyncServiceOptions) {
    this.#options = options;
    this.#engine = new SyncEngine(
      (space) => this.#broadcast(space),
      options.managingAppService,
    );
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const url = new URL(this.#options.internalUrl);
    const port = Number(url.port || 80);
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(port, hostname, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });

    this.#started = true;
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), 20_000);
    if (this.#options.pollInterval) {
      this.#reconcileTimer = setInterval(
        () => this.#resume(),
        this.#options.pollInterval,
      );
      this.#reconcileTimer.unref();
    }
    this.#resume();
    console.log(`Bulletin internal sync service ${this.#options.internalUrl}`);
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closeTask = this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#engine.stop();
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    for (const group of this.#clients.values()) {
      for (const client of group) client.end();
    }
    this.#clients.clear();
    if (this.#started) {
      await new Promise<void>((resolve, reject) => {
        this.#server.close((error) => (error ? reject(error) : resolve()));
        this.#server.closeAllConnections();
      });
      this.#started = false;
    }
    await this.#resumeTask?.catch(() => undefined);
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.#options.internalUrl);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/events") {
        const space = url.searchParams.get("space");
        if (!space) return json(response, 400, { error: "Missing board" });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write(": connected\n\n");
        const group = this.#clients.get(space) ?? new Set<ServerResponse>();
        group.add(response);
        this.#clients.set(space, group);
        request.on("close", () => {
          group.delete(response);
          if (group.size === 0) this.#clients.delete(space);
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/watch") {
        const body = await readJson(request);
        if (typeof body.space !== "string") {
          return json(response, 400, { error: "Invalid board subscription" });
        }
        try {
          await this.#engine.watch(body.space);
        } catch (error) {
          if (isBoardAbsentError(error)) {
            return json(response, 404, { error: "Board not found" });
          }
          throw error;
        }
        return json(response, 200, { ok: true });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/xrpc/com.atproto.space.notifyWrite"
      ) {
        const body = await readJson(request);
        const notification = parseWriteNotification(body);
        if (!notification) {
          return json(response, 400, { error: "Invalid notification" });
        }
        const authorization = Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : request.headers.authorization;
        await verifySyncNotification(authorization, notification.space);
        json(response, 200, {});
        void this.#engine
          .notify(notification)
          .catch((error) => console.error("notification sync failed", error));
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/xrpc/com.atproto.space.notifySpaceDeleted"
      ) {
        const body = await readJson(request);
        if (typeof body.space !== "string") {
          return json(response, 400, { error: "Invalid notification" });
        }
        const authorization = Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : request.headers.authorization;
        await verifySpaceDeletionNotification(authorization, body.space);
        await this.#engine.deleteSpace(body.space, { waitForRemoval: true });
        return json(response, 200, {});
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      console.error("sync service request failed", error);
      return json(response, 500, { error: "Sync failed" });
    }
  }

  #resume(): void {
    if (this.#resumeTask) return;
    const task = this.#engine.resume();
    this.#resumeTask = task;
    void task
      .catch((error) => console.error("sync reconciliation failed", error))
      .finally(() => {
        if (this.#resumeTask === task) this.#resumeTask = undefined;
      });
  }

  #heartbeat(): void {
    for (const group of this.#clients.values()) {
      for (const client of group) client.write(": keepalive\n\n");
    }
  }

  #broadcast(space: string): void {
    const payload = `data: ${JSON.stringify({ space })}\n\n`;
    for (const client of this.#clients.get(space) ?? []) client.write(payload);
  }
}

export function parseWriteNotification(body: Record<string, unknown>) {
  try {
    const hash = body.hash as { $bytes?: unknown } | undefined;
    if (!hash || typeof hash.$bytes !== "string") return undefined;
    const parsed = com.atproto.space.notifyWrite.$input.schema.safeParse({
      ...body,
      hash: fromBase64(hash.$bytes),
    });
    if (!parsed.success || !parsed.value.spaceRev) return undefined;
    return { ...parsed.value, spaceRev: parsed.value.spaceRev };
  } catch {
    return undefined;
  }
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("Request body too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
