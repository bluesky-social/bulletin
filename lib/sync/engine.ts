import { parseCid } from "@atproto/lex-data";
import { asStringFormat } from "@atproto/lex-schema";
import {
  RepoCommit,
  RepoVerificationError,
  verifyCommit,
  verifyRepoStarFull,
  type Commit,
} from "@atproto/space";
import {
  REMOVAL_COLLECTION,
  POSITION_COLLECTION,
  POST_COLLECTION,
  boardUri,
} from "../config";
import {
  applySyncedChanges,
  deleteSyncedReposExcept,
  deleteSyncedSpace,
  getSyncedRepo,
  hideSyncedSpace,
  listSpaceWatches,
  replaceRepoRecords,
  saveBoard,
  saveSpaceWatch,
  saveSyncedRepo,
  updateSpaceWatch,
  type SpaceWatch,
  type SpaceBlob,
  type SyncedChange,
} from "../db/queries";
import { getOAuthClient, listStoredSessionDids } from "../auth/client";
import { isNoteColor, isNoteRotation } from "../note-style";
import { parseNoteImage } from "../note-image";
import { isBoardCoordinate } from "../note-constraints";
import { readBlobFile, storeBlobFile } from "../blob-store";
import { com } from "../lexicons";
import { resolvePds } from "../atproto/identity";
import { getFollowersAmong } from "../atproto/follows";
import {
  mintSpaceCredential,
  type SpaceCredential,
} from "../atproto/space-credential";
import { orderCredentialCandidates } from "./credential-candidates";
import { walkSpaceRepos } from "./list-repos";
import {
  isSpaceDeletedError,
  isCredentialRejectedError,
  isSpaceNotFoundError,
  WatchInvalidatedError,
} from "./errors";
import {
  REGISTRATION_RETRY_MS,
  registrationRenewalDelay,
} from "./registration";

type NotifyInput = {
  space: string;
  repo: string;
  repoRev: string;
  spaceRev: string;
  prevSpaceRev?: string;
};
type OnChange = (space: string) => void;
type SyncedBlob = SpaceBlob & { bytes: Uint8Array };

