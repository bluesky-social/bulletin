import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const lexicons = [
  "com.atproto.space.createSpace",
  "com.atproto.space.getDelegationToken",
  "com.atproto.space.getSpaceCredential",
  "com.atproto.space.createRecord",
  "com.atproto.space.putRecord",
  "com.atproto.space.deleteRecord",
  "com.atproto.space.registerNotify",
  "com.atproto.space.listRepos",
  "com.atproto.space.notifyWrite",
  "com.atproto.space.listRepoOps",
  "com.atproto.space.getBlob",
  "com.atproto.repo.uploadBlob",
  "app.bsky.graph.getRelationships",
  "app.bsky.actor.getProfile",
  "app.bsky.actor.searchActorsTypeahead",
];

execFileSync(
  "lex",
  [
    "build",
    "--lexicons",
    fileURLToPath(new URL("../lexicons/upstream", import.meta.url)),
    "--out",
    fileURLToPath(new URL("../lib/lexicons", import.meta.url)),
    "--clear",
    "--index-file",
    "--import-ext",
    "",
    "--lib",
    "@atproto/lex-schema",
    "--include",
    ...lexicons,
  ],
  { stdio: "inherit" },
);
