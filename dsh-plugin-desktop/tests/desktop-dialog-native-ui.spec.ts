import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DesktopDialogToneIcon,
  desktopDialogAdvisoryLines,
  desktopDialogButtonClassName,
  desktopDialogShowsToneIcon,
} from '../src/native-ui/desktop-dialog/App.tsx'

describe('Desktop dialog native UI', () => {
  it('omits the leading tone icon for the centered Profile compatibility surface', () => {
    expect(desktopDialogShowsToneIcon('profile-compatibility')).toBe(false)
    expect(desktopDialogShowsToneIcon('default')).toBe(true)
    expect(desktopDialogButtonClassName('profile-compatibility', 0)).toBe('mr-auto')
    expect(desktopDialogButtonClassName('profile-compatibility', 1)).toBeUndefined()
    expect(renderToStaticMarkup(createElement(DesktopDialogToneIcon, {
      type: 'warning',
    }))).toContain('<svg')
  })

  it('renders each compatibility advisory line as its own block', () => {
    expect(desktopDialogAdvisoryLines('Summary:\n1. First\n2. Second\nRecommendation')).toEqual([
      'Summary:',
      '1. First',
      '2. Second',
      'Recommendation',
    ])
  })

})
