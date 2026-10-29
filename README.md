# Bulletin

An example application built on atproto spaces (aka the [permissioned data protocol](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data)).

Every Bluesky user can create one bulletin board backed by a `com.atproto.managedspace` space under their DID. Only a user's followers can read their board, and only mutuals are able to post to it.

The owner of the board can move notes around and remove other users' notes as well.

Try Bulletin at <https://bulletin.my>.

Give it a run, poke around, and remix it into something of your own.

## Run it locally

You'll need Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

Open <http://127.0.0.1:3000> and sign in with an Atmosphere account on a spaces-compatible PDS. 

The app's Lexicons live in the `my.bulletin.*` namespace under [`lexicons/my`](./lexicons/my). For more about how spaces work, check out the [permissioned data proposal](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data).

## Run it against a local network

If you're working on the protocol itself, you can also run Bulletin against the multi-PDS development network. This requires a sibling checkout of [`bluesky-social/atproto`](https://github.com/bluesky-social/atproto) on the [permissioned-data](https://github.com/bluesky-social/atproto/pull/5187) branch.

Start the network from the atproto repo:

```sh
pnpm --filter @atproto/dev-env start:multi-pds
```

Then start Bulletin with:

```sh
pnpm dev:local
```

## Deploy it

Want to host your own version? See [DEPLOY.md](./DEPLOY.md) for the current deployment setup.
