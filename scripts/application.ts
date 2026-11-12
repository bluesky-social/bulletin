import { createServer, type Server } from "node:http";
import next from "next";
import type { Config } from "../lib/config";
import { migrate } from "../lib/db/migrations";
import { publishLexicons } from "../lib/lexicon-publisher";
import { SyncService } from "../lib/sync/service";

class WebService {
  readonly #development: boolean;
  readonly #hostname: string;
  readonly #port: number;
  #next: ReturnType<typeof next> | undefined;
  #server: Server | undefined;

  constructor(config: Config) {
    this.#development = config.development;
    this.#hostname = config.hostname;
    this.#port = config.port;
  }

  async start(): Promise<void> {
    const application = next({
      dev: this.#development,
      hostname: this.#hostname,
      port: this.#port,
      ...(this.#development ? { webpack: true } : {}),
    });
    this.#next = application;
    await application.prepare();
    const handler = application.getRequestHandler();
    const server = createServer((request, response) => {
      void handler(request, response).catch((error) => {
        console.error("Next.js request failed", error);
        if (!response.headersSent) response.writeHead(500);
        if (!response.writableEnded) response.end("Internal server error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.#port, this.#hostname, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.#server = server;
    console.log(
      `Bulletin web service http://${this.#hostname}:${this.#port}`,
    );
  }

  async close(): Promise<void> {
    if (this.#server) {
      const server = this.#server;
      this.#server = undefined;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
    if (this.#next) {
      const application = this.#next;
      this.#next = undefined;
      await application.close();
    }
  }
}

export class BulletinApplication {
  readonly #publishLexicons: boolean;
  readonly #sync: SyncService;
  readonly #web: WebService;
  #closeTask: Promise<void> | undefined;

  constructor(config: Config) {
    this.#publishLexicons = config.publishLexicons;
    this.#sync = new SyncService({
      internalUrl: config.syncInternalUrl,
      notifyEndpoint: config.syncNotifyEndpoint,
      pollInterval: config.syncPollInterval,
    });
    this.#web = new WebService(config);
  }

  async start(): Promise<void> {
    await migrate();
    console.log("database is ready");
    if (this.#publishLexicons) await publishLexicons();
    try {
      await this.#sync.start();
      await this.#web.start();
      this.#sync.resume();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closeTask = this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    await this.#sync.close();
    await this.#web.close();
  }
}
