/**
 * The control catalogue in plain words (spec/CATALOGUE.md): what each utility does, the control systems and the
 * bridges, with where to try them. The /catalogue/ page and /catalogue.json are made from this and @obpal/core.
 */
export interface CatalogueRow { id: string; name: string; what: string; status: 'Shipped' | 'Public sim' | 'Planned'; link?: string }

export const UTILITY_ROWS: CatalogueRow[] = [
  { id: 'music.hit', name: 'Drum hit', what: 'A velocity pad or acceleration peak plays a percussion voice', status: 'Shipped' },
  { id: 'music.note', name: 'Tone note', what: 'Scale-locked notes with sustain, tilt bend and orientation expression', status: 'Shipped' },
  { id: 'pad', name: 'Gamepad', what: 'Sticks, D-pad, face buttons, bumpers and analog triggers', status: 'Shipped' },
  { id: 'motion.aim', name: 'Aim', what: 'Turning the phone turns a view, by the gyro’s rate', status: 'Shipped' },
  { id: 'motion.steer', name: 'Steer', what: 'Tilting the phone holds a stick over', status: 'Shipped' },
  { id: 'motion.point', name: 'Point', what: 'Wii-style: the cursor is where the phone points', status: 'Shipped' },
  { id: 'motion.track', name: '3D', what: 'Where the phone is in space: from a camera, or estimated from its own motion', status: 'Shipped' },
  { id: 'camera.hand', name: 'Hand camera', what: '21 hand landmarks, pinch, grip and point, processed on the phone', status: 'Shipped' },
  { id: 'motion.hold', name: '1:1', what: 'What you hold turns exactly as the phone does', status: 'Shipped' },
  { id: 'motion.tilt', name: 'Tilt', what: 'A racing-style tilt stick', status: 'Shipped' },
  { id: 'touch.trackpad', name: 'Trackpad', what: 'Drag, two-finger pan, pinch and twist', status: 'Shipped' },
]

export const SYSTEM_ROWS: CatalogueRow[] = [
  { id: 'system.scene3d', name: 'Shared 3D scenes', what: 'Each object and part in the Viewer, one person each', status: 'Shipped', link: '/view/' },
  { id: 'system.gamepad-slots', name: 'Gamepad slots', what: 'Players 1 to 4 in a browser game, one phone each', status: 'Public sim', link: '/sim/arena/' },
  { id: 'system.desktop', name: 'Your computer', what: 'Keys and the mouse for the program in front (ob.Pal Desktop, Windows; macOS coming soon)', status: 'Shipped', link: '/link/' },
  { id: 'system.robot-arm', name: 'Robot arms', what: 'Whole arms or single joints in the sim; real arms (Feetech, serial, ROS 2) are experimental, untested on hardware', status: 'Public sim', link: '/sim/arm/' },
]

export const BRIDGE_ROWS: CatalogueRow[] = [
  { id: 'bridge.gamepad', name: 'Game controllers', what: 'Any Gamepad API controller, through a phone or a PC', status: 'Planned' },
  { id: 'bridge.joycon', name: 'Joy-Con', what: 'Joy-Con and Switch Pro, with motion, over WebHID', status: 'Planned' },
  { id: 'bridge.wiimote', name: 'Wii Remote', what: 'Wii Remote and Nunchuk, with IR pointing, over WebHID', status: 'Planned' },
  { id: 'bridge.xr', name: 'VR controllers', what: 'Headset controllers and hands (WebXR), one person per hand', status: 'Planned' },
]

export const REPO = 'https://github.com/Axialon/obpal'

/** Where the embed is served, and the smallest page that uses it. */
export const EMBED_SCRIPT = 'https://obpal.blackboxes.net/embed.js'
export const EMBED_SNIPPET = `<script type="module" src="${EMBED_SCRIPT}"></script>
<obpal-remote app="My scene" seats="4" modes="face.trackpad face.wii"></obpal-remote>`

/**
 * The embed (PLAN §10 step 3; packages/host/src/element.ts) in plain words, for /catalogue.json and people: one script
 * and one tag put ob.Pal on any page.
 */
