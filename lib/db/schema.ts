import type { NoteColor } from "../note-style";

type AuthStoreTable = {
  key: string;
  value: string;
};

export type DatabaseSchema = {
  authState: AuthStoreTable;
  authSession: AuthStoreTable;
  account: {
    did: string;
    handle: string | null;
    pdsUrl: string | null;
    updatedAt: string;
  };
  board: {
    spaceUri: string;
    ownerDid: string;
    createdAt: string;
  };
  post: {
    uri: string;
    cid: string;
    spaceUri: string;
    authorDid: string;
    text: string;
    imageCid: string | null;
    imageMime: string | null;
    imageSize: number | null;
    imageAlt: string | null;
    color: NoteColor | null;
    rotation: number | null;
    x: number | null;
    y: number | null;
    createdAt: string;
    indexedAt: string;
  };
  removal: {
    uri: string;
    cid: string;
    spaceUri: string;
    authorDid: string;
    subjectUri: string;
    subjectCid: string;
    createdAt: string;
    indexedAt: string;
  };
  notePosition: {
    uri: string;
    cid: string;
    spaceUri: string;
    authorDid: string;
    subjectUri: string;
    subjectCid: string;
    x: number;
    y: number;
    createdAt: string;
    indexedAt: string;
  };
  syncSpace: {
    spaceUri: string;
    authorityDid: string;
    spaceRev: string | null;
    registrationExpiresAt: string | null;
    lastError: string | null;
    updatedAt: string;
  };
  syncRepo: {
    spaceUri: string;
    repoDid: string;
    pdsUrl: string;
    rev: string;
    lthash: Uint8Array;
    commitHash: Uint8Array;
    updatedAt: string;
  };
  spaceBlob: {
    spaceUri: string;
    repoDid: string;
    cid: string;
    mimeType: string;
    size: number;
    updatedAt: string;
  };
  webSession: {
    tokenHash: string;
    did: string;
    createdAt: string;
    expiresAt: string;
  };
};
