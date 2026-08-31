/**
 * The failure this repo exists to prevent, triggered on purpose.
 *
 *   npm run mismatch -- github-personal
 *
 * We take a correctly bound profile and tell the guard to expect a different
 * account, which is what a copy-pasted config, a reused profile id, or a
 * fallback-to-default lookup does to you in production. Without the guard the
 * run proceeds and posts, deletes or buys as the wrong person.
 */
import { Solari } from "@solarisdk/browser"
import { IdentityGuard, IdentityMismatchError, ProfilePoisoningError } from "../src/index.js"
import { loadManifest } from "../src/manifest.js"

const label = process.argv[2] ?? "github-personal"
const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

try {
  const manifest = await loadManifest("./profiles.json")
  const entry = manifest.profiles.find((p) => p.label === label)
  if (!entry) throw new Error(`no profile labelled "${label}"`)

  const realExpectation = entry.expect
  entry.expect = "someone-else-entirely"
  const guard = new IdentityGuard({ solari, manifest })

  // 1. The read path: the guard refuses to hand back a usable browser.
  try {
    const browser = await guard.launch(label)
    await browser.close()
    console.error("guard did NOT catch the mismatch, which is a bug")
    process.exitCode = 1
  } catch (err) {
    if (err instanceof IdentityMismatchError) {
      console.log(`launch blocked: expected ${err.expected}, profile holds ${err.actual}`)
    } else {
      throw err
    }
  }

  // 2. The write path, which is the one that leaves damage. Launch honestly,
  //    then try to save the session into a profile that belongs to someone else.
  entry.expect = realExpectation
  const browser = await guard.launch(label)
  try {
    entry.expect = "someone-else-entirely"
    await guard.save(label, browser.page)
    console.error("save was allowed, which is a bug")
    process.exitCode = 1
  } catch (err) {
    if (err instanceof ProfilePoisoningError) {
      console.log(`save blocked: ${err.message}`)
    } else {
      throw err
    }
  } finally {
    await browser.close()
  }
} finally {
  await solari.close()
}