export class SyncEngine {
  private credentials = new Map<string, SpaceCredential>();
  private jobs = new Map<string, Promise<void>>();
  private reconciliations = new Map<string, Promise<void>>();
  private removals = new Map<string, Promise<void>>();
  private spaceGenerations = new Map<string, number>();
  private watchGenerations = new WeakMap<SpaceWatch, number>();
  private maintenanceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly onChange: OnChange,
    private readonly managingAppService: string,
  ) {}

  async resume(): Promise<void> {
    const generations = new Map(this.spaceGenerations);
    const watches = await listSpaceWatches();
    await Promise.all(
      watches.map(async (watch) => {
        if (
          this.removals.has(watch.spaceUri) ||
          (this.spaceGenerations.get(watch.spaceUri) ?? 0) !==
            (generations.get(watch.spaceUri) ?? 0)
        ) {
          return;
        }
        this.bindWatch(watch);
        try {
          await this.refreshWatch(watch);
        } catch (error) {
          if (isSpaceDeletedError(error)) return;
          if (isInvalidWatchError(error)) {
            await this.removeWatch(watch);
            return;
          }
          if (this.isWatchInactive(watch)) return;
          this.scheduleReconcileRetry(watch);
          await this.recordError(watch.spaceUri, error);
        }
      }),
    );
  }

  async watch(space: string): Promise<void> {
    await this.removals.get(space);
    const authorityDid = authorityFromSpace(space);
    if (space !== boardUri(authorityDid)) {
      throw new WatchInvalidatedError();
    }
    const generation = this.spaceGenerations.get(space) ?? 0;
    const existing = (await listSpaceWatches()).find(
      (item) => item.spaceUri === space,
    );
    if (
      this.removals.has(space) ||
      generation !== (this.spaceGenerations.get(space) ?? 0)
    ) {
      throw new WatchInvalidatedError();
    }
    const watch: SpaceWatch =
      existing ?? {
        spaceUri: space,
        authorityDid,
        spaceRev: null,
        registrationExpiresAt: null,
        lastError: null,
      };
    this.bindWatch(watch);
    try {
      await this.assertBulletinSpace(watch);
    } catch (error) {
      if (isInvalidWatchError(error)) {
        if (existing) await this.removeWatch(watch);
        throw new WatchInvalidatedError();
      }
      throw error;
    }
    this.assertWatchActive(watch);
    const newlyInserted = !existing;
    if (newlyInserted) {
      await saveSpaceWatch({ spaceUri: space, authorityDid });
      if (this.isWatchInactive(watch)) {
        await this.startWatchRemoval(space);
        throw new WatchInvalidatedError();
      }
    }
    try {
      await this.runReconcile(watch);
      this.assertWatchActive(watch);
    } catch (error) {
      if (isSpaceNotFoundError(error)) {
        await this.removeWatch(watch);
        throw error;
      }
      if (isSpaceDeletedError(error)) throw error;
      if (this.isWatchInactive(watch)) throw error;
      this.scheduleReconcileRetry(watch);
      await this.recordError(watch.spaceUri, error);
      throw error;
    }
  }

  async notify(input: NotifyInput): Promise<void> {
    if (this.removals.has(input.space)) return;
    const generation = this.spaceGenerations.get(input.space) ?? 0;
    const watch = (await listSpaceWatches()).find(
      (item) => item.spaceUri === input.space,
    );
    if (
      !watch ||
      this.removals.has(input.space) ||
      generation !== (this.spaceGenerations.get(input.space) ?? 0)
    ) {
      return;
    }
    this.watchGenerations.set(watch, generation);
    if (watch.spaceRev && input.spaceRev <= watch.spaceRev) return;
    // Always catch up from our durable checkpoint. This covers prevSpaceRev gaps
    // and out-of-order deliveries without trusting a notification as a checkpoint.
    try {
      await this.runReconcile(watch, true);
    } catch (error) {
      if (!this.isWatchInactive(watch)) {
        this.scheduleReconcileRetry(watch);
        await this.recordError(watch.spaceUri, error);
      }
      throw error;
    }
  }

  async deleteSpace(
    space: string,
    { waitForRemoval = false }: { waitForRemoval?: boolean } = {},
  ): Promise<void> {
    this.invalidateWatches(space);
    this.credentials.delete(space);
    const timer = this.maintenanceTimers.get(space);
    if (timer) clearTimeout(timer);
    this.maintenanceTimers.delete(space);
    await hideSyncedSpace(space);
    const removal = this.startWatchRemoval(space);
    if (waitForRemoval) {
      await removal;
    } else {
      void removal.catch((error) => {
        console.error(`could not delete synced space ${space}`, error);
      });
    }
  }

  stop(): void {
    for (const timer of this.maintenanceTimers.values()) clearTimeout(timer);
    this.maintenanceTimers.clear();
  }

  private async runReconcile(watch: SpaceWatch, catchUpOnly = false): Promise<void> {
    const previous = this.reconciliations.get(watch.spaceUri) ?? Promise.resolve();
    // Queue another pass if a notification arrives during the final listing.
    const task = previous
      .catch(() => undefined)
      .then(() => this.reconcile(watch, catchUpOnly));
    this.reconciliations.set(watch.spaceUri, task);
    try {
      await task;
    } finally {
      if (this.reconciliations.get(watch.spaceUri) === task) {
        this.reconciliations.delete(watch.spaceUri);
      }
    }
  }

  private async refreshWatch(watch: SpaceWatch): Promise<void> {
    await this.assertBulletinSpace(watch);
    await this.runReconcile(watch);
  }

  private async reconcile(watch: SpaceWatch, catchUpOnly: boolean): Promise<void> {
    if (this.isWatchInactive(watch)) return;
    await this.withCredential(watch, async (credential) => {
      let changed = false;
      const authorityPds = await resolvePds(watch.authorityDid);
      const authorityClient = credential.client(authorityPds, watch.authorityDid);
      let registrationExpiresAt = watch.registrationExpiresAt;
      if (registrationNeedsRenewal(watch.registrationExpiresAt)) {
        const registered = await authorityClient.call(
          com.atproto.space.registerNotify,
          {
            space: asStringFormat(watch.spaceUri, "space-ref"),
            service: this.managingAppService,
          },
        );
        registrationExpiresAt = registered.expiresAt;
        if (this.isWatchInactive(watch)) return;
        await updateSpaceWatch({
          spaceUri: watch.spaceUri,
          registrationExpiresAt,
          lastError: null,
        });
      }
      if (registrationExpiresAt) {
        this.scheduleRegistrationRenewal(watch, registrationExpiresAt);
      }

      // Reload inside the serialized pass: another notification may have advanced it.
      const checkpoint =
        (await listSpaceWatches()).find(
          (item) => item.spaceUri === watch.spaceUri,
        )?.spaceRev ?? undefined;
      const listAndSync = (cursor?: string) =>
        walkSpaceRepos(
          (cursor) => authorityClient.call(com.atproto.space.listRepos, {
            space: asStringFormat(watch.spaceUri, "space-ref"),
            limit: 1000,
            cursor,
          }),
          async (repo) => {
            this.assertWatchActive(watch);
            let local = await getSyncedRepo(watch.spaceUri, repo.did);
            if (!local || local.rev < repo.repoRev) {
              await this.enqueue(watch.spaceUri, repo.did, () =>
                this.syncRepoWithCredential(watch, repo.did, credential),
              );
              changed = true;
              local = await getSyncedRepo(watch.spaceUri, repo.did);
            }
            if (!local || local.rev < repo.repoRev) {
              throw new Error("Repo host has not reached the listed revision");
            }
          },
          cursor,
        );
      let listing = await listAndSync(checkpoint);
      // Keep the existing periodic inventory/pruning behavior. Incremental pages
      // alone cannot tell us which writers have been removed from the space.
      if (!catchUpOnly && checkpoint) listing = await listAndSync();

      if (this.isWatchInactive(watch)) return;
      if (!catchUpOnly || !checkpoint) {
        changed =
          (await deleteSyncedReposExcept(watch.spaceUri, listing.dids)) || changed;
      }
      if (this.isWatchInactive(watch)) return;
      await saveBoard(watch.spaceUri, watch.authorityDid);
      // Repo records and revisions are durable before this checkpoint is saved.
      // A crash before here only repeats idempotent work on restart.
      await updateSpaceWatch({
        spaceUri: watch.spaceUri,
        spaceRev: listing.cursor,
        lastError: null,
      });
      if (changed) this.onChange(watch.spaceUri);
    });
  }

  private async assertBulletinSpace(watch: SpaceWatch): Promise<void> {
    if (watch.spaceUri !== boardUri(watch.authorityDid)) {
      throw new InvalidBulletinSpaceError();
    }
    // Minting a credential shows the board exists before it is watched.
    await this.withCredential(watch, async () => undefined);
  }

  private async removeWatch(watch: SpaceWatch): Promise<void> {
    if (this.isWatchInactive(watch)) {
      await this.removals.get(watch.spaceUri);
      return;
    }
    const { spaceUri } = watch;
    this.invalidateWatches(spaceUri);
    this.credentials.delete(spaceUri);
    const timer = this.maintenanceTimers.get(spaceUri);
    if (timer) clearTimeout(timer);
    this.maintenanceTimers.delete(spaceUri);
    await this.startWatchRemoval(spaceUri);
  }

  private startWatchRemoval(space: string): Promise<void> {
    const existing = this.removals.get(space);
    if (existing) return existing;
    const removal = this.finishWatchRemoval(space);
    this.removals.set(space, removal);
    void removal.then(
      () => {
        if (this.removals.get(space) === removal) this.removals.delete(space);
      },
      () => {
        if (this.removals.get(space) === removal) this.removals.delete(space);
      },
    );
    return removal;
  }

  private async finishWatchRemoval(space: string): Promise<void> {
    const reconcileJob = this.reconciliations.get(space);
    const repoJobs = [...this.jobs.entries()]
      .filter(([key]) => key.startsWith(`${space}|`))
      .map(([, job]) => job);
    await Promise.allSettled([
      ...(reconcileJob ? [reconcileJob] : []),
      ...repoJobs,
    ]);
    await deleteSyncedSpace(space);
    this.onChange(space);
  }

  private bindWatch(watch: SpaceWatch): void {
    this.watchGenerations.set(
      watch,
      this.spaceGenerations.get(watch.spaceUri) ?? 0,
    );
  }

  private invalidateWatches(space: string): void {
    this.spaceGenerations.set(space, (this.spaceGenerations.get(space) ?? 0) + 1);
  }

  private isWatchInactive(watch: SpaceWatch): boolean {
    return (
      this.watchGenerations.get(watch) !==
        (this.spaceGenerations.get(watch.spaceUri) ?? 0)
    );
  }

  private assertWatchActive(watch: SpaceWatch): void {
    if (this.isWatchInactive(watch)) {
      throw new WatchInvalidatedError();
    }
  }

  private async renewRegistration(watch: SpaceWatch): Promise<void> {
    await this.withCredential(watch, async (credential) => {
      const authorityPds = await resolvePds(watch.authorityDid);
      const authorityClient = credential.client(authorityPds, watch.authorityDid);
      const registered = await authorityClient.call(
        com.atproto.space.registerNotify,
        {
          space: asStringFormat(watch.spaceUri, "space-ref"),
          service: this.managingAppService,
        },
      );
      if (this.isWatchInactive(watch)) return;
      await updateSpaceWatch({
        spaceUri: watch.spaceUri,
        registrationExpiresAt: registered.expiresAt,
        lastError: null,
      });
      this.scheduleRegistrationRenewal(watch, registered.expiresAt);
    });
  }

  private scheduleRegistrationRenewal(
    watch: SpaceWatch,
    expiresAt: string,
  ): void {
    this.scheduleMaintenance(
      watch,
      registrationRenewalDelay(expiresAt),
      "renew",
    );
  }

  private scheduleReconcileRetry(watch: SpaceWatch): void {
    if (this.isWatchInactive(watch)) return;
    this.scheduleMaintenance(watch, REGISTRATION_RETRY_MS, "reconcile");
  }

  private scheduleMaintenance(
    watch: SpaceWatch,
    delay: number,
    task: "renew" | "reconcile",
  ): void {
    if (this.isWatchInactive(watch)) return;
    const existing = this.maintenanceTimers.get(watch.spaceUri);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.maintenanceTimers.delete(watch.spaceUri);
      const operation = task === "reconcile"
        ? this.refreshWatch(watch)
        : this.renewRegistration(watch);
      void operation
        .catch(async (error) => {
          if (isSpaceDeletedError(error)) return;
          if (isInvalidWatchError(error)) {
            await this.removeWatch(watch);
            return;
          }
          if (this.isWatchInactive(watch)) return;
          this.scheduleReconcileRetry(watch);
          await this.recordError(watch.spaceUri, error);
        })
        .catch((error) => console.error("could not record sync error", error));
    }, delay);
    timer.unref();
    this.maintenanceTimers.set(watch.spaceUri, timer);
  }

  private async syncRepoWithCredential(
    watch: SpaceWatch,
    repoDid: string,
    credential: SpaceCredential,
  ): Promise<void> {
    if (this.isWatchInactive(watch)) return;
    const local = await getSyncedRepo(watch.spaceUri, repoDid);
    if (!local) {
      await this.recoverRepo(watch, repoDid, credential);
      return;
    }

    try {
      const client = credential.client(local.pdsUrl, repoDid);
      const state = RepoCommit.fromState(local.ltHash);
      const changes: SyncedChange[] = [];
      let cursor: string | undefined;
      let commit: Commit | undefined;
      let commitMac: { sharedSecret: Uint8Array; mac: Uint8Array } | undefined;

      do {
        const macRequest = await credential.requestCommitMac(repoDid);
        const response = await client.xrpc(com.atproto.space.listRepoOps, {
          params: {
            space: asStringFormat(watch.spaceUri, "space-ref"),
            repo: asStringFormat(repoDid, "did"),
            since: local.rev,
            cursor,
            limit: 1000,
          },
          headers: macRequest.headers,
        });
        const page = response.body;
        for (const op of page.ops) {
          state.applyOp({
            collection: op.collection,
            rkey: op.rkey,
            cid: op.cid ? parseCid(op.cid) : null,
            prev: op.prev ? parseCid(op.prev) : null,
          });
          const change = parseChange({
            space: watch.spaceUri,
            repoDid,
            collection: op.collection,
            rkey: op.rkey,
            cid: op.cid,
            value: op.value,
          });
          if (change) changes.push(change);
        }
        cursor = page.cursor;
        if (page.commit) {
          commit = asCommit(page.commit);
          commitMac = macRequest.params(response.headers);
        }
      } while (cursor);

      if (!commit || !commitMac) {
        throw new Error("Incremental sync did not reach a commit");
      }
      const valid = verifyCommit(commit, {
        space: watch.spaceUri,
        repo: repoDid,
        ...commitMac,
      });
      if (!valid || !state.matches(commit)) {
        throw new Error("Incremental sync hash mismatch");
      }

      const blobs = await this.fetchImageBlobs(
        changes,
        local.pdsUrl,
        credential,
      );
      if (this.isWatchInactive(watch)) return;
      await applySyncedChanges(changes, stripBlobBytes(blobs));
      storeBlobFiles(blobs);
      await saveSyncedRepo({
        spaceUri: watch.spaceUri,
        repoDid,
        pdsUrl: local.pdsUrl,
        rev: commit.rev,
        ltHash: state.setHash.state(),
        commitHash: commit.data,
      });
    } catch (error) {
      if (this.isWatchInactive(watch)) return;
      if (isCredentialRejectedError(error)) throw error;
      console.warn(`incremental sync fell back to recovery for ${repoDid}`, error);
      await this.recoverRepo(watch, repoDid, credential);
    }
  }

  private async recoverRepo(
    watch: SpaceWatch,
    repoDid: string,
    credential: SpaceCredential,
  ): Promise<void> {
    const space = watch.spaceUri;
    const pdsUrl = await resolvePds(repoDid);
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.space.getRepo`);
    url.searchParams.set("space", space);
    url.searchParams.set("repo", repoDid);
    let recovered: Awaited<ReturnType<typeof verifyRepoStarFull>> | undefined;
    // A repo that fails verification may be MACed with a rotated KEM key, so
    // re-resolve the key and retry once with a new key share.
    for (let attempt = 0; !recovered; attempt++) {
      const macRequest = await credential.requestCommitMac(repoDid, attempt > 0);
      const response = await credential.fetch(url, repoDid, {
        headers: macRequest.headers,
      });
      if (!response.ok) {
        throw new Error(`Repo recovery failed (${response.status})`);
      }
      try {
        recovered = await verifyRepoStarFull(
          [new Uint8Array(await response.arrayBuffer())],
          { space, repo: repoDid, ...macRequest.params(response.headers) },
        );
      } catch (error) {
        if (attempt > 0 || !(error instanceof RepoVerificationError)) throw error;
      }
    }
    const posts: Parameters<typeof replaceRepoRecords>[0]["posts"] = [];
    const removals: Parameters<typeof replaceRepoRecords>[0]["removals"] = [];
    const positions: Parameters<typeof replaceRepoRecords>[0]["positions"] = [];
    const postChanges: Extract<SyncedChange, { kind: "post" }>[] = [];

    for (const record of recovered.records) {
      const change = parseChange({
        space,
        repoDid,
        collection: record.collection,
        rkey: record.rkey,
        cid: record.cid.toString(),
        value: record.record,
      });
      if (change?.kind === "post") {
        postChanges.push(change);
        posts.push(stripPost(change.value));
      }
      if (change?.kind === "removal") {
        removals.push(stripRemoval(change.value));
      }
      if (change?.kind === "position") positions.push(stripPosition(change.value));
    }

    const blobs = await this.fetchImageBlobs(postChanges, pdsUrl, credential);
    if (this.isWatchInactive(watch)) return;
    await replaceRepoRecords({
      spaceUri: space,
      authorDid: repoDid,
      posts,
      removals,
      positions,
      blobs: stripBlobBytes(blobs),
    });
    storeBlobFiles(blobs);
    await saveSyncedRepo({
      spaceUri: space,
      repoDid,
      pdsUrl,
      rev: recovered.commit.rev,
      ltHash: RepoCommit.fromRecords(recovered.records).setHash.state(),
      commitHash: recovered.commit.data,
    });
  }

  private async fetchImageBlobs(
    changes: SyncedChange[],
    pdsUrl: string,
    credential: SpaceCredential,
  ): Promise<SyncedBlob[]> {
    const blobs = new Map<string, SyncedBlob>();
    const finalPostChanges: Extract<SyncedChange, { kind: "post" }>[] = [];
    const seenUris = new Set<string>();
    for (let index = changes.length - 1; index >= 0; index--) {
      const change = changes[index];
      if (change.kind === "post") {
        if (!seenUris.has(change.value.uri)) finalPostChanges.push(change);
        seenUris.add(change.value.uri);
      } else if (change.kind === "delete" && change.table === "post") {
        seenUris.add(change.uri);
      }
    }

    for (const change of finalPostChanges) {
      if (change.kind !== "post" || !change.value.image) continue;
      const { image, spaceUri, authorDid } = change.value;
      const key = `${spaceUri}\u0000${authorDid}\u0000${image.cid}`;
      const prior = blobs.get(key);
      if (prior) {
        if (prior.mimeType !== image.mimeType || prior.size !== image.size) {
          throw new Error("Conflicting image metadata for the same blob");
        }
        continue;
      }

      let bytes = readBlobFile(image.cid) ?? undefined;
      if (!bytes || bytes.length !== image.size) {
        bytes = await credential.client(pdsUrl, authorDid).call(
          com.atproto.space.getBlob,
          {
            space: asStringFormat(spaceUri, "space-ref"),
            repo: asStringFormat(authorDid, "did"),
            cid: image.cid,
          },
        );
      }
      if (bytes.length !== image.size) {
        throw new Error(`Image blob had an unexpected size (${image.cid})`);
      }
      blobs.set(key, {
        spaceUri,
        repoDid: authorDid,
        cid: image.cid,
        mimeType: image.mimeType,
        size: image.size,
        bytes,
      });
    }
    return [...blobs.values()];
  }

  private async withCredential<T>(
    watch: SpaceWatch,
    operation: (credential: SpaceCredential) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let credential: SpaceCredential;
      try {
        credential = await this.credentialFor(watch, attempt > 0);
      } catch (error) {
        if (isSpaceDeletedError(error)) await this.deleteSpace(watch.spaceUri);
        throw error;
      }
      try {
        return await operation(credential);
      } catch (error) {
        if (isSpaceDeletedError(error)) {
          await this.deleteSpace(watch.spaceUri);
          throw error;
        }
        if (isSpaceNotFoundError(error)) throw error;
        this.credentials.delete(watch.spaceUri);
        if (attempt > 0) throw error;
      }
    }
    throw new Error("Could not obtain a board sync credential");
  }

  private async credentialFor(
    watch: SpaceWatch,
    refresh = false,
  ): Promise<SpaceCredential> {
    if (!refresh) {
      const existing = this.credentials.get(watch.spaceUri);
      if (existing && !existing.needsRefresh()) return existing;
      this.credentials.delete(watch.spaceUri);
    }
    const sessionDids = await listStoredSessionDids();
    const oauthClient = await getOAuthClient();
    let lastError: unknown;

    if (sessionDids.includes(watch.authorityDid)) {
      try {
        const session = await oauthClient.restore(watch.authorityDid);
        const credential = await mintSpaceCredential(session, watch.spaceUri);
        this.credentials.set(watch.spaceUri, credential);
        return credential;
      } catch (error) {
        if (isSpaceDeletedError(error) || isSpaceNotFoundError(error)) {
          throw error;
        }
        lastError = error;
        console.warn(
          `could not mint sync credential for ${watch.authorityDid}`,
          error,
        );
      }
    }

    const otherDids = sessionDids.filter((did) => did !== watch.authorityDid);
    const followers = await getFollowersAmong(watch.authorityDid, otherDids);
    const candidates = orderCredentialCandidates(
      watch.authorityDid,
      otherDids,
      followers,
    );

    for (const did of candidates) {
      try {
        const session = await oauthClient.restore(did);
        const credential = await mintSpaceCredential(session, watch.spaceUri);
        this.credentials.set(watch.spaceUri, credential);
        return credential;
      } catch (error) {
        if (isSpaceDeletedError(error) || isSpaceNotFoundError(error)) {
          throw error;
        }
        lastError = error;
        console.warn(`could not mint sync credential for ${did}`, error);
      }
    }

    throw lastError ?? new Error("No authorized OAuth session can sync this board");
  }

  private enqueue(space: string, repo: string, job: () => Promise<void>): Promise<void> {
    const key = `${space}|${repo}`;
    const previous = this.jobs.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(job);
    this.jobs.set(key, next);
    const cleanup = () => {
      if (this.jobs.get(key) === next) this.jobs.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private async recordError(space: string, error: unknown): Promise<void> {
    console.error(`sync failed for ${space}`, error);
    await updateSpaceWatch({
      spaceUri: space,
      lastError: error instanceof Error ? error.message : "Sync failed",
    });
  }
}

class InvalidBulletinSpaceError extends Error {
  constructor() {
    super("Space is not managed by Bulletin");
    this.name = "InvalidBulletinSpaceError";
  }
}

function isInvalidWatchError(error: unknown): boolean {
  return (
    error instanceof InvalidBulletinSpaceError || isSpaceNotFoundError(error)
  );
}

export function parseChange(input: {
  space: string;
  repoDid: string;
  collection: string;
  rkey: string;
  cid: string | null;
  value?: unknown;
}): SyncedChange | undefined {
  const uri = `${input.space}/${input.repoDid}/${input.collection}/${input.rkey}`;
  const table = tableForCollection(input.collection);
  const deletion = table
    ? {
        kind: "delete" as const,
        table,
        uri,
        spaceUri: input.space,
        authorDid: input.repoDid,
      }
    : undefined;
  if (!input.cid) return deletion;
  if (!input.value || typeof input.value !== "object") return deletion;
  const value = input.value as Record<string, unknown>;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : undefined;

  if (input.collection === POST_COLLECTION) {
    if (typeof value.text !== "string" || !createdAt) return deletion;
    let image: NonNullable<ReturnType<typeof parseNoteImage>> | undefined;
    if (value.image !== undefined) {
      const parsedImage = parseNoteImage(value.image, value.imageAlt);
      if (!parsedImage) return deletion;
      image = parsedImage;
    }
    const position = parsePosition(value.position);
    return {
      kind: "post",
      value: {
        uri,
        cid: input.cid,
        spaceUri: input.space,
        authorDid: input.repoDid,
        text: value.text,
        image,
        color: isNoteColor(value.color) ? value.color : undefined,
        rotation: isNoteRotation(value.rotation) ? value.rotation : undefined,
        x: position?.x,
        y: position?.y,
        createdAt,
      },
    };
  }

  const subject = parseSubject(value.subject);
  if (
    input.collection === REMOVAL_COLLECTION &&
    subject?.cid &&
    createdAt
  ) {
    return {
      kind: "removal",
      value: {
        uri,
        cid: input.cid,
        spaceUri: input.space,
        authorDid: input.repoDid,
        subjectUri: subject.uri,
        subjectCid: subject.cid,
        createdAt,
      },
    };
  }

  const position = parsePosition(value.position);
  if (
    input.collection === POSITION_COLLECTION &&
    subject?.cid &&
    position &&
    createdAt
  ) {
    return {
      kind: "position",
      value: {
        uri,
        cid: input.cid,
        spaceUri: input.space,
        authorDid: input.repoDid,
        subjectUri: subject.uri,
        subjectCid: subject.cid,
        ...position,
        createdAt,
      },
    };
  }
  return deletion;
}

function parsePosition(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const position = value as { x?: unknown; y?: unknown };
  return isBoardCoordinate(position.x) && isBoardCoordinate(position.y)
    ? { x: position.x, y: position.y }
    : undefined;
}

function parseSubject(value: unknown): { uri: string; cid?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const subject = value as { uri?: unknown; cid?: unknown };
  if (typeof subject.uri !== "string") return undefined;
  const cid =
    typeof subject.cid === "string"
      ? subject.cid
      : subject.cid && typeof subject.cid === "object"
        ? String(subject.cid)
        : undefined;
  return { uri: subject.uri, cid };
}

function tableForCollection(
  collection: string,
): "post" | "removal" | "note_position" | undefined {
  if (collection === POST_COLLECTION) return "post";
  if (collection === REMOVAL_COLLECTION) return "removal";
  if (collection === POSITION_COLLECTION) return "note_position";
  return undefined;
}

function authorityFromSpace(space: string): string {
  const authority = space.match(/^at:\/\/(did:[^/]+)\/space\//)?.[1];
  if (!authority) throw new Error("Invalid board reference");
  return authority;
}

function registrationNeedsRenewal(expiresAt: string | null): boolean {
  return !expiresAt || Date.parse(expiresAt) - Date.now() < 60 * 60 * 1000;
}

function asCommit(commit: {
  ver: number;
  repo: string;
  space: string;
  rev: string;
  data: Uint8Array;
}): Commit {
  if (commit.ver !== 1) throw new Error(`Unsupported commit version ${commit.ver}`);
  return commit as Commit;
}

function stripPost(value: Extract<SyncedChange, { kind: "post" }>["value"]) {
  return {
    cid: value.cid,
    uri: value.uri,
    text: value.text,
    image: value.image,
    color: value.color,
    rotation: value.rotation,
    x: value.x,
    y: value.y,
    createdAt: value.createdAt,
  };
}

function stripRemoval(
  value: Extract<SyncedChange, { kind: "removal" }>["value"],
) {
  return {
    cid: value.cid,
    uri: value.uri,
    subjectUri: value.subjectUri,
    subjectCid: value.subjectCid,
    createdAt: value.createdAt,
  };
}

function stripPosition(value: Extract<SyncedChange, { kind: "position" }>["value"]) {
  return {
    cid: value.cid,
    uri: value.uri,
    subjectUri: value.subjectUri,
    subjectCid: value.subjectCid,
    x: value.x,
    y: value.y,
    createdAt: value.createdAt,
  };
}

function stripBlobBytes(blobs: SyncedBlob[]): SpaceBlob[] {
  return blobs.map((blob) => ({
    spaceUri: blob.spaceUri,
    repoDid: blob.repoDid,
    cid: blob.cid,
    mimeType: blob.mimeType,
    size: blob.size,
  }));
}

function storeBlobFiles(blobs: SyncedBlob[]): void {
  for (const blob of blobs) storeBlobFile(blob.cid, blob.bytes);
}
