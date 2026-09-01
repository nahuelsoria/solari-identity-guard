/**
 * Proves every claim in the README against the live API, with no credentials
 * beyond a Solari key.
 *
 *   npm run e2e
 *
 * It seeds a throwaway profile with an account name in localStorage, then walks
 * the guard through all seven outcomes: a verified launch, an allowed save, a
 * blocked launch, a blocked save, an empty profile, a signed-out profile, and
 * an audit over all four states. Both profiles are deleted on the way out.
 *
 * Sequential on purpose, because the free plan caps concurrency at three.
 */
import { writeFile, unlink } from "node:fs/promises"
import { Solari } from "@solarisdk/browser"
import { IdentityGuard } from "../src/index.js"
import {
  EmptyProfileError, IdentityMismatchError, ProfilePoisoningError, ProfileSignedOutError,
} from "../src/errors.js"

const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
const ok = (s: string) => log("  OK  ", s)
const bad = (s: string) => { log("  FAIL", s); process.exitCode = 1 }

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const MF = "./.e2e-manifest.json"
const URL = "https://example.com"
const KEY = "guard-account"
let bound = "", empty = ""

const manifest = (expect: string, profileId: string) => ({
  profiles: [{ label: "demo", profileId, expect, probe: { kind: "localStorage", url: URL, key: KEY } }],
})
const write = (expect: string, profileId: string) =>
  writeFile(MF, JSON.stringify(manifest(expect, profileId), null, 2))

try {
  bound = (await solari.profiles.create({ name: `e2e-bound-${Date.now()}` })).id
  empty = (await solari.profiles.create({ name: `e2e-empty-${Date.now()}` })).id
  log("profiles:", bound, "/", empty)

  // --- seed: write the identity and store it ---
  let b = await solari.launch({ profileId: bound })
  try {
    const ctx = await b.newContext({ storageState: b.session.storageState as any })
    const p = await ctx.newPage()
    await p.goto(URL, { waitUntil: "domcontentloaded" })
    await p.evaluate((k: string) => localStorage.setItem(k, "nahuelsoria"), KEY)
    log("seeded:", JSON.stringify(await solari.profiles.save(bound, (await ctx.storageState()) as any)))
  } finally { await b.close() }

  // --- 1. verified launch ---
  await write("nahuelsoria", bound)
  let guard = await IdentityGuard.fromFile(solari, MF)
  const gb = await guard.launch("demo")
  gb.identity === "nahuelsoria" ? ok(`launch verified as ${gb.identity}`) : bad(`wrong identity ${gb.identity}`)

  // --- 2. legitimate save on that live session ---
  try {
    const r = await guard.save("demo", gb.page)
    ok(`save allowed when the identity matches (v${r.version})`)
  } catch (e) { bad(`legitimate save refused: ${(e as Error).message}`) }
  await gb.close()

  // --- 3. mismatch on the read path ---
  await write("someone-else", bound)
  guard = await IdentityGuard.fromFile(solari, MF)
  try { await (await guard.launch("demo")).close(); bad("mismatch NOT blocked") }
  catch (e) { e instanceof IdentityMismatchError ? ok(`launch blocked: expected ${e.expected}, found ${e.actual}`) : bad(`unexpected error: ${(e as Error).message}`) }

  // --- 4. poisoning on the write path ---
  await write("nahuelsoria", bound)
  guard = await IdentityGuard.fromFile(solari, MF)
  const good = await guard.launch("demo")
  try {
    const g2 = new IdentityGuard({ solari, manifest: manifest("someone-else", bound) as any })
    await g2.save("demo", good.page)
    bad("poisoning save NOT blocked")
  } catch (e) { e instanceof ProfilePoisoningError ? ok("save blocked before the profile was written") : bad(`unexpected error: ${(e as Error).message}`) }
  finally { await good.close() }

  // --- 5. empty profile ---
  await write("nahuelsoria", empty)
  guard = await IdentityGuard.fromFile(solari, MF)
  try { await (await guard.launch("demo")).close(); bad("empty profile NOT detected") }
  catch (e) { e instanceof EmptyProfileError ? ok("empty profile caught before navigating") : bad(`unexpected error: ${(e as Error).message}`) }

  // --- 6. signed out: the key is absent ---
  await writeFile(MF, JSON.stringify({ profiles: [{ label: "demo", profileId: bound, expect: "nahuelsoria",
    probe: { kind: "localStorage", url: URL, key: "a-key-that-does-not-exist" } }] }, null, 2))
  guard = await IdentityGuard.fromFile(solari, MF)
  try { await (await guard.launch("demo")).close(); bad("signed out NOT detected") }
  catch (e) { e instanceof ProfileSignedOutError ? ok("signed out told apart from unreadable") : bad(`unexpected error: ${(e as Error).message}`) }

  // --- 7. audit ---
  await writeFile(MF, JSON.stringify({ profiles: [
    { label: "good", profileId: bound, expect: "nahuelsoria", probe: { kind: "localStorage", url: URL, key: KEY } },
    { label: "wrong", profileId: bound, expect: "otro", probe: { kind: "localStorage", url: URL, key: KEY } },
    { label: "empty", profileId: empty, expect: "x", probe: { kind: "localStorage", url: URL, key: KEY } },
    { label: "unbound", profileId: "", expect: "x", probe: { kind: "localStorage", url: URL, key: KEY } },
  ] }, null, 2))
  guard = await IdentityGuard.fromFile(solari, MF)
  const rows = await guard.audit()
  log("audit:", rows.map((r) => `${r.label}=${r.status}`).join(" "))
  const expected = "good=ok wrong=mismatch empty=empty unbound=unbound"
  rows.map((r) => `${r.label}=${r.status}`).join(" ") === expected
    ? ok("audit classifies all four states")
    : bad("audit returned something else")
} catch (err) {
  log("RUN FAILED:", (err as Error).message); process.exitCode = 1
} finally {
  for (const id of [bound, empty]) if (id) await solari.profiles.delete(id).catch(() => {})
  await unlink(MF).catch(() => {})
  await solari.close()
  log("done")
}
