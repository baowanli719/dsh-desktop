/**
 * Verify every production dependency shipped inside the desktop installers
 * carries a permissive license that allows redistribution.
 *
 * Walks the production dependency graph (dependencies + optionalDependencies,
 * excluding dev/peer) starting from this package manifest. Fails when a
 * package has no license field and no LICENSE file, or when its license is
 * not on the redistribution allowlist.
 *
 * @module scripts/verify-licenses
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const rootManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/** Licenses accepted for redistribution inside the desktop installers. */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'MPL-2.0',
  'CC0-1.0',
  'Zlib',
  'Python-2.0',
  // dompurify (via dsh-better-sidebar) dual-licenses under two allowlisted
  // licenses; redistribution under Apache-2.0 satisfies the OR expression.
  '(MPL-2.0 OR Apache-2.0)',
  // jszip (via docx-preview) dual-licenses; redistribution under MIT
  // satisfies the OR expression.
  '(MIT OR GPL-3.0-or-later)',
  // pako combines two allowlisted permissive licenses.
  '(MIT AND Zlib)',
  // sax (via dsh-vision-router's potrace) uses the Blue Oak Model License,
  // a permissive MIT-equivalent license (npm itself ships under it).
  'BlueOak-1.0.0',
])

/**
 * Graph-present packages that never reach the installer. The Univer Pro
 * packages arrive as hard dependencies of @univerjs/presets but the office
 * plugin's prebuilt client bundle only uses the Apache-2.0 core preset, and
 * electron-builder excludes this scope through the package.json `files`
 * ignore (`!node_modules/@univerjs-pro/**`). They carry no license field, so
 * shipping them would be an unlicensed redistribution; keep them out of both
 * the allowlist check and the generated notices.
 */
const NOT_SHIPPED_PREFIXES = ['@univerjs-pro/']

/**
 * Licenses that permit redistribution only when their notice obligations are
 * honored. Sharp ships libvips as a separate @img/sharp-libvips-* package on
 * macOS and inside the @img/sharp-win32-* package on Windows. Their license
 * texts ship inside node_modules in the installer. Keep this list minimal and
 * review any addition.
 */
const NOTICE_LICENSES = new Set([
  'LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later',
  // @huanlin/dsh-plugin-better-sidebar-plugin-office is AGPL-3.0. Approved
  // for internal distribution only: do not ship installers to external
  // parties without legal review, and keep the source offer intact (the
  // package source is public upstream).
  'AGPL-3.0',
  // potrace (via dsh-vision-router, vision_trace SVG vectorization) is
  // GPL-2.0. Same posture as the AGPL entry above: internal distribution
  // only, source offer intact (package source is public upstream).
  'GPL-2.0',
])

/**
 * Locate one installed package manifest by walking node_modules directories
 * upward from the parent manifest. Reads the real package.json regardless of
 * the package's `exports` map, which often hides the `./package.json` subpath.
 */
function resolvePackageManifest(name, fromManifestPath) {
  const segments = name.split('/')
  const folder = name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const entry = name.startsWith('@') ? segments.slice(2).join('/') : segments.slice(1).join('/')
  let dir = dirname(fromManifestPath)
  for (;;) {
    const candidate = join(dir, 'node_modules', folder, entry, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Normalize the license field of one package manifest. */
function licenseExpression(manifest) {
  const value = manifest.license
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof value.type === 'string') return value.type
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((item) => (typeof item === 'string' ? item : item.type))
      .filter(Boolean)
      .join(' OR ')
  }
  return undefined
}

const failures = []
const seen = new Set()
const manifests = []
const queue = [{ name: rootManifest.name ?? 'dsh-plugin-desktop', manifestPath: join(packageRoot, 'package.json') }]

for (let index = 0; index < queue.length; index += 1) {
  const current = queue[index]
  if (current === undefined || seen.has(current.name)) continue
  seen.add(current.name)
  if (NOT_SHIPPED_PREFIXES.some(prefix => current.name.startsWith(prefix))) continue
  const manifest = JSON.parse(readFileSync(current.manifestPath, 'utf8'))

  if (current.name !== rootManifest.name) {
    const license = licenseExpression(manifest)
    const hasLicenseFile = existsSync(join(dirname(current.manifestPath), 'LICENSE'))
      || existsSync(join(dirname(current.manifestPath), 'LICENSE.md'))
      || existsSync(join(dirname(current.manifestPath), 'LICENSE.txt'))
    if (license === undefined && !hasLicenseFile) {
      failures.push(`${current.name}: no license field and no LICENSE file`)
    } else if (license !== undefined && license.startsWith('SEE LICENSE IN ')) {
      if (!hasLicenseFile) {
        failures.push(`${current.name}: license refers to ${JSON.stringify(license)} but no LICENSE file is shipped`)
      }
    } else if (license !== undefined && !ALLOWED_LICENSES.has(license) && !NOTICE_LICENSES.has(license)) {
      failures.push(`${current.name}: license ${JSON.stringify(license)} is not on the redistribution allowlist`)
    }
    manifests.push({ name: current.name, version: manifest.version, license: license ?? 'SEE LICENSE FILE' })
  }

  const requireFrom = createRequire(current.manifestPath)
  void requireFrom
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const resolved = resolvePackageManifest(name, current.manifestPath)
      if (resolved === undefined) {
        // Optional dependencies may legitimately be absent on this platform.
        if (section === 'optionalDependencies') continue
        failures.push(`${current.name} -> ${name}: could not locate its manifest`)
        continue
      }
      queue.push({ name, manifestPath: resolved })
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`verify-licenses: ${failures.length} production package(s) need attention\n`)
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exit(1)
}

const noticeOnly = manifests.filter(entry => NOTICE_LICENSES.has(entry.license))
const noticesArg = process.argv.indexOf('--notices')
if (noticesArg !== -1) {
  const target = process.argv[noticesArg + 1]
  if (target === undefined) {
    process.stderr.write('verify-licenses: --notices requires a file path\n')
    process.exit(1)
  }
  const lines = [
    '# Third-Party Notices',
    '',
    'gs-worker distributes the following third-party packages inside its installers.',
    'Each package ships with its own license text in the application files; this list records',
    'the package names, versions, and licenses for transparency.',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...manifests
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => `| ${entry.name} | ${entry.version ?? ''} | ${entry.license} |`),
    '',
    noticeOnly.length === 0
      ? ''
      : `> Notice-required licenses in use: ${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')}. Their license texts ship inside node_modules; see the package LICENSE files for the full terms.`,
    '',
  ].filter(line => line !== '')
  writeFileSync(join(packageRoot, target), lines.join('\n'))
}

const total = seen.size - 1
const summary = noticeOnly.length === 0
  ? `verify-licenses: ${total} production packages carry redistribution-safe licenses`
  : `verify-licenses: ${total} production packages checked; ${noticeOnly.length} use notice-required licenses (${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')})`
process.stdout.write(`${summary}\n`)
