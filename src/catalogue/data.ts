/**
 * The control catalogue in plain words (spec/CATALOGUE.md): what each utility does, the control systems and the
 * bridges, with where to try them. The /catalogue/ page and /catalogue.json are made from this and @obpal/core.
 */
export interface CatalogueRow { id: string; name: string; what: string; status: 'Shipped' | 'Public sim' | 'Planned'; link?: string }

export const UTILITY_ROWS: CatalogueRow[] = [
  { id: 'pad', name: 'Gamepad', what: 'Sticks, D-pad, face buttons, bumpers and analog triggers', status: 'Shipped' },
  { id: 'motion.aim', name: 'Aim', what: 'Turning the phone turns a view, by the gyro’s rate', status: 'Shipped' },
  { id: 'motion.steer', name: 'Steer', what: 'Tilting the phone holds a stick over', status: 'Shipped' },
  { id: 'motion.point', name: 'Point', what: 'Wii-style: the cursor is where the phone points', status: 'Shipped' },
  { id: 'motion.track', name: '3D', what: 'Where the phone is in space, from its own sensors, Wii-style', status: 'Shipped' },
  { id: 'motion.hold', name: '1:1', what: 'What you hold turns exactly as the phone does', status: 'Shipped' },
  { id: 'motion.tilt', name: 'Tilt', what: 'A racing-style tilt stick', status: 'Shipped' },
  { id: 'touch.trackpad', name: 'Trackpad', what: 'Drag, two-finger pan, pinch and twist', status: 'Shipped' },
]

export const SYSTEM_ROWS: CatalogueRow[] = [
  { id: 'system.scene3d', name: 'Shared 3D scenes', what: 'Each object and part in the Viewer, one person each', status: 'Shipped', link: '/view/' },
  { id: 'system.gamepad-slots', name: 'Gamepad slots', what: 'Players 1 to 4 in a browser game, one phone each', status: 'Public sim', link: '/sim/arena/' },
  { id: 'system.desktop', name: 'Your computer', what: 'Keys and the mouse for the program in front (ob.Pal Desktop)', status: 'Shipped', link: '/link/' },
  { id: 'system.robot-arm', name: 'Robot arms', what: 'Whole arms or single joints, simulated or real (Feetech, serial, ROS 2)', status: 'Public sim', link: '/sim/arm/' },
]

export const BRIDGE_ROWS: CatalogueRow[] = [
  { id: 'bridge.gamepad', name: 'Game controllers', what: 'Any Gamepad API controller, through a phone or a PC', status: 'Planned' },
  { id: 'bridge.joycon', name: 'Joy-Con', what: 'Joy-Con and Switch Pro, with motion, over WebHID', status: 'Planned' },
  { id: 'bridge.wiimote', name: 'Wii Remote', what: 'Wii Remote and Nunchuk, with IR pointing, over WebHID', status: 'Planned' },
  { id: 'bridge.xr', name: 'VR controllers', what: 'Headset controllers and hands (WebXR), one person per hand', status: 'Planned' },
]

export const REPO = 'https://github.com/Axialon/obpal'
/** Where a person proposes a profile: a GitHub issue with its JSON (an agent can open a pull request instead). */
export const proposeUrl = (name: string, json: string) =>
  `${REPO}/issues/new?labels=profile&title=${encodeURIComponent(`Profile: ${name}`)}&body=${encodeURIComponent(`A controller profile for the catalogue.\n\n\`\`\`json\n${json}\n\`\`\`\n`)}`
