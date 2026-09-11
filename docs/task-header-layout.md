# Windows task header layout

The stable framed shell reserves a separate caption row inside each content
column, allowing the sidebar background to extend to the top of the window.
The transparent caption surface preserves these column colors. Its default
height is 32px. The task toolbar below it has a 44px
minimum height and 16px horizontal padding. Additional task tabs can increase
its height. Blank tasks keep their upstream hidden header behavior.

The shared toolbar styling lives in `src/client/task-header-styles.ts` in both
Desktop packages. Beta retains its separate native compatibility chrome.

For density customization, set CSS custom properties on `document.documentElement`
(for example from a desktop client customization):

```css
:root {
  --dsh-window-titlebar-height: 32px;
  --dsh-task-toolbar-height: 44px;
  --dsh-task-toolbar-padding: 16px;
}
```

The titlebar variable applies to the stable compatibility/extended renderer
frame and is clamped to 32–64px. Advanced mode keeps its native 32px caption
geometry. Toolbar height is at least 44px and horizontal padding at least 8px.
These are CSS configuration points, not persisted settings-panel controls.
macOS geometry is unchanged.
