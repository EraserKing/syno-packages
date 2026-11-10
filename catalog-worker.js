/**
 * Package Center source for a set of GitHub-hosted DSM packages.
 *
 * Each package repo publishes its own packages.json as an asset on its
 * latest GitHub release. This worker merges those catalogs and answers the
 * request Package Center makes:
 *
 *   GET /?arch=epyc7002&build=90080&major=7&language=enu
 *
 * Adding a package means adding its repo to SOURCES and redeploying. No
 * per-package code lives here.
 */

// Repos that publish a packages.json release asset. Order only matters for
// duplicate package names; the newer version wins regardless.
const SOURCES = [
  "EraserKing/syno-hardwaremonitor",
];

const CACHE_TTL = 300;

// Synology platform code -> arch family. Taken from the developer guide's
// platform mapping table plus the newer codes listed by SynoCommunity.
// Update this when Synology ships a platform that is missing here.
const FAMILIES = {
  x86_64: [
    "apollolake", "avoton", "braswell", "broadwell", "broadwellnk",
    "broadwellnkv2", "broadwellntb", "broadwellntbap", "bromolow", "bromlow",
    "cedarview", "coffeelake", "denverton", "dockerx64", "epyc7002",
    "epyc7003", "geminilake", "geminilakenk", "grantley", "haswell",
    "icelaked", "kvmx64", "purley", "r1000", "r1000nk", "skylaked",
    "v1000", "v1000nk", "x86", "x86_64",
  ],
  armv7: [
    "628x", "88f6281", "88f628x", "alpine", "alpine4k", "armada370",
    "armada375", "armada38x", "armadaxp", "armv7", "armv7l", "comcerto2k",
    "dakota", "hi3535", "ipq806x", "monaco", "northstarplus",
  ],
  armv8: [
    "aarch64", "armada37xx", "armv8", "cypress", "rtd1296", "rtd1619",
    "rtd1619b",
  ],
  i686: ["evansport", "i686"],
  ppc: ["powerpc", "ppc", "ppc824x", "ppc853x", "ppc854x", "qoriq"],
};

const PLATFORM_FAMILY = new Map();
for (const [family, platforms] of Object.entries(FAMILIES)) {
  for (const platform of platforms) {
    PLATFORM_FAMILY.set(platform, family);
  }
}

export default {
  async fetch(request, _env, ctx) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad request\n", { status: 400 });
    }
    if (url.pathname !== "/" && url.pathname !== "/packages.json") {
      return new Response("Not found\n", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const arch = (url.searchParams.get("arch") || "").toLowerCase();
    const build = Number(url.searchParams.get("build") || 0);
    const family = PLATFORM_FAMILY.get(arch) || null;

    const bodies = await Promise.all(SOURCES.map((repo) => catalog(ctx, repo)));
    const merged = [];
    let reachable = 0;

    for (const body of bodies) {
      if (body === null) {
        continue;
      }
      reachable++;
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        continue;
      }
      if (!Array.isArray(data.packages)) {
        continue;
      }
      for (const entry of data.packages) {
        if (!entry || typeof entry.package !== "string") {
          continue;
        }
        if (arch && !supports(entry, family)) {
          continue;
        }
        merged.push(entry);
      }
    }

    if (reachable === 0) {
      return json({ packages: [] }, 502);
    }
    if (build && build < 40000) {
      return json({ packages: [] }, 200);
    }

    return json({ packages: dedupe(merged) }, 200);
  },
};

/**
 * A catalog entry may carry an "archs" array of families. It is not part of
 * Synology's schema; Package Center ignores it and this worker uses it. An
 * entry without "archs" is treated as noarch.
 */
function supports(entry, family) {
  const archs =
    Array.isArray(entry.archs) && entry.archs.length ? entry.archs : ["noarch"];
  if (archs.includes("noarch")) {
    return true;
  }
  return family !== null && archs.includes(family);
}

function dedupe(entries) {
  const best = new Map();
  for (const entry of entries) {
    const current = best.get(entry.package);
    if (!current || newer(entry.version, current.version)) {
      best.set(entry.package, entry);
    }
  }
  return [...best.values()];
}

// Versions look like 0.2.2 or 0.2.2-0001. Compare the numeric parts.
function newer(a, b) {
  const left = String(a || "").split(/[.-]/).map(Number);
  const right = String(b || "").split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) {
      return l > r;
    }
  }
  return false;
}

async function catalog(ctx, repo) {
  const url = `https://github.com/${repo}/releases/latest/download/packages.json`;
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) {
    return hit.text();
  }

  const res = await fetch(url, {
    redirect: "follow",
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) {
    return null;
  }

  const text = await res.text();
  ctx.waitUntil(
    cache.put(
      key,
      new Response(text, {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${CACHE_TTL}`,
        },
      })
    )
  );
  return text;
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
