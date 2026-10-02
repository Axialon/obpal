/** Each picture follows a shipped Link route. Keyboard typing is offered only by the PC target. */
export const POSTERS = {
  tile: { phone: 'phone-wii', title: 'Point.\n*Play.*' },
  marquee: { phone: 'phone-rotate', title: 'Your phone.\n*More ways to play.*', sub: 'Trackpad · Point · Controller' },
}

export const SHOTS = [
  { scene: 'controller', face: 'face.gamepad', title: 'A *controller* for your browser.', sub: 'For games that read the standard Gamepad API.', items: [
    { src: 'phone-gamepad', kind: 'phone', x: 210, y: 250, width: 860 },
    { src: 'page-demo-feedback', kind: 'popup', x: 80, y: 698, width: 1120 },
  ] },
  { scene: 'viewer', face: 'face.trackpad', title: '*3D* at your fingertips.', sub: 'Drag to rotate · two fingers to pan · pinch to zoom in compatible viewers', items: [
    { src: 'page-viewer', kind: 'page', x: 64, y: 260, width: 720 },
    { src: 'phone-rotate', kind: 'phone', x: 670, y: 474, width: 530, label: 'Trackpad' },
  ] },
  { scene: 'keys', face: 'face.gamepad', title: 'Controller buttons. *Keyboard input.*', sub: 'Keys mode · WASD, arrows and action keys · some pages require trusted input', items: [
    { src: 'phone-keys', kind: 'phone', x: 180, y: 246, width: 920 },
  ] },
  { scene: 'pc', face: 'face.mouse', title: 'An air mouse. *Your PC.*', sub: 'With ob.Pal Desktop · Windows only · allowed programs or Whole PC', items: [
    { src: 'popup-pc-controls', kind: 'popup', x: 64, y: 274, width: 540, height: 299, label: 'PC target' },
    { src: 'phone-mouse', kind: 'phone', x: 654, y: 274, width: 546, label: 'Air mouse' },
    { src: 'phone-keyboard', kind: 'popup', x: 654, y: 608, width: 546, label: 'Keyboard dock · PC only' },
  ] },
  { scene: 'pairing', title: 'Pair. *Compare your seal.*', sub: 'Scan the QR. Compare both screens. Pairing alone leaves input off.', items: [
    { src: 'popup-pair-qr', kind: 'popup', x: 64, y: 296, width: 320, height: 320, label: 'Scan the QR' },
    { src: 'popup-seal', kind: 'popup', x: 550, y: 296, width: 450, cropCss: [164, 32, 256, 120], label: 'Link' },
    { src: 'phone-seal', kind: 'popup', x: 550, y: 558, width: 450, cropCss: [78, 0, 256, 112], label: 'Your phone' },
  ] },
]
