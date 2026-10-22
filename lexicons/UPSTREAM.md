# Vendored AT Protocol Lexicons

The `upstream/app/bsky` and `upstream/com/atproto` schemas are the subset used
by Bulletin's generated client. They are copied from
`bluesky-social/atproto` commit `c74924f343043cb50160116bc9786e57013306d4`,
except for these updated schemas:

| Schemas | Source commit |
| --- | --- |
| `com.atproto.simplespace.createSpace` | [`d460767`](https://github.com/bluesky-social/atproto/commit/d460767643811e40ee4ec74102587232274d7ded) |
| `com.atproto.space.defs`, `com.atproto.space.getSpaceCredential`, `com.atproto.space.listRepoOps`, `com.atproto.space.listRepos`, `com.atproto.space.notifyWrite` | [`ac0c9f1`](https://github.com/bluesky-social/atproto/commit/ac0c9f15392f6f0298d71dc52aa88c05036150be) |

Generate Bulletin's bindings with `pnpm codegen:lex` (also run by `pnpm build`).

The `my/bulletin` schemas are owned by Bulletin and are not vendored.
