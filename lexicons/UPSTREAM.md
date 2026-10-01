# Vendored AT Protocol Lexicons

The `upstream/app/bsky` and `upstream/com/atproto` schemas are the subset used
by Bulletin's generated client. They are copied from
`bluesky-social/atproto` commit `c74924f343043cb50160116bc9786e57013306d4`,
except for these updated schemas:

| Schemas | Source commit |
| --- | --- |
| `com.atproto.simplespace.createSpace` | [`d460767`](https://github.com/bluesky-social/atproto/commit/d460767643811e40ee4ec74102587232274d7ded) |
| `com.atproto.space.getSpaceCredential` | [`f57eb33`](https://github.com/bluesky-social/atproto/commit/f57eb33298a0f9d977affa018105d0e4133255a7) |
| `com.atproto.space.listRepos`, `com.atproto.space.notifyWrite` | [`681067f`](https://github.com/bluesky-social/atproto/commit/681067f7407889a710fd8aa162eb29b34108988c) |

Generate Bulletin's bindings with `pnpm codegen:lex` (also run by `pnpm build`).

The `my/bulletin` schemas are owned by Bulletin and are not vendored.
