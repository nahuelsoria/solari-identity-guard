import type { Page } from "patchright-core"

/**
 * A probe answers one question: which account is this browser logged into?
 *
 * It reports one of three outcomes, and the split between the last two matters
 * more than it looks. "Signed out" means the stored session is gone and the fix
 * is to re-bind. "Unknown" means the probe could not tell, and the fix is to go
 * look at the page. Collapsing them into a single failure produces the worst
 * possible message at 3am: "could not read the account" when the real answer
 * was "the login expired".
 */
export type ProbeOutcome =
  | { status: "identified"; identity: string }
  | { status: "signed-out" }
  | { status: "unknown"; reason: string }

export interface Probe {
  /** Shown in errors and audit output. */
  readonly name: string
  run(page: Page): Promise<ProbeOutcome>
}

/** How long a probe may take before we call it unknown. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * GitHub. Every HTML page served to a signed-in user carries
 * `<meta name="user-login" content="...">`; signed-out pages omit it.
 * Cheaper and more stable than scraping the avatar menu, and it does not touch
 * /settings, which can prompt for sudo re-auth and burn the run.
 */
export function githubProbe(): Probe {
  return {
    name: "github",
    async run(page) {
      await page.goto("https://github.com/", {
        waitUntil: "domcontentloaded",
        timeout: PROBE_TIMEOUT_MS,
      })
      const seen = await page.evaluate(() => ({
        login: document.querySelector('meta[name="user-login"]')?.getAttribute("content")?.trim() ?? "",
        // The signed-out homepage is the marketing page, which always offers a
        // way in. Without this check an expired session reads as "unknown".
        hasSignIn: Boolean(
          document.querySelector('a[href^="/login"], a[href*="/session"], form[action="/session"]'),
        ),
        url: location.href,
      }))
      if (seen.login) return { status: "identified", identity: seen.login }
      if (seen.hasSignIn) return { status: "signed-out" }
      return { status: "unknown", reason: `no user-login meta and no sign-in affordance at ${seen.url}` }
    },
  }
}

/**
 * Generic DOM probe: open `url`, read the account name out of `selector`.
 * Reads `attribute` when given, otherwise the trimmed text.
 *
 * Give it `signedOutSelector` whenever the site has a recognisable logged-out
 * state. Without it every expired session reports as unknown.
 *
 * Pick an element that only exists when logged in. A selector that also matches
 * a signed-out page will return a string, and the comparison will pass against
 * a browser that is not logged in at all.
 */
export function domProbe(opts: {
  name: string
  url: string
  selector: string
  attribute?: string
  signedOutSelector?: string
}): Probe {
  return {
    name: opts.name,
    async run(page) {
      await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS })

      const el = page.locator(opts.selector).first()
      // Short wait: the element is either rendered for a logged-in user or it
      // is not. Waiting the full navigation timeout here only slows failures.
      try {
        await el.waitFor({ state: "attached", timeout: 5_000 })
      } catch {
        if (opts.signedOutSelector) {
          const out = await page.locator(opts.signedOutSelector).first().count()
          if (out > 0) return { status: "signed-out" }
        }
        return { status: "unknown", reason: `selector ${opts.selector} never attached` }
      }

      const raw = opts.attribute ? await el.getAttribute(opts.attribute) : await el.textContent()
      const value = raw?.trim()
      if (!value) return { status: "unknown", reason: `selector ${opts.selector} matched but was empty` }
      return { status: "identified", identity: value }
    },
  }
}

/** Escape hatch: bring your own logic when a site needs more than a selector. */
export function customProbe(name: string, run: (page: Page) => Promise<ProbeOutcome>): Probe {
  return { name, run }
}

export const BUILT_IN_PROBES = {
  github: githubProbe,
} as const

export type BuiltInProbeKind = keyof typeof BUILT_IN_PROBES
