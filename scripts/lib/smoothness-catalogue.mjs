/** Kept independent of browser dependencies so the source-inventory test can check coverage. */
export const SMOOTHNESS_SIMS = [
  ...['arm5', 'so101', 'six', 'scara', 'delta', 'desk'].map(kind => [`arm-${kind}`, `/sim/arm/?kind=${kind}`]),
  ['arena', '/sim/arena/'], ['humanoid', '/sim/humanoid/'], ['humanoid-soft', '/sim/humanoid/?preview=soft'],
  ...['octopus', 'jib', 'slider', 'trebuchet', 'pendulum', 'telescope', 'planetary', 'marblerun', 'football', 'rover', 'drone',
    'maze', 'ptz', 'lamp', 'claw', 'studio', 'boat', 'spotlights', 'vacuum', 'tank', 'excavator', 'forklift', 'painter',
    'gimbal', 'plane', 'slotcars', 'dog', 'sorting', 'kart', 'helicopter', 'submarine', 'smarthome', 'airhockey', 'pinball']
    .map(id => [id, `/sim/device/?d=${id}`]),
]
