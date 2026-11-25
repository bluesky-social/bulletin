import assert from "node:assert/strict";
import test from "node:test";
import {
  POSITION_COLLECTION,
  POST_COLLECTION,
  REMOVAL_COLLECTION,
} from "../config";
import { parseChange } from "./engine";

test("removes a stale post when a replacement value is malformed", () => {
  const space = "at:space/did:plc:owner/my.bulletin.board/self";
  const repoDid = "did:plc:writer";
  assert.deepEqual(
    parseChange({
      space,
      repoDid,
      collection: POST_COLLECTION,
      rkey: "post",
      cid: "bafyreireplacement",
      value: null,
    }),
    {
      kind: "delete",
      table: "post",
      uri: `${space}/${repoDid}/${POST_COLLECTION}/post`,
      spaceUri: space,
      authorDid: repoDid,
    },
  );
});

test("parses a board removal without generic label fields", () => {
  const space = "at:space/did:plc:owner/my.bulletin.board/self";
  const repoDid = "did:plc:owner";
  const subjectUri = `${space}/did:plc:writer/${POST_COLLECTION}/post`;
  const createdAt = "2026-08-19T12:00:00.000Z";

  assert.deepEqual(
    parseChange({
      space,
      repoDid,
      collection: REMOVAL_COLLECTION,
      rkey: "removal",
      cid: "bafyreiremoval",
      value: {
        subject: { uri: subjectUri, cid: "bafyreipost" },
        createdAt,
      },
    }),
    {
      kind: "removal",
      value: {
        uri: `${space}/${repoDid}/${REMOVAL_COLLECTION}/removal`,
        cid: "bafyreiremoval",
        spaceUri: space,
        authorDid: repoDid,
        subjectUri,
        subjectCid: "bafyreipost",
        createdAt,
      },
    },
  );
});

test("removes a stale removal when its replacement is malformed", () => {
  const space = "at:space/did:plc:owner/my.bulletin.board/self";
  const repoDid = "did:plc:owner";

  assert.deepEqual(
    parseChange({
      space,
      repoDid,
      collection: REMOVAL_COLLECTION,
      rkey: "removal",
      cid: "bafyreireplacement",
      value: { createdAt: "2026-08-19T12:00:00.000Z" },
    }),
    {
      kind: "delete",
      table: "removal",
      uri: `${space}/${repoDid}/${REMOVAL_COLLECTION}/removal`,
      spaceUri: space,
      authorDid: repoDid,
    },
  );
});

test("indexes an alpha-era subject URI in the at:space/ form", () => {
  const space = "at:space/did:plc:owner/my.bulletin.board/self";
  const repoDid = "did:plc:owner";
  const createdAt = "2026-08-19T12:00:00.000Z";
  const subject = {
    uri: `at://did:plc:owner/space/my.bulletin.board/self/did:plc:writer/${POST_COLLECTION}/post`,
    cid: "bafyreipost",
  };
  const subjectUri = `${space}/did:plc:writer/${POST_COLLECTION}/post`;

  const removal = parseChange({
    space,
    repoDid,
    collection: REMOVAL_COLLECTION,
    rkey: "removal",
    cid: "bafyreiremoval",
    value: { subject, createdAt },
  });
  assert.equal(removal?.kind, "removal");
  assert.equal(
    removal?.kind === "removal" ? removal.value.subjectUri : undefined,
    subjectUri,
  );

  const position = parseChange({
    space,
    repoDid,
    collection: POSITION_COLLECTION,
    rkey: "position",
    cid: "bafyreiposition",
    value: { subject, position: { x: 1, y: 2 }, createdAt },
  });
  assert.equal(position?.kind, "position");
  assert.equal(
    position?.kind === "position" ? position.value.subjectUri : undefined,
    subjectUri,
  );
});
