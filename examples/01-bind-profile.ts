/**
 * Bind a login into a Solari profile, and prove it landed as the right account.
 *
 *   npm run bind -- github-personal ./storage-state.json
 *
 * The state file is a Playwright `storageState()` export from a browser that is
 * already logged in. That is the honest way to seed a cloud profile: no
 * credentials in the repo, no scripted 2FA, and it works for any site whose
 * login you can complete once by hand.
 *
 * To produce one locally against a Chrome you are already signed into:
 *
 *   const ctx = await chromium.connectOverCDP("http://127.0.0.1:9222")
 *   await ctx.contexts()[0].storageState({ path: "storage-state.json" })
 *
 * The bind is transactional in the only way it can be: a fresh profile that
 * fails verification is deleted, because Solari keeps no version history to
 * roll back to.
 */
import { readFile } from "node:fs/promises"
import { Solari, type StorageState } from "@solarisdk/browser"
import { IdentityGuard } from "../src/index.js"
import { bindProfileId, loadManifest } from "../src/manifest.js"

const MANIFEST = "./profiles.json"

const [label, statePath] = process.argv.slice(2)
if (!label || !statePath) {
  console.error("usage: npm run bind -- <label> <storage-state.json>")
  process.exit(1)
}

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

try {
  const manifest = await loadManifest(MANIFEST)
  const entry = manifest.profiles.find((p) => p.label === label)
  if (!entry) throw new Error(`no profile labelled "${label}" in ${MANIFEST}`)
  if (entry.profileId && !process.argv.includes("--force")) {
    throw new Error(
      `"${label}" is already bound to ${entry.profileId}. Overwriting a live profile with an ` +
        `imported state is exactly the poisoning this repo exists to prevent. Pass --force if you mean it.`,
    )
  }

  const state = JSON.parse(await readFile(statePath, "utf8")) as StorageState
  const cookieCount = state.cookies?.length ?? 0
  if (cookieCount === 0) throw new Error(`${statePath} has no cookies, so it is not a logged-in session`)

  const profile = entry.profileId
    ? { id: entry.profileId, name: label }
    : await solari.profiles.create({ name: label })
  console.log(`profile ${profile.id} (${entry.profileId ? "existing" : "created"})`)

  const { version, sizeBytes } = await solari.profiles.save(profile.id, state)
  console.log(`imported ${cookieCount} cookies as v${version}, ${sizeBytes} bytes`)

  await bindProfileId(MANIFEST, label, profile.id)

  // Now the part that makes this a bind and not a hope: open it and ask the
  // site who we are.
  const guard = await IdentityGuard.fromFile(solari, MANIFEST)
  try {
    const browser = await guard.launch(label)
    console.log(`verified: "${label}" is ${browser.identity}`)
    await browser.close()
  } catch (err) {
    if (!entry.profileId) {
      await solari.profiles.delete(profile.id).catch(() => {})
      await bindProfileId(MANIFEST, label, "")
      console.error(`verification failed, deleted the new profile: ${(err as Error).message}`)
    } else {
      console.error(`verification failed on an existing profile: ${(err as Error).message}`)
    }
    process.exitCode = 1
  }
} finally {
  // Required. The client keeps a loopback proxy open and the process hangs without it.
  await solari.close()
}
