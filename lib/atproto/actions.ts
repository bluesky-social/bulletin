import { Client } from "@atproto/lex-client";
import { asStringFormat } from "@atproto/lex-schema";
import type { OAuthSession } from "@atproto/oauth-client-node";
import {
  REMOVAL_COLLECTION,
  POSITION_COLLECTION,
  POST_COLLECTION,
  SPACE_TYPE,
  boardUri,
  getConfig,
} from "../config";
import {
  deleteStoredPost,
  applySyncedChanges,
  getPost,
  hasBoard,
  saveBoard,
  upsertRemoval,
  upsertPost,
  upsertPosition,
} from "../db/queries";
import { getRelationship } from "./follows";
import type { NoteColor } from "../note-style";
import { noteImageBlobRef, parseNoteImage, type NoteImage } from "../note-image";
import {
  isNoteImageMime,
  MAX_NOTE_IMAGE_BYTES,
} from "../note-constraints";
import { storeBlobFile } from "../blob-store";
import { com } from "../lexicons";

export async function createBoard(session: OAuthSession): Promise<string> {
  const client = new Client(session);
  const result = await client.call(com.atproto.simplespace.createSpace, {
    type: SPACE_TYPE,
    skey: "self",
    readPolicy: {
      $type: "com.atproto.simplespace.defs#managingAppPolicy",
      managingApp: getConfig().managingAppService,
    },
    writePolicy: {
      $type: "com.atproto.simplespace.defs#managingAppPolicy",
      managingApp: getConfig().managingAppService,
    },
    appAccess: {
      $type: "com.atproto.simplespace.defs#open",
    },
  });
  await saveBoard(result.uri, session.did);
  return result.uri;
}

export async function createPost(
  session: OAuthSession,
  ownerDid: string,
  text: string,
  style: { color: NoteColor; rotation: number; x: number; y: number },
  imageInput?: {
    bytes: Uint8Array;
    mimeType: string;
    alt: string | null;
  },
): Promise<string> {
  if (!(await hasBoard(ownerDid))) throw new Error("Board does not exist");
  await assertCanWrite(session.did, ownerDid);
  const space = asStringFormat(boardUri(ownerDid), "space-ref");
  const createdAt = new Date().toISOString();
  const position = { x: style.x, y: style.y };
  const client = new Client(session);
  let image: NoteImage | undefined;
  if (imageInput) {
    if (
      !isNoteImageMime(imageInput.mimeType) ||
      imageInput.bytes.length <= 0 ||
      imageInput.bytes.length > MAX_NOTE_IMAGE_BYTES
    ) {
      throw new Error("Invalid note image");
    }
    const uploaded = await client.call(
      com.atproto.repo.uploadBlob,
      imageInput.bytes,
      { encoding: imageInput.mimeType },
    );
    image =
      parseNoteImage(uploaded.blob, imageInput.alt) ?? undefined;
    if (
      !image ||
      image.mimeType !== imageInput.mimeType ||
      image.size !== imageInput.bytes.length
    ) {
      throw new Error("PDS returned an invalid image reference");
    }
  }
  const result = await client.call(com.atproto.space.createRecord, {
    space,
    repo: session.did,
    collection: POST_COLLECTION,
    validate: false,
    record: {
      $type: POST_COLLECTION,
      text,
      ...(image ? { image: noteImageBlobRef(image) } : {}),
      ...(image?.alt ? { imageAlt: image.alt } : {}),
      position,
      color: style.color,
      rotation: style.rotation,
      createdAt,
    },
  });
  const blob = image
    ? {
        spaceUri: space,
        repoDid: session.did,
        cid: image.cid,
        mimeType: image.mimeType,
        size: image.size,
      }
    : undefined;
  await applySyncedChanges(
    [
      {
        kind: "post",
        value: {
          uri: result.uri,
          cid: result.cid,
          spaceUri: space,
          authorDid: session.did,
          text,
          image,
          color: style.color,
          rotation: style.rotation,
          ...position,
          createdAt,
        },
      },
    ],
    blob ? [blob] : [],
  );
  if (image) {
    try {
      storeBlobFile(image.cid, imageInput!.bytes);
    } catch (error) {
      console.error("Could not cache the new note image", error);
    }
  }
  return result.uri;
}

