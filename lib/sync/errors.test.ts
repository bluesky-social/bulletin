import { LexError } from "@atproto/lex-data";
import assert from "node:assert/strict";
import test from "node:test";
import {
  isBoardAbsentError,
  isSpaceAccessDeniedError,
  isSpaceDeletedError,
  isSpaceNotFoundError,
  WatchInvalidatedError,
} from "./errors";

test("recognizes the durable SpaceDeleted signal", () => {
  assert.equal(
    isSpaceDeletedError(new LexError("SpaceDeleted")),
    true,
  );
  assert.equal(isSpaceDeletedError(new LexError("SpaceNotFound")), false);
  assert.equal(isSpaceDeletedError(new Error("SpaceDeleted")), false);
});

test("recognizes a missing space", () => {
  assert.equal(
    isSpaceNotFoundError(new LexError("SpaceNotFound")),
    true,
  );
  assert.equal(isSpaceNotFoundError(new LexError("SpaceDeleted")), false);
  assert.equal(isSpaceNotFoundError(new Error("SpaceNotFound")), false);
});

test("recognizes user-scoped space access denial", () => {
  assert.equal(isSpaceAccessDeniedError(new LexError("AccountNotAuthorized")), true);
  assert.equal(isSpaceAccessDeniedError(new LexError("NotAuthorized")), true);
  assert.equal(isSpaceAccessDeniedError(new LexError("AppNotAuthorized")), false);
  assert.equal(isSpaceAccessDeniedError(new Error("AccountNotAuthorized")), false);
});

test("treats durable deletions and invalidated watches as absent boards", () => {
  assert.equal(isBoardAbsentError(new LexError("SpaceNotFound")), true);
  assert.equal(isBoardAbsentError(new LexError("SpaceDeleted")), true);
  assert.equal(isBoardAbsentError(new WatchInvalidatedError()), true);
  assert.equal(isBoardAbsentError(new Error("Space has been deleted")), false);
});
