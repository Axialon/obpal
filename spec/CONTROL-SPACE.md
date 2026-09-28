# Control space

Each phone sets its position when it takes control. **Set position** captures a
new neutral in one tap, including in the Buttons layer (`app:recentre`). It never
resets the simulation. Angles below are half ranges: left/right, then up/down.
The ends clamp; there is no acceleration or camera-dependent gain in an absolute
workspace. Tilt uses a 3° dead zone, rescaled continuously to full reach.
The separate **Home** action still resets the device and also captures a fresh
neutral, so the previous aim cannot undo the reset. While motion is active,
pointing resumes at the playable area's centre (the painter's canvas or the
spotlights' stage), rather than a parked pose outside that area.

Object scope operates the held unit. Scene scope spreads the available units
across the same reach; aim at one and use the normal take/action control. A unit
held by another player stays theirs. Scope is a single switch on the phone and
on the sim panel. Games keep their own side even in scene scope. Arms retain
their approval, deadman, joint limits and stop controls.

| Sim | Scopes | Reach (degrees) | Reach maps onto | Actions | Feedback |
| --- | --- | --- | --- | --- | --- |
| Five-axis arm (`arm-arm5`) | Tool / scene; joint claim | 35 / 25 | Tool workspace; selected joint travel; scene arm selection | Hold to move; grip | Surface ring, joint and gripper state |
| SO-101 (`arm-so101`) | Tool / scene; joint claim | 35 / 25 | Compact tool workspace; selected joint travel | Hold to move; grip | Surface ring, joint and gripper state |
| Six-axis arm (`arm-six`) | Tool / scene; joint claim | 35 / 25 | Industrial tool workspace; selected joint travel | Hold to move; grip | Surface ring, joint and gripper state |
| SCARA (`arm-scara`) | Tool / scene; joint claim | 35 / 25 | Planar reach; quill height separately | Hold to move; grip | Surface ring, quill and gripper state |
| Delta (`arm-delta`) | Tool / scene; joint claim | 30 / 25 | Dome workspace below the motors | Hold to move; grip | Surface ring, platform state |
| Desk arm (`arm-desk`) | Tool / scene; joint claim | 30 / 25 | Small desk workspace, level tool | Hold to move; grip | Surface ring, gripper state |
| Rover | Vehicle / scene | 30 / 25 | Steering and throttle; point-to-drive yard | Hold drive; brake | Vehicle movement, contact haptics |
| Drone | Vehicle / scene | 30 / 25 | Lateral flight and forward pitch | Lift; land | Flight attitude, altitude |
| Tilt maze | Board / scene | 20 / 20 | Board slopes, 3° neutral | Restart | Board slope, fall and goal haptics |
| PTZ camera | Camera / scene | 35 / 25 | Pan ±150°, tilt −50°…30°; neutral frames the set | Zoom; photo | Live camera view |
| Lamp | Lamp / scene | 30 / 25 | Hue and brightness while held | Hold paint; power; wheel dims; colour preset | Lamp's own light |
| Claw | Cabinet / scene | 35 / 25 | Entire own pit, inset from walls | Drop | Surface ring; catch / miss |
| Music studio | Instrument / studio | 35 / 25 | Kit arc, bars or keys; studio distributes every playable surface | Hold and flick down; pads; keys; sustain | Aimed surface Lime; strike tick; sound |
| Boat | Boat / scene | 30 / 25 | Rudder and throttle | Horn; brake | Wake, contact haptics |
| Spotlights | Light / scene | 35 / 25 | Whole stage floor | Colour; blackout | Actual illuminated footprint |
| Vacuum | Cleaner / scene | 30 / 25 | Steering and speed; room floor for point drive | Clean; dock | Floor ring, cleaned trail |
| Tank | Vehicle / scene | 35 / 25 | Turret azimuth ±π and elevation −0.08…0.6 rad; touch / left stick drives tracks | Fire | Turret pose; hit haptics |
| Excavator | Machine / scene | 30 / 25 | Held hand aims swing ±π and bucket height 0.15…2.95 m; forward hand travel changes radius 0.7…3 m | Hold to move; scoop; dump | Bucket and payload |
| Forklift | Vehicle / scene | 30 / 25 | Steering and throttle; lift separately | Lift; lower | Fork height, load and contact |
| Light painter | Canvas / scene | 35 / 25 | Canvas width and height at fixed depth | Hold draw; ink; clear | Small surface reticle and painted stroke |
| Gimbal | Camera / scene | 35 / 25 | Calibrated pan and tilt | Record; lock | Camera pose and live image |
| Plane | Aircraft / scene | 30 / 25 | Roll and pitch, neutral flight | Throttle; reset | Attitude and altitude |
| Slot cars | Lane / scene | 25 / 20 | Speed in own lane | Accelerate; brake | Car speed; derail haptic |
| Robot dog | Robot / scene | 30 / 25 | Steering and forward speed | Sit; fetch | Gait, ball and pose |
| Sorting line | Line / scene | 30 / 25 | Diverter travel ±0.9 m across the line | Sort; reverse | Gate pose and sorted counts |
| Kart | Vehicle / scene | 30 / 25 | Steering and throttle | Brake; boost | Wheel pose, contact haptics |
| Helicopter | Aircraft / scene | 30 / 25 | Cyclic roll and pitch | Collective; land | Rotorcraft pose and altitude |
| Submarine | Vehicle / scene | 30 / 25 | Rudder and thrust; two-finger ballast controls rise / dive | Sonar; ballast | Attitude and depth |
| Smart home | Appliance / room | 30 / 25 | Up/down spans blind opening, fan speed, TV channels or 16…30°C on the held appliance | Power; raise / lower; room scenes | Actual room fixtures |
| Air hockey | Own half / table | 30 / 25 | Own half, inset by mallet radius | Serve; move mallet | Mallet on table; goal and contact |
| Pinball | Own table / scene | 18 / 18 | Nudge, 3° neutral | Flippers; launch | Ball and table response; tilt warning |
| Table football | Own rods / table | 25 / 20 | Own rod slide ±0.3 m and kick rotation | Serve; kick | Rods and ball; goal feedback |
| Marble run | Board / scene | 20 / 20 | Board slope, 3° neutral; build cell selection | Place; rotate; run | Build-cell ring; rolling marble |
| Planetary rover | Rover / scene | 30 / 25 | Steering and speed | Scan; drill | Rover and scan result |
| Telescope | Telescope / scene | 35 / 25 | Sky azimuth and elevation | Zoom; capture | Live eyepiece and target lock |
| Pendulum | Pendulum / scene | 25 / 20 | Calibrated push strength | Release; length | Bob and graph |
| Trebuchet | Launcher / scene | 30 / 25 | Counterweight 5…50 kg across; release angle 20…75° up/down | Wind; release | Mechanism and projectile |
| Camera slider | Camera / scene | 35 / 25 | Rail travel ±1.7 m; head tilt | Save keyframe; play | Carriage and live camera |
| Jib crane | Camera / scene | 35 / 25 | Head pan ±1.5 rad and tilt −1.1…0.7 rad | Swing / boom with touch; record | Camera head and live image |
| Faction arena | Own puck / arena | 25 / 25 | Rolling force, 3° neutral | Dash | Puck movement; contact and fall |
| Shared 3D scene | Held part / scene | 35 / 25 | Part-local manipulation or scene selection / orbit | Take; hold; release | Surface cursor and selected part |

