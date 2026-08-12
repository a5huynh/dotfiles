---
name: dnsimple
description: Search for available (unregistered) domain names via the DNSimple API v2 — check a list of domains, or generate candidates from names × TLDs × prefixes/suffixes, with optional registration prices. Use when the user asks whether a domain is taken, wants to find an open domain for a project, or wants TLD/pricing info from DNSimple.
---

# DNSimple Domain Search

Checks domain availability through DNSimple's registrar API. No npm install — uses Node's
built-in `fetch`.

## Setup

Create an **account** API token at <https://dnsimple.com/a/account/access_tokens>, then:

```bash
export DNSIMPLE_TOKEN=…            # required
export DNSIMPLE_ACCOUNT=12345      # optional; skips the /whoami lookup on every run
export DNSIMPLE_API_BASE=…         # optional; override the API base URL (proxy/testing)
```

Verify it works:

```bash
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs whoami
```

## Search for open names

Generates candidates locally and checks each one. Available-only by default.

```bash
# one name across the default TLDs (com net org io dev app co sh xyz ai)
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs search barfly

# several names, specific TLDs
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs search barfly tabkeeper --tlds com,io,dev

# word combinations: {get,my,try} × name × {app,hq}
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs search barfly --prefix get,my,try --suffix app,hq --tlds com

# with prices, and showing what's taken
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs search barfly --tlds com,io --prices --all
```

## Check exact domains

```bash
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs check barfly.com barfly.io example.dev
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs check barfly.com --json
```

## Prices and TLDs

```bash
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs prices barfly.io          # reg / renew / transfer
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs tlds bar                  # TLDs containing "bar"
node ~/.pi/agent/skills/dnsimple/dnsimple.mjs tlds                      # all supported TLDs
```

## Options

| Flag | Meaning |
| --- | --- |
| `--tlds a,b,c` | TLDs for `search` (leading dots optional) |
| `--prefix`, `--suffix` | Comma lists combined with each name; the bare name is always included |
| `--prices` | Fetch prices for available results (one extra request each) |
| `--all` | List taken domains too, not just the count |
| `--json` | Machine-readable output |
| `--concurrency N` | Parallel requests, default 6 |
| `--sandbox` | Hit `api.sandbox.dnsimple.com` instead of production |
| `--research` | Use `domains/research/status` (private beta) for a richer availability string |

## Notes

- **There is no bulk availability endpoint.** `GET /{account}/registrar/domains/{domain}/check`
  takes one domain, so a search of 10 names × 10 TLDs is 100 requests.
- **⚠️ `checkDomain` has its own hourly quota, far below the account limit, and no header tracks
  it.** The account allowance is 2,400 requests/hour, but availability checks are throttled
  separately — observed at **roughly 50 checks/hour** on a personal plan, after which every check
  returns 429 `endpoint checkDomain quota exceeded`. At that moment `x-ratelimit-remaining` still
  read **2287**, so the headers cannot be used to predict or pace it. Budget ~50 checks per hour,
  keep `--tlds` tight, and treat a broad sweep (many names × many TLDs) as something that will
  fail partway.
  - The quota is **per endpoint, not per account**: `prices`, `tlds` and `whoami` keep working
    normally while checks are refused, so pricing up a shortlist is still possible.
  - A quota 429 **keeps the results already collected** and lists the remainder under
    `NOT CHECKED`, exiting 1. There's no retry, because an hourly quota cannot clear in seconds.
- **`available: true` plus `premium: true` can still cost thousands.** Premium results are labelled
  `PREMIUM`; use `--prices` before getting attached to one.
- **Per-domain failures don't abort the run** — an unsupported TLD lands in an `ERRORS` section
  while the rest report normally. Only 401 (bad token) and 429 (rate limited) are fatal.
- `--research` is a **private beta** endpoint. Unless it's enabled for the account it answers
  **412 `Feature not enabled: api_domain_research`** (ask support@dnsimple.com to turn it on). It
  surfaces as a per-domain error rather than aborting the run, so the default `check` path stays
  the one to use. It is *not* a way around the `checkDomain` quota while disabled.
- **Tests:** `node ~/.pi/agent/skills/dnsimple/test.mjs` runs the CLI against a self-terminating
  stub API (via `DNSIMPLE_API_BASE`) and needs no token or network. Run it after editing
  `dnsimple.mjs`; check the request count it prints at the end, which is what caught the
  `/whoami` stampede.
- Availability is a point-in-time answer from the registry, not a hold. Nothing here registers a
  domain — registration is a `POST` this skill deliberately doesn't implement.
