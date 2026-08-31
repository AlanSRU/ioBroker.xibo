# Findings accepted as not-applicable

Recorded per the pre-release gate, which allows a finding to be resolved *or*
justified. Re-check each of these on the next release.

## E0063 — "@types/chai, chai, @types/mocha, mocha are included by @iobroker/testing"

Kept as devDependencies deliberately. `@iobroker/testing` declares mocha as its
own dependency, so npm installs it **nested** at
`node_modules/@iobroker/testing/node_modules/mocha` and its binary is never
linked into `node_modules/.bin`. With them removed, `npm test` fails with
`mocha: command not found` and the suite cannot run at all. The official
TypeScript adapter template keeps mocha for the same reason.

## E2000 — "Package not found on npm. Please publish"

This adapter is internal to the venue estate and is installed from a tarball via
the admin UI's custom install. It is not intended for npm or the ioBroker
community repository. The gate documentation lists E2000 as acceptable
pre-publish.

## E3032 — "Release has not yet been tagged"

Resolved by the release itself; the tag is created by `npm run release`.

## W4001 — "Cannot find adapter in latest repository"

Follows from E2000: the adapter is not being submitted to the community
repository.

## S8005 / W3038 / W3050 / W3052 — no npm release, no CI history

All downstream of the above: there is no published release for the checker to
inspect, and the first workflow run has no completed jobs to read.

## Review record

V2.0 review passed at round 3, with a fresh reviewer each round.

- Round 1 — FAIL, 7 findings: unclamped intervals, overlapping polls, no unload
  gating, a refresh that reported success when it failed, a five-minute window
  where writes were rejected while reporting connected, an author-specific
  folder default warning every poll, and a bare setTimeout.
- Round 2 — FAIL, 2 findings, both defects *in round 1's fixes*: the unload guard
  applied to one poll path but not the other, and a folder latch that closed
  before its await so a timeout permanently disabled folder scoping.
- Round 3 — PASS, no action needed.
