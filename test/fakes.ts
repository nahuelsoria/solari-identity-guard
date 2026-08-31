import type { Solari } from "@solarisdk/browser"
import type { Page } from "patchright-core"

/**
 * Enough of the Solari and Playwright surfaces to exercise the guard without a
 * network call. Deliberately hand-rolled: the point of these tests is the
 * guard's decisions, and a mocking library would hide which calls actually
 * reached the SDK.
 */

export interface FakeState {
  /** What the probe reports. `null` means "cannot tell". */
  identity: string | null
  /** Tri-state from Session.storageState. */
  storageState: unknown
  probeThrows?: boolean
  /** false reproduces a fresh session, whose contexts() is empty. */
  hasContexts?: boolean
  /** Recorded so a test can prove a rejected run left nothing behind. */
  closed: boolean
  saveCalls: Array<{ profileId: string; state: unknown }>
}

export function makeFakes(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    identity: "nahuelsoria",
    storageState: { cookies: [] },
    closed: false,
    saveCalls: [],
    ...overrides,
  }

  const page = {
    async goto() {
      if (state.probeThrows) throw new Error("navigation failed")
      return null
    },
    async evaluate() {
      return state.identity
    },
    context() {
      return {
        async storageState() {
          return { cookies: [{ name: "session", value: "abc" }] }
        },
        pages: () => [page],
      }
    },
  } as unknown as Page

  const context = {
    pages: () => [page],
    async newPage() {
      return page
    },
  }
  // Mirrors the real API: a fresh session reports no contexts until a page
  // exists, so the guard has to cope with both shapes.
  const contexts = overrides.hasContexts === false ? [] : [context]

  const browser = {
    id: "ses_fake",
    session: { get storageState() { return state.storageState } },
    contexts: () => contexts,
    async newPage() {
      return page
    },
    async close() {
      state.closed = true
    },
  }

  const solari = {
    async launch() {
      return browser
    },
    profiles: {
      async save(profileId: string, s: unknown) {
        state.saveCalls.push({ profileId, state: s })
        return { version: 1, sizeBytes: 42 }
      },
    },
  } as unknown as Solari

  return { solari, page, state }
}

export const MANIFEST = {
  profiles: [
    {
      label: "github-personal",
      profileId: "prf_1",
      expect: "nahuelsoria",
      probe: { kind: "github" as const },
    },
  ],
}
