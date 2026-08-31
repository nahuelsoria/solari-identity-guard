import type { BrowserContext, Page } from "patchright-core"
import type { LaunchOptions, Solari, StorageState } from "@solarisdk/browser"
import {
  EmptyProfileError,
  IdentityMismatchError,
  IdentityUnverifiableError,
  ProfilePoisoningError,
  UnknownProfileError,
} from "./errors.js"
import {
  buildProbe,
  identityMatches,
  loadManifest,
  type Manifest,
  type ProfileEntry,
} from "./manifest.js"

/** A launched session whose logged-in account has been proven. */
export interface GuardedBrowser extends AsyncDisposable {
  /** The account the probe actually found. Equal to the manifest's `expect`. */
  readonly identity: string
  readonly label: string
  /** Default context, the one carrying the profile's cookies and localStorage. */
  readonly context: BrowserContext
  /** A ready page in that context, already used for the probe. */
  readonly page: Page
  readonly sessionId: string
  close(): Promise<void>
}

export type AuditStatus = "ok" | "mismatch" | "empty" | "unverifiable" | "unbound"

export interface AuditRow {
  label: string
  expected: string
  actual: string | null
  status: AuditStatus
  detail?: string
}

export interface IdentityGuardOptions {
  solari: Solari
  manifest: Manifest
  /** Where the manifest was read from, for error messages and rebinding. */
  manifestPath?: string
}

export class IdentityGuard {
  private readonly solari: Solari
  private readonly manifest: Manifest

  constructor(opts: IdentityGuardOptions) {
    this.solari = opts.solari
    this.manifest = opts.manifest
  }

  static async fromFile(solari: Solari, path: string): Promise<IdentityGuard> {
    return new IdentityGuard({ solari, manifest: await loadManifest(path), manifestPath: path })
  }

  get labels(): string[] {
    return this.manifest.profiles.map((p) => p.label)
  }

  entry(label: string): ProfileEntry {
    const found = this.manifest.profiles.find((p) => p.label === label)
    if (!found) throw new UnknownProfileError(label, this.labels)
    return found
  }

  /**
   * Launch with the profile attached and prove the account before returning.
   *
   * Nothing that can act on the page escapes this method unverified: every
   * failure path closes the session on the way out, so a rejected launch does
   * not sit there eating a concurrency slot.
   */
  async launch(label: string, options: LaunchOptions = {}): Promise<GuardedBrowser> {
    const entry = this.entry(label)
    if (!entry.profileId) {
      throw new UnknownProfileError(
        label,
        this.labels.filter((l) => this.entry(l).profileId),
      )
    }

    const browser = await this.solari.launch({ ...options, profileId: entry.profileId })

    try {
      // Tri-state, straight off the session: `undefined` means no profile was
      // attached at all, `null` means the profile exists but holds nothing.
      // The second one is the interesting failure. You asked for a login and
      // got an empty jar, so every assertion after this would be about a
      // logged-out browser.
      if (browser.session.storageState === null) throw new EmptyProfileError(label)

      // The profile's cookies live in the session's default context. Opening a
      // fresh one via `newPage()` is not the same thing, so reach for
      // `contexts()[0]` and reuse its page when it already has one.
      const context = browser.contexts()[0]
      if (!context) throw new IdentityUnverifiableError(label, "session exposed no browser context")
      const page = context.pages()[0] ?? (await context.newPage())

      const probe = buildProbe(entry.probe, label)
      let actual: string | null
      try {
        actual = await probe.run(page)
      } catch (err) {
        throw new IdentityUnverifiableError(label, `probe "${probe.name}" threw: ${(err as Error).message}`)
      }
      if (!actual) {
        throw new IdentityUnverifiableError(
          label,
          `probe "${probe.name}" found no signed-in account (the profile is probably logged out or expired)`,
        )
      }
      if (!identityMatches(entry, actual)) {
        throw new IdentityMismatchError(label, entry.expect, actual)
      }

      const guarded: GuardedBrowser = {
        identity: actual,
        label,
        context,
        page,
        sessionId: browser.id,
        close: () => browser.close(),
        [Symbol.asyncDispose]: () => browser.close(),
      }
      return guarded
    } catch (err) {
      await browser.close().catch(() => {})
      throw err
    }
  }

  /**
   * Persist the live session back into the profile, but only after proving the
   * page still holds the right account.
   *
   * This is the half nobody builds. `profiles.save()` takes whatever storage
   * state you hand it, so a run that drifted into another login (an OAuth
   * bounce, a shared SSO tenant, a redirect to the wrong workspace) will
   * happily overwrite the stored session with the wrong identity. There is no
   * version history to walk back to, and the next run starts as the wrong
   * person with no error anywhere.
   */
  async save(label: string, page: Page): Promise<{ version: number; sizeBytes: number }> {
    const entry = this.entry(label)
    const probe = buildProbe(entry.probe, label)

    let actual: string | null
    try {
      actual = await probe.run(page)
    } catch (err) {
      throw new IdentityUnverifiableError(label, `probe "${probe.name}" threw during save: ${(err as Error).message}`)
    }
    if (!actual) {
      throw new IdentityUnverifiableError(label, `probe "${probe.name}" found no signed-in account during save`)
    }
    if (!identityMatches(entry, actual)) {
      throw new ProfilePoisoningError(label, entry.expect, actual)
    }

    const state = (await page.context().storageState()) as StorageState
    return this.solari.profiles.save(entry.profileId, state)
  }

  /**
   * Walk every bound profile and report what is actually inside it.
   *
   * Stored logins rot quietly: sessions expire, a site forces re-auth, someone
   * changes a password. You want to find that on your schedule rather than
   * halfway through a run. Sequential on purpose, because the free plan allows three
   * concurrent browsers and a parallel sweep trips `ConcurrencyLimitExceeded`.
   */
  async audit(labels: string[] = this.labels): Promise<AuditRow[]> {
    const rows: AuditRow[] = []
    for (const label of labels) {
      const entry = this.entry(label)
      if (!entry.profileId) {
        rows.push({ label, expected: entry.expect, actual: null, status: "unbound", detail: "no profileId yet" })
        continue
      }
      try {
        const browser = await this.launch(label)
        rows.push({ label, expected: entry.expect, actual: browser.identity, status: "ok" })
        await browser.close()
      } catch (err) {
        if (err instanceof IdentityMismatchError) {
          rows.push({ label, expected: entry.expect, actual: err.actual, status: "mismatch" })
        } else if (err instanceof EmptyProfileError) {
          rows.push({ label, expected: entry.expect, actual: null, status: "empty" })
        } else {
          rows.push({
            label,
            expected: entry.expect,
            actual: null,
            status: "unverifiable",
            detail: (err as Error).message,
          })
        }
      }
    }
    return rows
  }
}
