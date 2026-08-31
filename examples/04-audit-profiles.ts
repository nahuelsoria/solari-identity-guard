/**
 * Sweep every profile and report what is actually inside it.
 *
 *   npm run audit
 *
 * Stored logins rot: sessions expire, sites force re-auth, passwords change.
 * Run this on a schedule so you find out before a job does.
 * Exits non-zero if anything is not "ok", so cron can page you.
 */
import { Solari } from "@solarisdk/browser"
import { IdentityGuard } from "../src/index.js"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

try {
  const guard = await IdentityGuard.fromFile(solari, "./profiles.json")
  const rows = await guard.audit()

  const width = Math.max(5, ...rows.map((r) => r.label.length))
  for (const row of rows) {
    const mark = row.status === "ok" ? "ok  " : "FAIL"
    console.log(
      `${mark} ${row.label.padEnd(width)}  expected=${row.expected}  actual=${row.actual ?? "-"}  ` +
        `${row.status}${row.detail ? ` (${row.detail})` : ""}`,
    )
  }

  const bad = rows.filter((r) => r.status !== "ok")
  console.log(`\n${rows.length - bad.length}/${rows.length} profiles healthy`)
  if (bad.length) process.exitCode = 1
} finally {
  await solari.close()
}
