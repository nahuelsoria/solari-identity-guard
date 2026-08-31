import { test } from "node:test"
import assert from "node:assert/strict"
import { IdentityGuard } from "../src/guard.js"
import {
  EmptyProfileError,
  IdentityMismatchError,
  IdentityUnverifiableError,
  ProfilePoisoningError,
  ProfileSignedOutError,
  UnknownProfileError,
} from "../src/errors.js"
import { parseManifest, identityMatches } from "../src/manifest.js"
import { makeFakes, MANIFEST } from "./fakes.js"

const guardFor = (overrides = {}, manifest = structuredClone(MANIFEST)) => {
  const fakes = makeFakes(overrides)
  return { guard: new IdentityGuard({ solari: fakes.solari, manifest }), ...fakes }
}

test("launch returns the verified identity when the account matches", async () => {
  const { guard } = guardFor()
  const browser = await guard.launch("github-personal")
  assert.equal(browser.identity, "nahuelsoria")
  assert.equal(browser.label, "github-personal")
})

test("launch rejects a profile holding a different account", async () => {
  const { guard, state } = guardFor({ identity: "someone-else" })
  await assert.rejects(() => guard.launch("github-personal"), IdentityMismatchError)
  assert.equal(state.closed, true, "a rejected launch must not leak its session")
})

test("launch fails closed when the probe cannot name an account", async () => {
  const { guard, state } = guardFor({ identity: null })
  await assert.rejects(() => guard.launch("github-personal"), IdentityUnverifiableError)
  assert.equal(state.closed, true)
})

test("an expired session is reported as signed out, not as unverifiable", async () => {
  const { guard, state } = guardFor({ identity: null, signedOut: true })
  await assert.rejects(() => guard.launch("github-personal"), ProfileSignedOutError)
  assert.equal(state.closed, true)
})

test("save refuses to overwrite a good profile with a signed-out session", async () => {
  const { guard, page, state } = guardFor({ identity: null, signedOut: true })
  await assert.rejects(() => guard.save("github-personal", page), ProfileSignedOutError)
  assert.deepEqual(state.saveCalls, [])
})

test("launch fails closed when the probe throws", async () => {
  const { guard, state } = guardFor({ probeThrows: true })
  await assert.rejects(() => guard.launch("github-personal"), IdentityUnverifiableError)
  assert.equal(state.closed, true)
})

test("launch distinguishes an attached-but-empty profile", async () => {
  const { guard, state } = guardFor({ storageState: null })
  await assert.rejects(() => guard.launch("github-personal"), EmptyProfileError)
  assert.equal(state.closed, true)
})

test("launch rejects a label the manifest does not describe", async () => {
  const { guard } = guardFor()
  await assert.rejects(() => guard.launch("nope"), UnknownProfileError)
})

test("save refuses to poison a profile and writes nothing", async () => {
  const manifest = structuredClone(MANIFEST)
  const { guard, page, state } = guardFor({ identity: "someone-else" }, manifest)
  await assert.rejects(() => guard.save("github-personal", page), ProfilePoisoningError)
  assert.deepEqual(state.saveCalls, [], "a blocked save must not reach profiles.save")
})

test("save writes when the live session still holds the right account", async () => {
  const { guard, page, state } = guardFor()
  const res = await guard.save("github-personal", page)
  assert.equal(res.version, 1)
  assert.equal(state.saveCalls.length, 1)
  assert.equal(state.saveCalls[0]?.profileId, "prf_1")
})

test("audit labels each profile with what is inside it", async () => {
  const ok = guardFor()
  assert.deepEqual(
    (await ok.guard.audit()).map((r) => r.status),
    ["ok"],
  )

  const mismatched = guardFor({ identity: "someone-else" })
  const rows = await mismatched.guard.audit()
  assert.equal(rows[0]?.status, "mismatch")
  assert.equal(rows[0]?.actual, "someone-else")

  const empty = guardFor({ storageState: null })
  assert.equal((await empty.guard.audit())[0]?.status, "empty")

  const out = guardFor({ identity: null, signedOut: true })
  assert.equal((await out.guard.audit())[0]?.status, "signed-out")

  const unbound = guardFor({}, { profiles: [{ ...MANIFEST.profiles[0]!, profileId: "" }] })
  assert.equal((await unbound.guard.audit())[0]?.status, "unbound")
})

test("manifest validation rejects the mistakes that cause mix-ups", () => {
  assert.throws(() => parseManifest({}), /profiles/)
  assert.throws(
    () => parseManifest({ profiles: [{ label: "a", profileId: "", expect: "x", probe: { kind: "nope" } }] }),
    /unknown probe kind/,
  )
  assert.throws(
    () =>
      parseManifest({
        profiles: [
          { label: "dup", profileId: "", expect: "x", probe: { kind: "github" } },
          { label: "dup", profileId: "", expect: "y", probe: { kind: "github" } },
        ],
      }),
    /duplicate label/,
  )
  assert.throws(
    () => parseManifest({ profiles: [{ label: "a", profileId: "", probe: { kind: "github" } }] }),
    /expect is required/,
  )
  assert.throws(
    () => parseManifest({ profiles: [{ label: "a", profileId: "", expect: "x", probe: { kind: "dom", url: "u" } }] }),
    /selector is required/,
  )
})

test("identity comparison ignores case unless the entry opts out", () => {
  const base = { label: "l", profileId: "p", expect: "NahuelSoria", probe: { kind: "github" as const } }
  assert.equal(identityMatches(base, "nahuelsoria"), true)
  assert.equal(identityMatches(base, " nahuelsoria "), true)
  assert.equal(identityMatches({ ...base, caseSensitive: true }, "nahuelsoria"), false)
  assert.equal(identityMatches(base, "someone-else"), false)
})

test("launch works on a fresh session whose contexts() is still empty", async () => {
  const { guard } = guardFor({ hasContexts: false })
  const browser = await guard.launch("github-personal")
  assert.equal(browser.identity, "nahuelsoria")
})

test("launch reuses an existing context when the session already has one", async () => {
  const { guard } = guardFor({ hasContexts: true })
  const browser = await guard.launch("github-personal")
  assert.equal(browser.identity, "nahuelsoria")
})