export async function movePost(
  session: OAuthSession,
  input: {
    ownerDid: string;
    postUri: string;
    postCid: string;
    x: number;
    y: number;
  },
): Promise<string> {
  const post = await getPost(input.postUri);
  const space = asStringFormat(boardUri(input.ownerDid), "space-ref");
  if (!post || post.spaceUri !== space || post.cid !== input.postCid) {
    throw new Error("That note has changed");
  }
  if (session.did !== input.ownerDid && session.did !== post.authorDid) {
    throw new Error("You cannot move this note");
  }
  await assertCanWrite(session.did, input.ownerDid);

  const client = new Client(session);
  if (session.did === post.authorDid) {
    const image = storedPostImage(post);
    const rkey = postRkey(post.uri, space, post.authorDid);
    const result = await client.call(com.atproto.space.putRecord, {
      space,
      repo: session.did,
      collection: POST_COLLECTION,
      rkey,
      validate: false,
      record: {
        $type: POST_COLLECTION,
        text: post.text,
        ...(image ? { image: noteImageBlobRef(image) } : {}),
        ...(image?.alt ? { imageAlt: image.alt } : {}),
        ...(post.color ? { color: post.color } : {}),
        ...(post.rotation !== null ? { rotation: post.rotation } : {}),
        position: { x: input.x, y: input.y },
        createdAt: post.createdAt,
      },
    });
    await upsertPost({
      ...post,
      cid: result.cid,
      color: post.color ?? undefined,
      rotation: post.rotation ?? undefined,
      image,
      x: input.x,
      y: input.y,
    });
    return result.cid;
  }

  const createdAt = new Date().toISOString();
  const result = await client.call(com.atproto.space.createRecord, {
    space,
    repo: session.did,
    collection: POSITION_COLLECTION,
    validate: false,
    record: {
      $type: POSITION_COLLECTION,
      subject: { uri: post.uri, cid: post.cid },
      position: { x: input.x, y: input.y },
      createdAt,
    },
  });
  await upsertPosition({
    uri: result.uri,
    cid: result.cid,
    spaceUri: space,
    authorDid: session.did,
    subjectUri: post.uri,
    subjectCid: post.cid,
    x: input.x,
    y: input.y,
    createdAt,
  });
  return post.cid;
}

export async function deleteOwnPost(
  session: OAuthSession,
  input: { ownerDid: string; postUri: string; postCid: string },
): Promise<void> {
  const post = await getPost(input.postUri);
  const space = asStringFormat(boardUri(input.ownerDid), "space-ref");
  if (!post || post.spaceUri !== space || post.cid !== input.postCid) {
    throw new Error("That note has changed");
  }
  if (session.did !== post.authorDid) {
    throw new Error("You can only delete your own notes");
  }

  const client = new Client(session);
  await client.call(com.atproto.space.deleteRecord, {
    space,
    repo: session.did,
    collection: POST_COLLECTION,
    rkey: postRkey(post.uri, space, post.authorDid),
  });
  await deleteStoredPost(post.uri);
}

export async function removePostFromBoard(
  session: OAuthSession,
  input: {
    ownerDid: string;
    postUri: string;
    postCid: string;
  },
): Promise<string> {
  if (session.did !== input.ownerDid) {
    throw new Error("Only the board owner can moderate this board");
  }
  const space = asStringFormat(boardUri(input.ownerDid), "space-ref");
  const createdAt = new Date().toISOString();
  const client = new Client(session);
  const result = await client.call(com.atproto.space.createRecord, {
    space,
    repo: session.did,
    collection: REMOVAL_COLLECTION,
    validate: false,
    record: {
      $type: REMOVAL_COLLECTION,
      subject: { uri: input.postUri, cid: input.postCid },
      createdAt,
    },
  });
  await upsertRemoval({
    uri: result.uri,
    cid: result.cid,
    spaceUri: space,
    authorDid: session.did,
    subjectUri: input.postUri,
    subjectCid: input.postCid,
    createdAt,
  });
  return result.uri;
}

async function assertCanWrite(userDid: string, ownerDid: string): Promise<void> {
  if (userDid === ownerDid) return;
  const relationship = await getRelationship(userDid, ownerDid);
  if (!relationship.follows || !relationship.followedBy) {
    throw new Error("Only mutual followers can post");
  }
}

function postRkey(uri: string, space: string, authorDid: string): string {
  const prefix = `${space}/${authorDid}/${POST_COLLECTION}/`;
  if (!uri.startsWith(prefix)) throw new Error("Invalid note reference");
  const rkey = uri.slice(prefix.length);
  if (!rkey || rkey.includes("/")) throw new Error("Invalid note reference");
  return rkey;
}

function storedPostImage(
  post: Awaited<ReturnType<typeof getPost>>,
): NoteImage | undefined {
  if (!post?.imageCid || !isNoteImageMime(post.imageMime) || post.imageSize === null) {
    return undefined;
  }
  return {
    cid: post.imageCid,
    mimeType: post.imageMime,
    size: post.imageSize,
    alt: post.imageAlt,
  };
}
