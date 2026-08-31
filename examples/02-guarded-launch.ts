/**
 * The everyday path: launch, and act only on a session whose account is proven.
 *
 *   npm run launch -- github-personal
 *
 * Compare with the raw SDK, where `solari.launch({ profileId })` hands you a
 * browser and says nothing about who is inside it.
 */
import { Solari } from "@solarisdk/browser"
import { IdentityGuard } from "../src/index.js"

const label = process.argv[2] ?? "github-personal"
const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

try {
  const guard = await IdentityGuard.fromFile(solari, "./profiles.json")

  // Nothing that can act escapes this call unverified. A mismatch throws here,
  // before the first line of your automation runs.
  const browser = await guard.launch(label)
  console.log(`acting as ${browser.identity} (session ${browser.sessionId})`)

  try {
    await browser.page.goto("https://github.com/settings/profile", { waitUntil: "domcontentloaded" })
    console.log("title:", await browser.page.title())
  } finally {
    await browser.close()
  }
} finally {
  await solari.close()
}
