# Vendored AT Protocol Lexicons

The `upstream/app/bsky` and `upstream/com/atproto` schemas are the subset used
by Bulletin's generated client. They are copied from
`bluesky-social/atproto` commit `c74924f343043cb50160116bc9786e57013306d4`.
The npm `alpha` packages currently trail these schemas, so local protocol
development should use the sibling atproto checkout described in the README.

The `my/bulletin` schemas are owned by Bulletin and are not vendored.
