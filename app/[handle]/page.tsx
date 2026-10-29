import { CreateBoardButton } from "@/components/CreateBoardButton";
import { Header } from "@/components/Header";
import { LoginForm } from "@/components/LoginForm";
import { SpatialBoard } from "@/components/SpatialBoard";
import { getRelationship, type Relationship } from "@/lib/atproto/follows";
import { getProfile, type Profile } from "@/lib/atproto/profile";
import { probeSpaceExists } from "@/lib/atproto/space-existence";
import { cacheIdentity, resolveHandle } from "@/lib/atproto/identity";
import { getSession } from "@/lib/auth/session";
import {
  getBulletinCapabilities,
  type BulletinCapabilities,
} from "@/lib/auth/bulletin-capabilities";
import { discoverBoardForDid } from "@/lib/board-discovery";
import { boardUri } from "@/lib/config";
import {
  getAccount,
  hasBoard,
  hasSpaceWatch,
  listBoardPosts,
} from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const handle = decodeURIComponent((await params).handle).replace(/^@/, "");
  const session = await getSession();
  const ownerDid = await resolveHandle(handle);
  if (!ownerDid) {
    return (
      <BoardMissing
        viewerDid={session?.did}
        ownerHandle={handle}
        avatar={null}
      />
    );
  }
  await cacheIdentity(ownerDid).catch(() => undefined);
  const ownBoard = session?.did === ownerDid;
  const space = boardUri(ownerDid);
  const owner = await getAccount(ownerDid);

  if (!session) {
    return (
      <main className="shell">
        <Header />
        <div className="gate">
          <div className="gate-sticker">followers only</div>
          <h1 className="gate-title">
            sign in to open <span>this bulletin</span>
          </h1>
          <LoginForm />
        </div>
      </main>
    );
  }

  let capabilities: BulletinCapabilities | undefined;
  try {
    capabilities = await getBulletinCapabilities(session, ownerDid);
  } catch (error) {
    console.error("Could not read the granted OAuth permissions", error);
  }

  let relationship: Relationship | undefined;
  if (!ownBoard) {
    try {
      relationship = await getRelationship(session.did, ownerDid);
    } catch (error) {
      console.error("Could not check board access", error);
      return (
        <BoardUnavailable
          viewerDid={session.did}
          ownerHandle={owner?.handle}
          avatar={null}
        />
      );
    }
    if (!relationship.follows) {
      const restrictedProfile = await getProfile(ownerDid);
      const restrictedHandle = restrictedProfile?.handle ?? owner?.handle;
      let restrictedBoardExists: boolean | undefined;
      try {
        // The authority answers SpaceNotFound to readers it refuses, so a
        // non-follower's probe can't tell a missing board from a restricted one.
        restrictedBoardExists =
          (await hasBoard(ownerDid)) ||
          (await probeSpaceExists(session, space));
      } catch (error) {
        console.error("Could not check whether board exists", error);
      }
      if (restrictedBoardExists === false) {
        return (
          <BoardMissing
            viewerDid={session.did}
            ownerHandle={restrictedHandle}
            avatar={restrictedProfile?.avatar}
          />
        );
      }
      if (restrictedBoardExists === undefined) {
        return (
          <BoardUnavailable
            viewerDid={session.did}
            ownerHandle={restrictedHandle}
            avatar={restrictedProfile?.avatar}
          />
        );
      }
      return (
        <BoardNotice
          viewerDid={session.did}
          ownerHandle={restrictedHandle}
          avatar={restrictedProfile?.avatar}
          message="followers only"
          boardLabel="Followers-only board"
          restricted
        />
      );
    }
  }

  const ownerProfile = await getProfile(ownerDid);
  const ownerHandle = ownerProfile?.handle ?? owner?.handle;

  let boardExists = await hasBoard(ownerDid);
  if (ownBoard && !boardExists && capabilities?.canCreateBoard === false) {
    return <IncompatiblePds viewerDid={session.did} />;
  }
  if (!boardExists || !(await hasSpaceWatch(space))) {
    try {
      boardExists = await discoverBoardForDid(ownerDid);
    } catch (error) {
      // A sync outage should not hide a previously verified board. After a fresh
      // database, though, there is no safe local state to serve yet.
      console.error("Could not discover board", error);
      boardExists = await hasBoard(ownerDid);
      if (!boardExists) {
        return (
          <BoardUnavailable
            viewerDid={session.did}
            ownerHandle={ownerHandle}
            avatar={ownerProfile?.avatar}
          />
        );
      }
    }
  }

  if (!boardExists) {
    if (ownBoard) {
      return (
        <main className="shell">
          <Header did={session.did} />
          <div className="gate stack">
            <h1 className="gate-title">
              put up your <span>bulletin</span>
            </h1>
            <p>start with an empty board and make it yours</p>
            <CreateBoardButton />
          </div>
        </main>
      );
    }
    return (
      <BoardMissing
        viewerDid={session.did}
        ownerHandle={ownerHandle}
        avatar={ownerProfile?.avatar}
      />
    );
  }

  const posts = await listBoardPosts(space, ownerDid);
  const displayedPosts = posts.filter(
    (post) => !post.hidden || post.authorDid === session.did,
  );
  const profileEntries = await Promise.all(
    [...new Set(displayedPosts.map((post) => post.authorDid))]
      .filter((did) => did !== ownerDid)
      .map(async (did) => [did, await getProfile(did)] as const),
  );
  const profiles = new Map<string, Profile | null>([
    [ownerDid, ownerProfile],
    ...profileEntries,
  ]);
  const canWrite =
    capabilities?.canCreateNote === true &&
    (ownBoard || Boolean(relationship?.followedBy));

  return (
    <main className="shell board-page">
      <Header did={session.did} />
      <section className="board-head">
        <BoardTitle ownerHandle={ownerHandle} avatar={ownerProfile?.avatar} />
      </section>
      <div className="board-layout">
        <SpatialBoard
          key={ownerDid}
          initialPosts={displayedPosts.map((post) => ({
            ...post,
            authorHandle:
              profiles.get(post.authorDid)?.handle ?? post.authorHandle,
            displayDate: formatDate(post.createdAt),
            authorAvatar: profiles.get(post.authorDid)?.avatar ?? null,
          }))}
          ownerDid={ownerDid}
          viewerDid={session.did}
          canWrite={canWrite}
        />
      </div>
    </main>
  );
}

