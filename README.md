# Synology package source

A Cloudflare Worker that serves a DSM Package Center source for every package
listed in `SOURCES`.

Package Center polls a source URL with parameters such as
`?arch=epyc7002&build=90080&major=7&language=enu` and expects a JSON catalog.
This worker builds that catalog from the `packages.json` asset attached to the
latest GitHub release of each package repo.

## Packages

| Package | Repo |
| --- | --- |
| HardwareMonitor | [EraserKing/syno-hardwaremonitor](https://github.com/EraserKing/syno-hardwaremonitor) |

## How it works

For each repo in `SOURCES` the worker:

1. fetches `releases/latest/download/packages.json`,
2. merges the entries, keeping the newer version when two repos publish the
   same package name,
3. filters by the `arch` and `build` parameters Package Center sends,
4. caches each repo's catalog for five minutes.

Publishing a release is enough. The worker only needs a redeploy when a new
**repo** is added or the code changes.

A static page would work for one package, but it would need a commit or
redeploy on every release, so it does not scale to several packages.

## Deploy from Git (recommended)

Connect the repo once, then every push to `main` deploys the Worker.

1. Dashboard: **Workers & Pages → Create → Connect to Git**, or open the
   existing Worker and use **Settings → Builds → Connect**.
2. Pick `EraserKing/syno-packages` and branch `main`.
3. Root directory `/`, build command empty, deploy command
   `npx wrangler deploy`.
4. The Worker name in the dashboard must be `synology-packages`, matching
   `name` in `wrangler.toml`.

Free plan: 3,000 build minutes per month and one concurrent build. A deploy
of this Worker takes seconds. Pull requests get preview builds, so a change to
the arch map can be checked before it reaches `main`.

Use either Git deploys or manual deploys, not both. A manual deploy is
overwritten by the next push.

## Manual deploy

Requires a Cloudflare account and the domain already added to Cloudflare.

```sh
npx wrangler login
npx wrangler deploy
```

The first deploy prints a `https://synology-packages.<account>.workers.dev`
URL. That URL already works as a package source.

### Custom domain

Dashboard: **Workers & Pages → synology-packages → Settings → Domains &
Routes → Add → Custom domain**, then enter a hostname in your zone, for
example `pkg.example.com`. Cloudflare creates the DNS record and certificate.
No extra cost on the free plan.

## Add another package

1. In that package's repo, add a release step that writes `packages.json`
   with `package`, `version`, `link`, `md5`, `sha256`, `size`, and `archs`,
   and attach it to the release. See the HardwareMonitor workflow for a
   working example.
2. Add the repo to `SOURCES` in `catalog-worker.js`.
3. `npx wrangler deploy`.

`archs` is not part of Synology's schema. Package Center ignores it; this
worker uses it. Values are architecture families: `noarch`, `x86_64`,
`armv7`, `armv8`, `i686`, `ppc`. Generate it from the SPK's `INFO` `arch`
field so nothing is hardcoded per package.

## Verify

```sh
curl -s "https://pkg.example.com/?arch=epyc7002&build=90080&major=7&language=enu"
```

Expected: every package compatible with that platform. If the body is empty,
the platform is not in the family map, or no release has a `packages.json`
asset yet.

Useful checks:

```sh
# x86_64 NAS: x86_64-only packages listed
curl -s "https://pkg.example.com/?arch=epyc7002&build=90080"

# ARM NAS: x86_64-only packages hidden, noarch packages still listed
curl -s "https://pkg.example.com/?arch=rtd1619b&build=90080"

# DSM 6: empty, these packages require DSM 7
curl -s "https://pkg.example.com/?arch=epyc7002&build=25426"
```

## Add to DSM

**Package Center → Settings → Package Sources → Add**, then use the custom
domain as the location. Packages appear under **Community**.

DSM 7 shows a third-party warning on install. That is normal and cannot be
removed; DSM 7 has no signing or trust-level setting.

## Architecture filtering

Package Center sends its platform code, for example `epyc7002` or
`geminilake`. The worker maps it to a family using Synology's platform table.
An entry with `archs: ["x86_64"]` is shown only to x86_64 platforms;
`archs: ["noarch"]` is shown everywhere.

An unknown platform code only sees `noarch` packages. When Synology ships a
new platform, add it to `FAMILIES` in `catalog-worker.js`.

## Limits

- Free plan: 100,000 Worker requests per day. Package Center polls only when a
  source is refreshed, so this is far below the limit.
- `releases/latest` ignores drafts and prereleases. Tag a normal release.
- A repo with no `packages.json` asset is skipped; the other repos still
  appear. The whole response is 502 only when every source fails.