export const EMBED = {
  script: EMBED_SCRIPT,
  element: 'obpal-remote',
  demo: 'https://obpal.blackboxes.net/embed/',
  snippet: EMBED_SNIPPET,
  npm: 'npm install @obpal/host (defineObpalRemote from @obpal/host/element)',
  attributes: {
    app: 'The name the phone shows ("Controlling …"); the page title by default',
    modes: 'What the phone offers, in order: mode names (point, hold, tilt, pad, gamepad, track) and catalogue controller ids (face.wii, face.gamepad, …; see controllers). The first opens on the phone',
    seats: 'How many phones at once: 1 (a new one takes over, the default) to 8 (a shared scene: each takes over a node of its own)',
    profile: 'A catalogue profile to suggest (flight, driving, …)',
    corner: 'Where the pairing chip sits: bottom-right (default), bottom-left, top-right, top-left, or inline where the element is',
    accent: 'A CSS colour for the chip',
    open: 'Start with the code showing (reflects the chip; opening starts the remote)',
    label: 'The chip’s words (default "Scan to control")',
    scheme: 'The chip’s colours: auto (default), light or dark',
    code: 'false hides the short code beside the QR code',
    'test-link': 'Adds "Open on this device" for trying it without a phone',
    service: 'The room service (default: where embed.js came from)',
  },
  events: {
    'obpal-status': '{ status }: idle, starting, ready, connecting, connected, offline, unsupported (no WebRTC, or not https) or error',
    'obpal-connect': '{ name, caps }: a phone connected to an empty scene (with one seat, every phone that takes over)',
    'obpal-disconnect': 'The last phone left',
    'obpal-join': '{ participant }: someone joined ({ id, name, color, lead, caps, controller, profile })',
    'obpal-leave': '{ participant }: someone left; what they held is free',
    'obpal-button': '{ id, ev, participant }: tray buttons, trackpad taps (pad), the Wii face (wii-a, wii-b, wii-plus, wii-minus), the key row (key-Enter, …)',
    'obpal-mode': '{ mode, controller, profile, participant }: a phone switched controller',
    'obpal-claim': '{ node, participant }: a phone asks for a node (null lets go); cancel it to decide yourself',
    'obpal-text': '{ s, del, participant }: typing from the phone’s keyboard',
    'obpal-value': '{ id, v, participant }: a tray toggle or picker',
    'obpal-toss': '{ v, participant }: a flick upward (layout.toss)',
    'obpal-recenter': '{ participant }',
    'obpal-pad': '{ connected, participant }: a phone entered or left the gamepad',
  },
  api: {
    'frame(now, who?)': 'This frame’s input (qRel, tilt, pad1, pad2, zoom, twist, aim, pose, clutch, touching): the lead’s, or one participant’s. Once per rendered frame each',
    participants: 'Everyone controlling the scene, the lead first',
    'setScene({ nodes, held? })': 'What phones may take over ({ id, name, kind, group?, parent? }); held (node → participant) sets who holds what',
    'holder(node) / holding(who) / held': 'Who holds a node, what someone holds, the whole table',
    layout: 'Layout fields beside the attributes: tray buttons, keys, toss, point, wheel, utilities',
    ready: 'Resolves with the Remote (awaiting it starts it now), or null where this browser can’t host a phone',
    remote: 'The Remote (the host SDK), once started',
    'window.obpal.remote(opts)': 'A Remote without the element: Remote.create through this script',
  },
  csp: 'script-src https://obpal.blackboxes.net; connect-src https://obpal.blackboxes.net wss://obpal.blackboxes.net. No inline scripts or styles are needed',
}
/** Where a person proposes a profile: a GitHub issue with its JSON (an agent can open a pull request instead). */
export const proposeUrl = (name: string, json: string) =>
  `${REPO}/issues/new?labels=pack&title=${encodeURIComponent(`Pack: ${name}`)}&body=${encodeURIComponent(`An attributed data pack for the catalogue.\n\n\`\`\`json\n${json}\n\`\`\`\n`)}`
