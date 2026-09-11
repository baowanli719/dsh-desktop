/** Shared task toolbar sizing. Override these CSS variables on documentElement
 * to tune density without changing upstream components. Hidden blank-task
 * headers retain their upstream behavior; tabs may grow beyond the minimum. */
export const TASK_HEADER_STYLES = `
body[data-dsh-desktop-platform="win32"] [data-slot="conversation.session.header"] > header:not([aria-hidden="true"]) {
  box-sizing: border-box;
  min-height: max(44px, var(--dsh-task-toolbar-height, 44px));
  padding: 5px max(8px, var(--dsh-task-toolbar-padding, 16px));
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
body[data-dsh-desktop-platform="win32"] [data-slot="conversation.session.header"] > header:not([aria-hidden="true"]) > div:first-child {
  min-height: max(34px, calc(var(--dsh-task-toolbar-height, 44px) - 11px));
  align-items: center;
}
body[data-dsh-desktop-platform="win32"] [data-conversation-header-corner] {
  margin-right: 0;
}
`
