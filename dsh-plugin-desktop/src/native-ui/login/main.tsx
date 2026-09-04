import '../shared/theme.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { LoginApp } from './App.tsx'
import { installDesktopLoginRpcBridge } from './bridge.ts'

installDesktopLoginRpcBridge()
const root = document.getElementById('root')
if (root === null) throw new Error('dsh-login: root element is missing')
createRoot(root).render(<CSPProvider disableStyleElements><LoginApp /></CSPProvider>)
