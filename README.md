# solari-identity-guard

Fail-closed identity verification for [Solari](https://getsolari.com) browser profiles.

Proves which account is inside a profile before your agent acts on it, and refuses to
persist a session that would overwrite the profile with the wrong login.

Built on the [Solari cookbook](https://github.com/solari-sdk/solari-cookbook) profiles example.

## The problem

Solari profiles are the right primitive. You log in once, attach `profileId`, and stop
paying the 2FA, the bot check and the login on every run.

Two things get in the way, and the first one is not in any doc.

### Attaching a profile does not log the browser in

`launch({ profileId })` delivers the stored state to `session.storageState` and stops
there. A context opened with `newPage()` comes up empty, cookies and localStorage both.
The state has to be handed to the context when you create it:

```ts
const browser = await solari.launch({ profileId })
const context = await browser.newContext({ storageState: browser.session.storageState })
const page = await context.newPage()
```

This is worth stating plainly, because the cookbook's own `browser-profiles-ts` example
does it the other way. Its comment says "run this file twice: the first run logs in and
saves, the second reuses it", and it prints a visit counter kept in localStorage. Run
unmodified against the live API three times, it prints:

```
created profile cmtint9gd01y7o101x3ssica7
visit #1 for this profile
saved profile v2 (106 bytes)

reusing profile cmtint9gd01y7o101x3ssica7
visit #1 for this profile
saved profile v3 (106 bytes)

reusing profile cmtint9gd01y7o101x3ssica7
visit #1 for this profile
saved profile v4 (106 bytes)
```

The profile is reused and a new version is saved every run, and the counter never moves
past one. Nothing restores. `addCookies()` is not a workaround either: it brings the
cookies back and drops localStorage, which is where most current sessions keep their
tokens.

An agent built on that shape runs logged out while looking like it is logged in, which is
the same class of failure as running as the wrong account.

### A profile does not know who it is

The SDK type says as much:

```ts
export interface Profile {
  id: string
  name: string
  [k: string]: unknown
}
```

The API returns more than that under the index signature, but none of it identifies an
account. A real `profiles.create()` response looks like this:

```json
{
  "id": "cmth...", "orgId": "cmth...", "name": "github-personal",
  "sizeBytes": "0", "version": 1, "lastUsedAt": null,
  "createdAt": "2026-08-31T22:11:33.626Z", "storageStateS3Key": null
}
```

Size, version and timestamps, and nothing about whose cookies these are. There is no
`profiles.get()` either, and nothing on the session tells you which account the state
belongs to. `name` is whatever string you passed at creation, and it stays that string
after the underlying login changes.

That produces two more failures, and the second one is worse.

**Reading as the wrong account.** This happens through a copy-pasted profile id, a config
lookup that falls back to a default, or a reordered array. The browser opens, everything
looks fine, and the run posts or deletes or buys as somebody else without raising an
error anywhere.

**Writing the wrong account into a profile.** `profiles.save(id, storageState)` accepts
whatever state you hand it. If a run drifted into another login, an OAuth bounce, a shared
SSO tenant, a redirect into the wrong workspace, saving overwrites the stored session with
that identity. Solari keeps no version history to roll back to, so the profile is now
permanently the wrong person and every future run inherits it.

## What this adds

```ts
const guard = await IdentityGuard.fromFile(solari, "./profiles.json")

// Throws unless the site itself reports the expected account.
const browser = await guard.launch("github-personal")
console.log(browser.identity) // "nahuelsoria"

// ... your automation, on a session whose owner is known ...

// Throws rather than poison the profile with a different login.
await guard.save("github-personal", browser.page)
```

Three pieces:

1. **A manifest in version control** binding each profile id to the account it is allowed
   to hold, and to a probe that can confirm it. Solari has nowhere to put this, so it lives
   next to the code that acts on it.
2. **A guarded launch** that runs the probe before returning a usable browser. Every
   failure path closes the session on the way out, so a rejected launch does not sit there
   holding a concurrency slot.
3. **A guarded save** that re-runs the probe against the live page before writing.

Plus `guard.audit()`, which sweeps every profile and reports which account each one holds.
Stored logins expire, sites force re-auth, passwords change. Running the audit on a
schedule means you find out before a job does.

## Fail closed

A probe that cannot name an account counts as a failure. That matters because a probe
returning nothing is exactly what a logged-out profile looks like, so treating "no answer"
as permission to continue would let every expired login through.

The same applies to the tri-state on `Session.storageState`: `undefined` means no profile
was attached, `null` means the profile is attached and empty. The second one is caught as
its own error, because asking for a login and getting an empty jar means every assertion
after it is about a logged-out browser.

## Errors

| Error | Meaning |
| --- | --- |
| `IdentityMismatchError` | The profile holds a different account than the manifest declares |
| `ProfilePoisoningError` | A save was attempted for a session whose identity does not match |
| `ProfileSignedOutError` | The profile is intact but the site no longer recognises the session |
| `EmptyProfileError` | The profile is attached but carries no cookies or localStorage |
| `IdentityUnverifiableError` | The probe ran and could not tell either way |
| `UnknownProfileError` | The manifest does not describe this profile |

Each one names the failure so the fix is obvious: re-login, re-bind, or go read what the
last run did.

The split between the last two carries most of the value. "Signed out" means the stored
session expired and the fix is a fresh bind. "Unverifiable" means the probe could not tell
and the fix is to go look at the page. A guard that collapses them produces the worst
message available at 3am: "could not read the account", when the real answer was "the
login expired".

That distinction is not a guess. It comes from the local version of this pattern that
already runs here against five Chrome profiles, where a signed-out X session has two
different shapes, the explicit login flow and a silent bounce to the marketing page.
Handling only the first meant every expired session spent the full probe timeout and then
reported the wrong diagnosis.

## Where this comes from

This is a generalisation of something already running in production rather than an idea
sketched against the docs. The same guard runs locally against a fleet of five Chrome profiles, one
per account, and it exists because of a specific afternoon: the debug port was passed through
an environment variable that did not survive the hop into a Windows process, every call
fell back to the default profile, and an hour went by under the confident impression
that one account was being read while the reads were coming from another. Nothing errored,
because nothing was checking.

Publishing to the wrong account cannot be fully undone. The notification reaches the
followers even if the post is deleted a minute later. So the check belongs in code, and
it has to run before the action rather than after it.

Solari's profiles move that fleet into the cloud and remove most of the reasons it was
painful. They do not remove this one.

## Setup

```bash
npm install
export SOLARI_API_KEY=slr_live_...   # console.getsolari.com, the free plan is enough

npm run bind -- github-personal ./storage-state.json
npm run launch -- github-personal
npm run mismatch -- github-personal
npm run audit
```

Binding imports a Playwright `storageState()` export from a browser you are already
signed into, which keeps credentials out of the repo and avoids scripting 2FA. To produce
one against a local Chrome running with a debug port:

```ts
const ctx = await chromium.connectOverCDP("http://127.0.0.1:9222")
await ctx.contexts()[0].storageState({ path: "storage-state.json" })
```

The bind verifies itself. A fresh profile that fails verification is deleted, since there
is no version history to roll back to.

## The manifest

```json
{
  "profiles": [
    {
      "label": "github-personal",
      "profileId": "prf_...",
      "expect": "nahuelsoria",
      "probe": { "kind": "github" }
    },
    {
      "label": "acme-ops",
      "profileId": "prf_...",
      "expect": "ops@acme.example",
      "probe": {
        "kind": "dom",
        "url": "https://app.acme.example/settings",
        "selector": "[data-testid=current-user]",
        "signedOutSelector": "[data-testid=login-form]"
      }
    },
    {
      "label": "acme-spa",
      "profileId": "prf_...",
      "expect": "ops@acme.example",
      "probe": {
        "kind": "localStorage",
        "url": "https://app.acme.example",
        "key": "session",
        "path": "user.email"
      }
    }
  ]
}
```

`expect` is compared case-insensitively unless the entry sets `caseSensitive: true`.

Three probes ship. `github` reads the `meta[name="user-login"]` tag that signed-in pages
carry. `dom` reads a selector on any page, and takes an optional `signedOutSelector` so an
expired session reports as signed out rather than unreadable. `localStorage` reads the key
where single-page apps keep the current user, with an optional dot `path` when the value
is JSON. Write your own with `customProbe(name, fn)` when a site needs more than that.

One warning on writing probes. Pick an element that only exists when logged in. A selector
that also matches a signed-out page will return a string, and the comparison will pass
against a browser that is not logged in at all.

## Verified against the live API

```bash
npm run e2e
```

Every claim above is checked end to end against real Solari infrastructure, using nothing
but an API key. It seeds a throwaway profile, walks the guard through all seven outcomes,
and deletes the profiles on the way out:

```
seeded: {"version":2,"sizeBytes":123}
  OK   launch verified as nahuelsoria
  OK   save allowed when the identity matches (v3)
  OK   launch blocked: expected someone-else, found nahuelsoria
  OK   save blocked before the profile was written
  OK   empty profile caught before navigating
  OK   signed out told apart from unreadable
  audit: good=ok wrong=mismatch empty=empty unbound=unbound
  OK   audit classifies all four states
```

## Tests

```bash
npm test
```

Sixteen tests over the guard's decisions, with no network call. They pin the behaviour that
is easy to regress: a rejected launch closes its session, a blocked save never reaches
`profiles.save()`, an unverifiable probe is a failure rather than a pass, and an empty
profile is told apart from an absent one.

## Gotchas encoded here

- **`contexts()` is empty on a fresh session.** The SDK's doc comment says sessions ship
  with a default context and tells you most callers want `contexts()[0]`. On a session
  that has not opened a page yet, that array has nothing in it, so reading `[0]` hands you
  `undefined` and the next property access throws.
- **`profileId` alone restores nothing.** Covered above, and it is the one that costs you
  a day, because the browser looks fine and the automation behaves as a stranger.
- **`solari.close()` is mandatory.** The client keeps a loopback proxy open for retries.
  Skip it and the process prints its output and then hangs forever.
- **The audit is sequential.** The free plan allows three concurrent browsers, and a
  parallel sweep trips `ConcurrencyLimitExceeded`.
- **A failed launch must close its browser.** Otherwise a run that correctly refuses to act
  still leaks the session it opened. A leaked session also keeps the process alive after
  `solari.close()`, and on the free plan three of them exhaust the concurrency cap and
  every later launch returns `429 ConcurrencyLimitExceeded` until they expire.

## License

MIT
