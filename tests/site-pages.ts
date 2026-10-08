/**
 * Every page the site builds (vite.config.ts `build.rollupOptions.input`), as its file in the build, for the tests that read
 * what a visitor reads (tests/overclaims.test.ts, tests/messaging.test.ts). tests/page-lists.test.ts fails when an input
 * is missing here or from the page lists the live check and the pages suite load, so a new page is added to all of them.
 */
export const PAGES = [
  'index.html', 'p/index.html', 'view/index.html', 'sponsor/index.html', 'donate/index.html', 'link/index.html', 'link/desktop/index.html', 'link/try/index.html', 'privacy/index.html',
  'sim/index.html', 'sim/arm/index.html', 'sim/arena/index.html', 'sim/humanoid/index.html', 'sim/humanoid/physics/index.html', 'sim/device/index.html', 'catalogue/index.html', 'embed/index.html',
  'buttons/index.html', 'trust/index.html',
  'campaign/index.html', 'campaign/phone-control/index.html', 'campaign/phone-control/guide/index.html', 'campaign/phone-control/sample/index.html',
]
