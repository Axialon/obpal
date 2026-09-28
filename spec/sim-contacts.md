# Simulation support and contact

The simulation frame is authoritative. An optional GLB replaces rigid appearance slots, not joint frames or collision coordinates. Distances are world metres. The contact suite uses a 2 mm tolerance; SO-101 is displayed at 2.5 times its real size, making that a stricter 0.8 mm real tolerance. Rover assets are enlarged by `ROVER.radius / .25`; tyre dimensions and rolling travel include that scale.

## Root causes

| Family | Cause and correction |
| --- | --- |
| Dog | The authored links already match the joint spacing, including joint clearances. The old angle-only gait had no world-space stance or terrain constraint. World foot plants, three-axis leg IK, level soles and leg-derived body height now define the rig. Footholds land fully on or beside charging pads, avoiding their chamfers without moving stance feet. |
| Rover, planetary | Nominal tyre radii and centre-height terrain samples did not describe the actual tread or rendered terrain triangles. Actual tyre vertices seat each wheel; the rover's shocks follow the seated wheels and its rolling radius is checked against the GLB. |
| Tank, excavator, kart, forklift, vacuum, slot cars | Floor offsets, tyre centres, track soles and load frames disagreed with visible dimensions. Shared dimensions, seated road-edge supports and swept body clearances replace these assumptions. The excavator bounds its bucket solid; the forklift shares its mast and pallet bearing frame. |
| Drone, helicopter, plane | Logic landing heights referred to older bodies or floors. Gear soles now define the support height; the drone follows the actual octagonal pad and its sloping edge, rather than a circular approximation. Near-ground attitude cannot drive gear through the pad or runway. |
| Six arms | Bench height, base-skin chamfers and the old 5 mm tool clearance accumulated visible gaps. The bench top is the physics plane, each imported base skin receives its measured minimum-Y correction, and the tool clearance is 0.5 mm. Existing joint and stock collision frames remain authoritative. |
| Jib, slider, telescope, PTZ, pendulum, painter, gimbal, spotlights | Procedural feet and stage planes had independent offsets; these were not caused by the GLB swap. Pads, feet and supports now share the visible surface. |
| Maze, marble run, football, pinball, air hockey, sorting, trebuchet, claw, Arena | Several piece half-heights, tabletop offsets, piles and bearing planes disagreed. Pieces use their visible dimensions; stacks identify their actual supporting piece; claw fingers stop at prize envelopes and their descent covers the open finger sweep. |
| Studio | Instrument station offsets, raised mats and unsupported hand drums lifted the instruments. The stations and supports now share the room floor; animated cajons do not translate through it. |
| Boat, submarine | The hull origin was used as a waterline or seabed contact. Boats now maintain an 80 mm keel draft, buoys 40 mm; submarine clearance is measured from its actual hull sole to the seabed. |
| Lamp, smart home | Existing primary contacts were already aligned; the probe protects them and the lamp table now receives the contact shadow. |
| Shared assembly viewer | Intentional free-space manipulation has no support or collision contract. It is exercised by a phone and reported explicitly as not applicable. |

## Probe and test contract

`src/sim/contact.ts` binds rendered geometry without adding draws. Batching preserves measurement anchors. Instanced parts bind their allocated `instanceMatrix` capacity and are sampled only while their index is below the current `count` and their optional activity predicate is true. Replacing the allocation requires binding the new mesh, as with any new rendered object.

The probe transforms actual vertices, records the world-lowest point and raycasts downward against upward-facing faces of the named support. It chooses a face at or below the part's top, rather than an overhead shelf. If the entire part has sunk below all candidates, it reports the closest face above it. Separate support names are still appropriate for floors, tables, racks, water and prize stacks. This is a support probe, not a general solid-volume solver.

On slopes, or where a broad foot bridges grout beneath its averaged lowest point, the probe examines the lower hull. Both the lowest-point reading and the support reading are retained. This preserves the deck's recessed backing and polygon offset instead of flattening the grout to make a centre ray pass.

`touch` requires an absolute support error no greater than 2 mm. `clear` reports minimum clearance and rejects penetration. `free` identifies intentionally unconstrained motion, such as a puck falling off the Arena. Water reports both signed raw gap and deviation from declared draft. Wall and stock contacts use oriented collision envelopes; claw spheres have a sphere-to-finger narrow phase. These are explicit collision contracts, not an exhaustive triangle intersection scan of decorative meshes.

The browser suite gates model downloads to record procedural rest, phone motion, the asynchronous skin swap, model rest and motion, overview and ground-level views. All four Arena players join. The submarine is driven down to its seabed limit. All six arms additionally use the existing repeatable IK fixture to reach the floor and close on a block. The fixture waits for both driven fingers to measure within 2 mm and for the block to be held. Repeated arms have distinct contact names without changing their model frames. Supported parts must cast shadows onto receiving surfaces; scene submissions remain within 150 draws and 250,000 triangles.

Run `pnpm run e2e:all -- contact sims catalogue shared pages` on the assigned stand-in and worker ports. The suite writes only to a temporary directory and closes its servers and browsers. Copy its evidence to the ignored artifact directory afterward. `scripts/contact-report.mjs <before> <after> <output>` builds the local viewer and complete CSV.

## Reading the baseline

The original full baseline retains its raw readings. Its boat contacts were labelled `free`, so the first touch-only summary hid them. The report now compares their recorded signed water gaps with the same 80 mm draft as the corrected hull; the original JSON remains unchanged. Buoys added to coverage later are marked not measured in the baseline.

The original dog had no explicit stance state. Its baseline motion envelope includes all feet, while the corrected gait distinguishes stance and swing. Rest measurements independently expose the original hover. A later replay of the original commit supplies missing ground-level views; those pictures are kept separate from the original numerical run. Missing baseline parts or phases are labelled not measured, never zero.
