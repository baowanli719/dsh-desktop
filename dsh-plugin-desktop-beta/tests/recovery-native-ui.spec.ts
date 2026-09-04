import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RecoveryTerminalAction } from '../src/native-ui/recovery/App.tsx'
import { RecoveryActionFooter, RecoveryActionLink } from '../src/native-ui/shared/RecoveryWindowPrimitives.tsx'
import { desktopRecoveryCopy } from '../src/recovery-copy.ts'

describe('Recovery native terminal action', () => {
  it('adds Quick recovery before the original Recovery Assistant pages', () => {
    const source = readFileSync(new URL('../src/native-ui/recovery/App.tsx', import.meta.url), 'utf8')
    expect(source.match(/<TabsTrigger value=/gu)).toHaveLength(5)
    expect(source).toContain('<TabsTrigger value="quick">')
    expect(source).toContain('<TabsTrigger value="plugins">')
    expect(source).toContain('<TabsTrigger value="rollback">')
    expect(source).toContain('<TabsTrigger value="profiles">')
    expect(source).toContain('<TabsTrigger value="diagnostics">')
    expect(source).toContain('<SafeModePanel copy={copy} state={state} />')
    expect(source).toContain('<CardTitle className="flex items-center gap-2"><CircleHelp className="size-5" />{copy.quickRecovery}</CardTitle>')
    expect(source).toContain('<CardTitle className="flex items-center gap-2"><Users className="size-5" />{copy.profileGuide}</CardTitle>')
    expect(source).toContain('<TabsContent value="plugins"><PluginsPanel copy={copy} state={state} /></TabsContent>')
    expect(source).toContain('<TabsContent value="rollback"><RollbackPanel copy={copy} state={state} /></TabsContent>')
    expect(source).toContain('<TabsContent value="profiles"><ProfilesPanel copy={copy} state={state} /></TabsContent>')
  })

  it('uses the shared ScrollArea for the standalone Profile selector', () => {
    const source = readFileSync(new URL('../src/native-ui/profile-selector/App.tsx', import.meta.url), 'utf8')
    expect(source).toContain("from '../components/ui/scroll-area.tsx'")
    expect(source).toContain('<ScrollArea className="min-h-0 flex-1 pr-3">')
    expect(source).not.toContain('overflow-y-auto')
  })

  it('renders a labelled pill opposite each platform native-control group', () => {
    const copy = desktopRecoveryCopy('en')
    const mac = renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=true&platform=darwin',
    }))
    const windows = renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=true&platform=win32',
    }))

    expect(mac).toContain('right-3')
    expect(mac).not.toContain('left-3')
    expect(windows).toContain('left-3')
    expect(windows).not.toContain('right-3')
    for (const markup of [mac, windows]) {
      expect(markup).toContain('rounded-full')
      expect(markup).toContain('Open DSH Terminal')
      expect(markup).toContain('dsh-recovery://open-terminal')
    }
  })

  it('does not invent a title-row action without Desktop frame controls', () => {
    const copy = desktopRecoveryCopy('en')
    expect(renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=false&platform=darwin',
    }))).toBe('')
    expect(renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=true&platform=linux',
    }))).toBe('')
  })

  it('shares the Recovery footer layout while keeping a leading action on the left', () => {
    const markup = renderToStaticMarkup(createElement(
      RecoveryActionFooter,
      {
        leading: createElement(RecoveryActionLink, { children: 'Back', href: 'dsh-profile-selector://cancel' }),
        children: createElement(RecoveryActionLink, {
          children: 'Restart DSH Desktop',
          href: 'dsh-profile-selector://restart',
          variant: 'default',
        }),
      },
    ))

    expect(markup).toContain('mr-auto')
    expect(markup).toContain('dsh-profile-selector://cancel')
    expect(markup).toContain('dsh-profile-selector://restart')
  })
})