function IncompatiblePds({ viewerDid }: { viewerDid: string }) {
  return (
    <main className="shell">
      <Header did={viewerDid} />
      <div className="gate incompatible-gate">
        <h1 className="gate-title incompatible-title">
          your PDS doesn’t support <span>bulletins</span> yet
        </h1>
        <a
          className="button incompatible-cta"
          href="https://bsky.network/account"
        >
          get an atproto spaces alpha account
        </a>
      </div>
    </main>
  );
}

function BoardUnavailable({
  viewerDid,
  ownerHandle,
  avatar,
}: {
  viewerDid: string;
  ownerHandle: string | null | undefined;
  avatar: string | null | undefined;
}) {
  return (
    <main className="shell">
      <Header did={viewerDid} />
      <section className="board-head">
        <BoardTitle ownerHandle={ownerHandle} avatar={avatar} />
      </section>
      <div className="gate">
        <div className="gate-sticker">give it a minute</div>
        <h1 className="gate-title">this bulletin couldn’t be opened</h1>
        <p>something went wrong — try again in a moment</p>
      </div>
    </main>
  );
}

function BoardMissing({
  viewerDid,
  ownerHandle,
  avatar,
}: {
  viewerDid?: string;
  ownerHandle: string | null | undefined;
  avatar: string | null | undefined;
}) {
  return (
    <BoardNotice
      viewerDid={viewerDid}
      ownerHandle={ownerHandle}
      avatar={avatar}
      message="this bulletin doesn’t exist"
      boardLabel="Missing bulletin"
    />
  );
}

function BoardNotice({
  viewerDid,
  ownerHandle,
  avatar,
  message,
  boardLabel,
  restricted = false,
}: {
  viewerDid?: string;
  ownerHandle: string | null | undefined;
  avatar: string | null | undefined;
  message: string;
  boardLabel: string;
  restricted?: boolean;
}) {
  return (
    <main className="shell board-page">
      <Header did={viewerDid} />
      <section className="board-head">
        <BoardTitle ownerHandle={ownerHandle} avatar={avatar} />
      </section>
      <div className="board-layout">
        <div className="spatial-board-wrap">
          <div className="spatial-board" aria-label={boardLabel}>
            <div className="board-state-plaque">
              {restricted && <span aria-hidden="true">🔒</span>}
              {message}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function BoardTitle({
  ownerHandle,
  avatar,
}: {
  ownerHandle: string | null | undefined;
  avatar?: string | null;
}) {
  return (
    <div className="board-identity">
      {avatar && (
        // Profile blobs can come from arbitrary PDS hosts.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="board-avatar" src={avatar} alt="" />
      )}
      <h1 className="board-title">
        {ownerHandle ? `@${ownerHandle}` : "bulletin"}
      </h1>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
