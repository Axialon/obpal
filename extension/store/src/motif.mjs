/** Finished glass devices joined by one evenly spaced still dot wave. Actual controller pixels, canonical vector mark. */
const mark = await (await fetch('/public/logo-mark.svg')).text()

export function deviceMotif(phone) {
  const points = []
  // Sample by arc length, rather than x, so dots remain evenly spaced through the bends.
  let last = null, distance = 0
  for (let x = 403; x <= 560; x += .25) {
    const y = 280 + Math.sin((x - 403) / 157 * Math.PI * 2) * 22
    if (last) distance += Math.hypot(x - last[0], y - last[1])
    if (!last || distance >= 13) { points.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="4.5" fill="#c6ff34"/>`); distance = 0 }
    last = [x, y]
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 480" aria-label="Phone controller linked to a browser">
    <defs>
      <linearGradient id="shell" x2=".7" y2="1"><stop stop-color="#5b5d58"/><stop offset=".28" stop-color="#26292a"/><stop offset="1" stop-color="#111314"/></linearGradient>
      <linearGradient id="viewport" x2=".35" y2="1"><stop stop-color="#303332"/><stop offset="1" stop-color="#0d0e0f"/></linearGradient>
      <linearGradient id="rim" x2=".3" y2="1"><stop stop-color="#b4b8ad"/><stop offset=".45" stop-color="#51564a"/><stop offset="1" stop-color="#262b22"/></linearGradient>
      <clipPath id="phone-screen"><rect x="35" y="235" width="355" height="173" rx="19"/></clipPath>
    </defs>
    <ellipse cx="216" cy="431" rx="184" ry="15" fill="#000" opacity=".6"/>
    <ellipse cx="757" cy="397" rx="205" ry="17" fill="#000" opacity=".6"/>
    <rect x="557" y="76" width="413" height="306" rx="24" fill="#070808"/>
    <rect x="549" y="66" width="413" height="306" rx="24" fill="url(#shell)" stroke="url(#rim)" stroke-width="3"/>
    <path d="M573 68H938" stroke="#dde3cf" stroke-opacity=".45" stroke-width="2"/>
    <rect x="564" y="125" width="383" height="230" rx="13" fill="url(#viewport)" stroke="#51564a" stroke-width="1.5"/>
    <circle cx="578" cy="96" r="5" fill="#c6ff34"/><circle cx="596" cy="96" r="5" fill="#8b9381"/><circle cx="614" cy="96" r="5" fill="#68705e"/>
    <rect x="648" y="85" width="268" height="22" rx="11" fill="#0b0d0c" stroke="#646b5d"/>
    <g transform="translate(635 128) scale(2.35)">${mark.replace(/<svg[^>]*>|<\/svg>/g, '')}</g>
    ${points.join('')}
    <rect x="20" y="215" width="392" height="207" rx="33" fill="#050606"/>
    <rect x="14" y="207" width="392" height="207" rx="33" fill="url(#shell)" stroke="url(#rim)" stroke-width="3"/>
    <path d="M46 209H374" stroke="#e8efda" stroke-opacity=".4" stroke-width="2"/>
    <rect x="29" y="229" width="367" height="185" rx="23" fill="#080909"/>
    <image href="${phone}" x="35" y="235" width="355" height="173" preserveAspectRatio="xMidYMid meet" clip-path="url(#phone-screen)"/>
    <rect x="20" y="272" width="5" height="60" rx="2.5" fill="#030403"/><circle cx="399" cy="316" r="3" fill="#6e7860"/>
  </svg>`
}
