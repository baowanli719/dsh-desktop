import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import semver from 'semver'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>
}

interface ClientRegistration {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => unknown
}

const clientPlugins = [
  'dsh-better-sidebar',
  '@huanlin/dsh-plugin-better-sidebar-plugin-office',
] as const

function packageJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as Record<string, unknown>
}

function clientRegistration(name: string): ClientRegistration {
  const registrations: ClientRegistration[] = []
  const source = readFileSync(require.resolve(`${name}/client`), 'utf8')
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (registration: ClientRegistration) => registrations.push(registration),
      },
    },
  }, { filename: `${name}/client.js` })
  expect(registrations).toHaveLength(1)
  return registrations[0] as ClientRegistration
}

describe('stable Renderer client plugin bundles', () => {
  it.each(clientPlugins)('%s ships a loadable bundle with the canonical module id', (name) => {
    const manifest = packageJson(name)
    const registration = clientRegistration(name)

    expect(manifest.name).toBe(name)
    expect(registration.id).toBe(name)
    expect(registration.factory).toBeTypeOf('function')
  })

  it.each(clientPlugins)('%s peer requirements match the pinned desktop runtime', (name) => {
    const manifest = packageJson(name)
    const peers = (manifest.peerDependencies ?? {}) as Record<string, string>
    const optionalPeers = (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>

    for (const [peer, range] of Object.entries(peers)) {
      if (optionalPeers[peer]?.optional === true && packageManifest.dependencies?.[peer] === undefined) continue
      const peerManifest = packageJson(peer)
      expect(
        semver.satisfies(String(peerManifest.version), range, { includePrerelease: true }),
        `${name} requires ${peer}@${range}, received ${String(peerManifest.version)}`,
      ).toBe(true)
    }
  })

  it('pins the compatible sidebar/Office pair used by Harness 0.1.2-rc.1', () => {
    expect(packageJson('dsh-better-sidebar').version).toBe('0.17.1')
    expect(packageJson('@huanlin/dsh-plugin-better-sidebar-plugin-office').version).toBe('0.2.0')
  })
})
