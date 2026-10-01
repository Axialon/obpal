import { parseGuideStatus } from '../shared/desktop-guide'

// This isolated world can read only the service worker's sanitized status. It never opens a native port.
let timer: ReturnType<typeof setTimeout> | undefined
async function report() {
  clearTimeout(timer)
  if (document.hidden) return
  try {
    const status = parseGuideStatus(await chrome.runtime.sendMessage({ to: 'bg', type: 'desktop-guide-status' }))
    if (status) window.postMessage(status, location.origin)
  } catch { /* An updated or removed extension leaves the page's ordinary Link route available. */ }
  timer = setTimeout(report, 2000)
}
document.addEventListener('click', event => {
  if (event.isTrusted && (event.target as Element).closest('#desktop-check')) {
    try { void chrome.runtime.sendMessage({ to: 'bg', type: 'desktop-guide-open' }).catch(() => {}) } catch { /* Extension context retired. */ }
  }
})
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) void report() })
window.addEventListener('pagehide', () => clearTimeout(timer))
window.addEventListener('pageshow', () => void report())
void report()
