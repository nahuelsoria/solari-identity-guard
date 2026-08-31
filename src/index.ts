export { IdentityGuard } from "./guard.js"
export type { GuardedBrowser, AuditRow, AuditStatus, IdentityGuardOptions } from "./guard.js"
export {
  IdentityGuardError,
  IdentityMismatchError,
  IdentityUnverifiableError,
  EmptyProfileError,
  UnknownProfileError,
  ProfilePoisoningError,
  ProfileSignedOutError,
} from "./errors.js"
export { githubProbe, domProbe, customProbe, type Probe, type ProbeOutcome } from "./probes.js"
export {
  loadManifest,
  parseManifest,
  bindProfileId,
  identityMatches,
  type Manifest,
  type ProfileEntry,
  type ProbeSpec,
} from "./manifest.js"
