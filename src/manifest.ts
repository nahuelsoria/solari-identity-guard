import { readFile, writeFile } from "node:fs/promises"
import { BUILT_IN_PROBES, domProbe, type BuiltInProbeKind, type Probe } from "./probes.js"

/**
 * The manifest is the whole point: Solari's `Profile` is `{ id, name }` and
 * carries no metadata, so there is nowhere on the platform to record *whose*
 * login a profile holds. We keep that binding here, in version control, next
 * to the code that acts on it.
 */

export type ProbeSpec =
  | { kind: BuiltInProbeKind }
  | { kind: "dom"; url: string; selector: string; attribute?: string }

export interface ProfileEntry {
  /** Stable human name used everywhere in code and errors. */
  label: string
  /** Solari profile id (`prf_...`). Empty until the bind step runs. */
  profileId: string
  /** The account this profile is allowed to hold, as the site reports it. */
  expect: string
  probe: ProbeSpec
  /** Default false: most sites treat usernames case-insensitively. */
  caseSensitive?: boolean
}

export interface Manifest {
  profiles: ProfileEntry[]
}

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`)
}

function validateProbe(path: string, probe: unknown): ProbeSpec {
  if (typeof probe !== "object" || probe === null) fail(path, "probe must be an object")
  const p = probe as Record<string, unknown>
  if (typeof p.kind !== "string") fail(path, "probe.kind must be a string")

  if (p.kind === "dom") {
    if (typeof p.url !== "string" || !p.url) fail(path, 'probe.url is required for kind "dom"')
    if (typeof p.selector !== "string" || !p.selector)
      fail(path, 'probe.selector is required for kind "dom"')
    if (p.attribute !== undefined && typeof p.attribute !== "string")
      fail(path, "probe.attribute must be a string when present")
    return {
      kind: "dom",
      url: p.url,
      selector: p.selector,
      ...(p.attribute !== undefined ? { attribute: p.attribute } : {}),
    }
  }

  if (!(p.kind in BUILT_IN_PROBES)) {
    const known = [...Object.keys(BUILT_IN_PROBES), "dom"].join(", ")
    fail(path, `unknown probe kind "${p.kind}". Known kinds: ${known}`)
  }
  return { kind: p.kind as BuiltInProbeKind }
}

export function parseManifest(raw: unknown, source = "manifest"): Manifest {
  if (typeof raw !== "object" || raw === null) fail(source, "must be an object")
  const { profiles } = raw as Record<string, unknown>
  if (!Array.isArray(profiles)) fail(source, "must have a `profiles` array")

  const seen = new Set<string>()
  const parsed = profiles.map((entry, i): ProfileEntry => {
    const path = `${source}.profiles[${i}]`
    if (typeof entry !== "object" || entry === null) fail(path, "must be an object")
    const e = entry as Record<string, unknown>

    if (typeof e.label !== "string" || !e.label) fail(path, "label is required")
    if (seen.has(e.label)) fail(path, `duplicate label "${e.label}"`)
    seen.add(e.label)

    if (typeof e.profileId !== "string") fail(path, "profileId must be a string (empty until bound)")
    if (typeof e.expect !== "string" || !e.expect) fail(path, "expect is required")
    if (e.caseSensitive !== undefined && typeof e.caseSensitive !== "boolean")
      fail(path, "caseSensitive must be a boolean when present")

    return {
      label: e.label,
      profileId: e.profileId,
      expect: e.expect,
      probe: validateProbe(path, e.probe),
      ...(e.caseSensitive !== undefined ? { caseSensitive: e.caseSensitive } : {}),
    }
  })

  return { profiles: parsed }
}

export async function loadManifest(path: string): Promise<Manifest> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    throw new Error(`could not read manifest at ${path}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  return parseManifest(json, path)
}

/**
 * Record a freshly created profile id. Read-modify-write of a single entry so
 * a bind run never clobbers labels it did not touch.
 */
export async function bindProfileId(
  path: string,
  label: string,
  profileId: string,
): Promise<void> {
  const manifest = await loadManifest(path)
  const entry = manifest.profiles.find((p) => p.label === label)
  if (!entry) throw new Error(`${path}: no profile labelled "${label}" to bind`)
  entry.profileId = profileId
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

export function buildProbe(spec: ProbeSpec, label: string): Probe {
  if (spec.kind === "dom") {
    return domProbe({ name: `dom:${label}`, url: spec.url, selector: spec.selector, ...(spec.attribute !== undefined ? { attribute: spec.attribute } : {}) })
  }
  return BUILT_IN_PROBES[spec.kind]()
}

/** Identifier comparison. Case-insensitive unless the entry opts out. */
export function identityMatches(entry: ProfileEntry, actual: string): boolean {
  if (entry.caseSensitive) return entry.expect.trim() === actual.trim()
  return entry.expect.trim().toLowerCase() === actual.trim().toLowerCase()
}