## Studio distribution and timing

Object targets stay inside 82% of the reach. The kit places the snare low left,
kick low centre, floor tom right, high and mid toms above, hats left and cymbals
at the upper corners. Mallets and keys run from low to high left to right.
Scene scope uses eight comfortably separated station cells, each with its own
surface layout, within 90% of the reach. There are 75 surfaces, at least 4.2°
apart in angular distance. In object scope the 16 bars are 3.83° apart; kit
surfaces have more room. Scene keys use four rows of four, read left to right
then top to bottom. Nearest-target selection has a stable tie break. The phone
map and screen share these coordinates. An occupied instrument rejects a scene
strike with a short explanation; the player keeps their claim and voice budget.

Gravity-free **downward** acceleration arms a strike at 7 m/s². The peak within
35 ms sets velocity; a quiet sample and 100 ms refractory period reject rebound.
The aim and capture time at the peak travel with the event. The screen resolves
that snapshot immediately, independently of its render frame and later aim.
Clock uncertainty and detection delay are distinct from event-to-schedule time.
All existing per-controller gates in MUSIC.md continue to apply. A separate
80-strike run reports capture-to-schedule, browser dispatch, peak-detection delay
and emission-to-schedule, with 16 warmup strikes and no discarded samples.

## Mapping choices

- Object pointing is absolute and independent of screen camera position. Arms
  use their own yaw, reach and height limits before IK and collision checks.
  Point maps onto the floor workspace; the held hand maps yaw and height, with
  30 cm of forward travel spanning reach. Trackpad handoff retains its deadman.
- Scene selection uses centred rows with a 28% horizontal and 38% vertical
  margin. Partial rows stay centred. Take switches back to object scope and
  sets position. Hockey, football, pinball, slot cars and the arena preserve the
  player's own side or lane in both scopes.
- Vehicle steering uses roll; aiming uses heading. Pitch is thrust for surface
  vehicles and the submarine, attitude for flyers. Auxiliary lift, collective,
  ballast, brake and trigger controls keep their existing roles.
- Home / Reset still resets the sim. Set position changes only the input neutral;
  it neither clears scores and recordings nor restarts a running game.
- Physical gamepads and phones without motion retain touch / stick control.
  Gamepad Steer uses the same fitted tilt range; gyro Aim controls the tank's
  turret independently of its driving stick.

Aim feedback belongs to the surface: Lime on the drum head, cymbal, bar or key;
a small ring on a pointing surface. Generic floating rays, stalks and endpoint
orbs are removed. Physical cables, lamp beams, pendulum rods and actual balls
remain because they describe the simulation.

## Compatibility

Optional `control.sim`, `control.scope` and `control.position` state values and
bounded `control.aim` JSON use existing value/state envelopes. Old clients keep
their existing inputs. New music events optionally carry normalized `aim` and
`scope`; old events still resolve on the claimed instrument. No binary mode or
packet layout changes. The host validates scope and occupied targets.
