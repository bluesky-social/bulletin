# Vendored AT Protocol Lexicons

The `upstream/app/bsky` and `upstream/com/atproto` schemas are the subset used
by Bulletin's generated client. They are copied from
`bluesky-social/atproto` commit `c74924f343043cb50160116bc9786e57013306d4`,
except for these updated schemas:

| Schemas | Source commit |
| --- | --- |
| `com.atproto.space.*`, `com.atproto.personalspace.policy`, `com.atproto.memberspace.policy`, `com.atproto.managedspace.policy` | [`d4def6e`](https://github.com/bluesky-social/atproto/commit/d4def6e9f521896ed8222f576d54923d00b5fbeb) |

Generate Bulletin's bindings with `pnpm codegen:lex` (also run by `pnpm build`).

The `my/bulletin` schemas are owned by Bulletin and are not vendored.
