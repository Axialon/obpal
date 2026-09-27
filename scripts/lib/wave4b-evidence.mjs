/** Stage reproducible activity through the pure device inputs for the visual review, separate from phone e2e. */
export async function stageActivity(page, id) {
  await page.evaluate(id => {
    const logic = window.__device.logic
    const idle = () => ({ face: 'face.trackpad', mode: 1, pad: null, padPressed: 0, touching: false, drag: [0, 0], pan: [0, 0], pinch: 0, twist: 0, tilt: [0, 0], hold: null, point: null, spot: null, pose: null, held: new Set(), presses: [], wheel: 0, text: '', del: 0, values: [], recentred: false })
    const apply = (changes, frames = 1) => { for (let j = 0; j < frames; j++) logic.step(logic.units.map(() => ({ ...idle(), ...changes })), 0.05) }
    if (id === 'football') { apply({ drag: [12, -14], pan: [-9, 10] }); apply({ presses: ['serve'] }); apply({}, 12) }
    if (id === 'marblerun') {
      apply({ presses: ['place'] })
      // Ten pieces on each table exercise the maximum supported construction budget.
      for (const [x, z] of [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]) {
        const u = logic.units[0]; apply({ drag: [(x - u.cursorX) / 0.025, (z - u.cursorZ) / 0.025] }); apply({ presses: ['place'] })
      }
      apply({ presses: ['run'] }); apply({ pad: { axes: [1, 0, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 } }, 25)
    }
    if (id === 'planetary') { apply({ presses: ['sample'] }); apply({ pan: [-24, -28] }); apply({ touching: true, drag: [0, -25] }, 12) }
    if (id === 'telescope') { apply({ presses: ['find'] }); apply({ presses: ['in'] }, 4) }
    if (id === 'pendulum') { apply({ presses: ['push'] }); apply({}, 145) }
    if (id === 'trebuchet') { apply({ presses: ['launch'] }); apply({}, 28) }
    if (id === 'slider') { apply({ drag: [-200, 0], pan: [45, 0] }); apply({ presses: ['key'] }); apply({ drag: [400, 0], pan: [-90, 0] }); apply({ presses: ['key'] }); apply({ presses: ['play'] }); apply({}, 40) }
    if (id === 'jib') { apply({ drag: [-25, -40], pan: [25, 20] }); apply({ presses: ['record'] }) }
  }, id)
}
