import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fromBase64 } from "@atproto/lex-data";
import { SyncEngine } from "./engine";
import { isBoardAbsentError } from "./errors";
import { com } from "../lexicons";

export type SyncServiceOptions = {
  internalUrl: string;
  /** Public base URL the space host calls notifySpaceUpdate on, if enabled. */
  notifyEndpoint?: string;
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
      options.notifyEndpoint,
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
    console.log(`Bulletin internal sync service ${this.#options.internalUrl}`);
  }

  /**
   * Resume syncing watched boards. Call once the public web service is up: a new
   * notify registration is confirmed by the space host calling back through it.
   */
  resume(): void {
    this.#resume();
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
      // The space host calls these without service auth. The token in the body
      // authenticates them, and must be the one registered for the space.
      if (
        request.method === "POST" &&
        url.pathname === "/xrpc/com.atproto.space.confirmRegistration"
      ) {
        const body = await readJson(request);
        const parsed =
          com.atproto.space.confirmRegistration.$input.schema.safeParse(body);
        if (!parsed.success) {
          return json(response, 400, { error: "InvalidRequest" });
        }
        const { space, token, challenge } = parsed.value;
        if (!(await this.#engine.isNotifyToken(space, token))) {
          return json(response, 400, {
            error: "InvalidRequest",
            message: "Unknown registration",
          });
        }
        return json(response, 200, { challenge });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/xrpc/com.atproto.space.notifySpaceUpdate"
      ) {
        const body = await readJson(request);
        const notification = parseSpaceUpdate(body);
        if (!notification) {
          return json(response, 400, { error: "InvalidRequest" });
        }
        const { space, token, update } = notification;
        // Rejecting with a 400 also unregisters a watch that has been dropped.
        if (!(await this.#engine.isNotifyToken(space, token))) {
          return json(response, 400, {
            error: "InvalidRequest",
            message: "Unknown registration",
          });
        }
        const spaceRev = repoUpdateRev(update);
        const task = spaceRev
          ? this.#engine.notify({ space, spaceRev })
          : this.#engine.reauthorize(space);
        json(response, 200, {});
        void task.catch((error) =>
          console.error("notification sync failed", error),
        );
        return;
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

type SpaceUpdate = com.atproto.space.notifySpaceUpdate.$InputBody["update"];

export function parseSpaceUpdate(body: Record<string, unknown>) {
  try {
    const update = body.update as Record<string, unknown> | undefined;
    const data = update?.data as { $bytes?: unknown } | undefined;
    const parsed = com.atproto.space.notifySpaceUpdate.$input.schema.safeParse({
      ...body,
      update:
        data && typeof data.$bytes === "string"
          ? { ...update, data: fromBase64(data.$bytes) }
          : update,
    });
    return parsed.success ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The space revision of a repoWrite or repoRemoved update. Anything else, a
 * spaceDeleted or registrationExpired notice, calls for reauthorizing.
 */
export function repoUpdateRev(update: SpaceUpdate): string | undefined {
  const { repoWrite, repoRemoved } = com.atproto.space.defs;
  if (update.$type === repoWrite.$type || update.$type === repoRemoved.$type) {
    return (update as { spaceRev: string }).spaceRev;
  }
  return undefined;
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
