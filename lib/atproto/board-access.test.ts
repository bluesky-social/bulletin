import assert from "node:assert/strict";
import test from "node:test";
import { isBoardAccessAuthorized } from "./board-access";

test("followers can read a board", () => {
  assert.equal(
    isBoardAccessAuthorized({ follows: true, followedBy: false }, "read"),
    true,
  );
});

test("only mutuals can write to a board", () => {
  assert.equal(
    isBoardAccessAuthorized({ follows: true, followedBy: false }, "write"),
    false,
  );
  assert.equal(
    isBoardAccessAuthorized({ follows: true, followedBy: true }, "write"),
    true,
  );
});

test("non-followers cannot read or write", () => {
  const relationship = { follows: false, followedBy: true };
  assert.equal(isBoardAccessAuthorized(relationship, "read"), false);
  assert.equal(isBoardAccessAuthorized(relationship, "write"), false);
});
