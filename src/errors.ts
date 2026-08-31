/**
 * Every failure mode gets its own class, because "the guard threw" is not
 * actionable at 3am. The name tells you whether to re-login, re-bind, or
 * go look at what the last run did to the profile.
 */

export class IdentityGuardError extends Error {
  constructor(
    message: string,
    readonly profileLabel: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** The profile holds a different account than the manifest declares. */
export class IdentityMismatchError extends IdentityGuardError {
  constructor(
    profileLabel: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `profile "${profileLabel}" is logged in as "${actual}", expected "${expected}". ` +
        `Refusing to act. Nothing was written to the profile.`,
      profileLabel,
    )
  }
}

/**
 * The probe ran but could not name an account: logged out, session expired,
 * or the page shape changed. Treated as a failure, never as a pass: a probe
 * that returns nothing is exactly what a logged-out profile looks like.
 */
export class IdentityUnverifiableError extends IdentityGuardError {
  constructor(
    profileLabel: string,
    readonly reason: string,
  ) {
    super(
      `could not determine which account is inside profile "${profileLabel}": ${reason}. ` +
        `Failing closed.`,
      profileLabel,
    )
  }
}

/**
 * Solari attached the profile but it carries no state.
 * `Session.storageState` is tri-state: `undefined` = no profile requested,
 * `null` = profile exists and is empty. An empty profile means the login was
 * never saved (or was deleted), so nothing downstream can be logged in.
 */
export class EmptyProfileError extends IdentityGuardError {
  constructor(profileLabel: string) {
    super(
      `profile "${profileLabel}" is attached but empty, with no cookies and no localStorage. ` +
        `Run the bind step to log in and save it first.`,
      profileLabel,
    )
  }
}

/** The manifest does not describe this profile. */
export class UnknownProfileError extends IdentityGuardError {
  constructor(profileLabel: string, known: string[]) {
    super(
      `no profile labelled "${profileLabel}" in the manifest. Known labels: ${known.join(", ") || "(none)"}.`,
      profileLabel,
    )
  }
}

/** A save was attempted for a session whose identity does not match. */
export class ProfilePoisoningError extends IdentityGuardError {
  constructor(
    profileLabel: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `refusing to save profile "${profileLabel}": the live session is "${actual}" but the profile ` +
        `belongs to "${expected}". Saving would overwrite the stored login with the wrong account, ` +
        `permanently and silently.`,
      profileLabel,
    )
  }
}
