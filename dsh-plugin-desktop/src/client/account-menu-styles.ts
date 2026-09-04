/** Scoped account-menu styling for the sidebar footer. */

const STYLE_ID = 'dsh-desktop-account-menu-styles'

const CSS = `
.dshDesktopAccountTrigger {
  box-sizing: border-box;
  width: calc(100% - 8px);
  min-width: 0;
  height: 58px;
  margin: 4px;
  padding: 7px 10px 7px 7px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 12px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshDesktopAccountTrigger:hover,
.dshDesktopAccountTrigger[data-popup-open] { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopAccountTrigger:focus-visible,
.dshDesktopAccountItem:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dshDesktopAccountTriggerRail {
  justify-content: center;
  width: 42px;
  height: 42px;
  margin: 4px 0;
  padding: 3px;
  border-radius: 50%;
}
.dshDesktopAccountAvatar {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 75%, var(--dsw-alias-label-primary) 8%);
  font-size: 15px;
  font-weight: 400;
}
.dshDesktopAccountIdentity { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.dshDesktopAccountIdentity strong,
.dshDesktopAccountIdentity span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopAccountIdentity strong { font-size: 14px; font-weight: 600; line-height: 20px; }
.dshDesktopAccountIdentity span { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dshDesktopAccountChevron { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); transition: transform 140ms ease; }
.dshDesktopAccountTrigger[data-popup-open] .dshDesktopAccountChevron { transform: rotate(180deg); }
.dshDesktopAccountPositioner { z-index: 2147483001; }
.dshDesktopAccountPopup {
  box-sizing: border-box;
  width: 218px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
  transform-origin: var(--transform-origin);
}
.dshDesktopAccountPopup[data-starting-style],
.dshDesktopAccountPopup[data-ending-style] { opacity: 0; transform: scale(.98); }
.dshDesktopAccountItem {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 8px 9px;
  border-radius: 8px;
  color: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
  user-select: none;
}
.dshDesktopAccountItem[data-highlighted] { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dshDesktopAccountItem[data-disabled] { cursor: default; opacity: .55; }
.dshDesktopAccountItemDanger { color: var(--dsw-alias-state-error-primary); }
.dshDesktopAccountVersion { margin-left: auto; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; }
.dshDesktopAccountError { margin: 4px 9px 2px; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
`

/** Install account-menu styles once; safe during headless client boot. */
export function installDesktopAccountMenuStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
