import type { Page } from "patchright-core"

/**
 * A probe answers one question: which account is this browser logged into?
 *
 * It returns the account identifier as the site itself reports it, or `null`
 * when it cannot tell. `null` is never treated as success, see
 * `IdentityUnverifiableError`. Throwing is fine too; the guard catches it.
 */
export interface Probe {
  /** Shown in errors and audit output. */
  readonly name: string
  run(page: Page): Promise<string | null>
}

/** How long a probe may take before we call it unverifiable. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * GitHub. Every HTML page served to a signed-in user carries
 * `<meta name="user-login" content="...">`; signed-out pages omit it.
 * Cheaper and far more stable than scraping the avatar menu, and it does not
 * touch /settings (which can prompt for sudo re-auth and burn the run).
 */
export function githubProbe(): Probe {
  return {
    name: "github",
    async run(page) {
      await page.goto("https://github.com/", {
        waitUntil: "domcontentloaded",
        timeout: PROBE_TIMEOUT_MS,
      })
      return page.evaluate(() => {
        const meta = document.querySelector('meta[name="user-login"]')
        const login = meta?.getAttribute("content")?.trim()
        return login ? login : null
      })
    },
  }
}

/**
 * Generic DOM probe for any site: open `url`, read the account name out of
 * `selector`. Reads `attribute` when given, otherwise the trimmed text.
 *
 * Prefer a element that only exists when logged in. A selector that also
 * matches logged-out (a nav link, a placeholder) will happily return a string
 * and defeat the whole point of the guard.
 */
export function domProbe(opts: {
  name: string
  url: string
  selector: string
  attribute?: string
}): Probe {
  return {
    name: opts.name,
    async run(page) {
      await page.goto(opts.url, {
        waitUntil: "domcontentloaded",
        timeout: PROBE_TIMEOUT_MS,
      })
      const el = page.locator(opts.selector).first()
      // Short wait: the element is either rendered for a logged-in user or it
      // is not. Waiting the full navigation timeout here just slows failures.
      try {
        await el.waitFor({ state: "attached", timeout: 5_000 })
      } catch {
        return null
      }
      const raw = opts.attribute
        ? await el.getAttribute(opts.attribute)
        : await el.textContent()
      const value = raw?.trim()
      return value ? value : null
    },
  }
}

/** Escape hatch: bring your own logic when the site needs more than a selector. */
export function customProbe(name: string, run: (page: Page) => Promise<string | null>): Probe {
  return { name, run }
}

export const BUILT_IN_PROBES = {
  github: githubProbe,
} as const

export type BuiltInProbeKind = keyof typeof BUILT_IN_PROBES
