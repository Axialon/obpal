/** F1a2 mathematical contracts. These do not simulate contact or prove a standing humanoid. */
import { assert } from './sim-node.mjs'
import { validateScene, STEP, type SceneInput, type Scene, type BodyState, type ContactSample } from '../src/sim/physics/schema'
import { IDENTITY, ZERO, fromRotationVector, rotate, norm, type Vec3 } from '../src/sim/physics/math'
const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`)
export type Register = (name: string, run: () => unknown | Promise<unknown>) => unknown
export function rodInput(): SceneInput {
  return { gravity: { x: 0, y: -9.81, z: 0 }, bodies: [
    { id: 'base', fixed: true, shape: { kind: 'sphere', radius: .1 }, position: { ...ZERO } },
    { id: 'rod', mass: 3, shape: { kind: 'box', half: { x: .1, y: 1, z: .2 } }, position: { x: 0, y: -1, z: 0 } },
  ], joints: [{ id: 'hinge', parent: 'base', child: 'rod', anchorParent: { ...ZERO }, anchorChild: { x: 0, y: 1, z: 0 },
    cone: { swingY: 1, swingZ: 1, twistMin: -1, twistMax: 1 },
    motor: { integration: 'constraint-damped', target: { ...IDENTITY }, stiffness: 800, damping: 30, maxTorque: 90 } }] }
}
export function bodyStates(s: Scene): BodyState[] { return s.bodies.map(b => ({ id: b.id, position: { ...b.position }, rotation: { ...b.rotation },
  velocity: { ...b.velocity }, angularVelocity: { ...b.angularVelocity }, sleeping: false })) }
export function humanoidConstraintCases(test: Register) {
  test('constraint servo: opt-in validates; zero impedance and mixed solvers refuse before allocation', () => {
    const input = rodInput(), scene = validateScene(input)
    assert.equal(scene.joints[0].motor.integration, 'constraint-damped')
    input.joints![0].motor.damping = 0; input.joints![0].motor.stiffness = 0
    assert.throws(() => validateScene(input), /impedance/)
    const mixed = rodInput(); mixed.bodies.push({ id: 'tip', shape: { kind: 'sphere', radius: .1 }, position: { x: 0, y: -2, z: 0 } })
    mixed.joints!.push({ ...mixed.joints![0], id: 'tip_joint', parent: 'rod', child: 'tip', motor: { ...mixed.joints![0].motor, integration: 'inertia-damped' } })
    assert.throws(() => validateScene(mixed), /Mixed/)
  })
  test('constraint response: anchored uniform rod obeys the independently calculated parallel-axis theorem', async () => {
    const { constraintResponse } = await import('../src/sim/physics/constraint-response')
    const scene = validateScene(rodInput()), before = bodyStates(scene), copy = structuredClone(before)
    const h = constraintResponse(scene, before, [])
    // I_COM,x = m/3 (hy^2+hz^2) = 1.04 kg m²; offset 1 m contributes 3 kg m².
    near(h.matrix[0][0], 1 / 4.04); near(h.matrix[1][1], 1 / .05); near(h.matrix[2][2], 1 / 4.01)
    near(h.matrix[0][1], 0); assert.equal(h.constraintRank, 3); assert.deepEqual(before, copy)
    assert.ok(Math.abs(h.matrix[0][0] - 1 / 1.04) > .5, 'free COM inertia is the old, wrong anchored response')
  })
  test('constraint response: two-link straight chain has the independent coupled planar mass matrix', async () => {
    const { constraintResponse } = await import('../src/sim/physics/constraint-response')
    const input = rodInput(); input.bodies.push({ ...input.bodies[1], id: 'tip', position: { x: 0, y: -3, z: 0 } })
    input.joints!.push({ ...input.joints![0], id: 'elbow', parent: 'rod', child: 'tip', anchorParent: { x: 0, y: -1, z: 0 } })
    const scene = validateScene(input), h = constraintResponse(scene, bodyStates(scene), [])
    // In absolute angles, T=1/2 qdot^T [[16.04,6],[6,4.04]] qdot.
    // Joint coordinates are q=(theta1,theta2-theta1), hence M=[[32.08,10.04],[10.04,4.04]].
    const det = 32.08 * 4.04 - 10.04 ** 2
    near(h.matrix[0][0], 4.04 / det); near(h.matrix[0][3], -10.04 / det)
    near(h.matrix[3][0], -10.04 / det); near(h.matrix[3][3], 32.08 / det)
    assert.equal(h.constraintRank, 6)
  })
  test('constraint response: rotated anisotropic response is covariant, not a diagonal world tensor', async () => {
    const { constraintResponse } = await import('../src/sim/physics/constraint-response')
    const scene = validateScene(rodInput()), states = bodyStates(scene), q = fromRotationVector({ x: .4, y: .7, z: -.3 })
    const h = constraintResponse(scene, states, []), rotated = states.map(s => ({ ...s, position: rotate(q, s.position), rotation: q }))
    const r = constraintResponse(scene, rotated, []), v = { x: .3, y: .8, z: -.2 }
    const apply = (m: number[][], p: Vec3) => ({ x: m[0][0]*p.x+m[0][1]*p.y+m[0][2]*p.z,
      y: m[1][0]*p.x+m[1][1]*p.y+m[1][2]*p.z, z: m[2][0]*p.x+m[2][1]*p.y+m[2][2]*p.z })
    const a = rotate(q, apply(h.matrix, v)), b = apply(r.matrix, rotate(q, v))
    near(norm({ x:a.x-b.x,y:a.y-b.y,z:a.z-b.z }), 0)
  })
  test('constraint response: zero-pressure footprint points matter only on a genuinely loaded manifold', async () => {
    const { constraintResponse } = await import('../src/sim/physics/constraint-response')
    const scene = validateScene(rodInput()), states = bodyStates(scene)
    const samples: ContactSample[] = [
      { a:'base', b:'rod',pointA:{x:-.1,y:-2,z:-.2},pointB:{x:-.1,y:-2,z:-.2},normalOnB:{x:0,y:1,z:0},distance:0,impulse:1 },
      { a:'base', b:'rod',pointA:{x:.1,y:-2,z:.2},pointB:{x:.1,y:-2,z:.2},normalOnB:{x:0,y:1,z:0},distance:0,impulse:0 },
    ]
    const unloaded = constraintResponse(scene, states, samples.map(c=>({...c,impulse:0})))
    near(unloaded.matrix[0][0], 1/4.04); assert.equal(unloaded.contactRows, 0)
    const h = constraintResponse(scene, states, samples), duplicate = constraintResponse(scene, states, [...samples,...samples])
    near(h.matrix[0][0], 0); assert.ok(h.contactRows > 0)
    for(let i=0;i<3;i++) for(let j=0;j<3;j++) near(h.matrix[i][j],duplicate.matrix[i][j])
    const falling = states.map(s=>({...s,velocity:{x:0,y:1,z:0}}))
    const separated = constraintResponse(scene,falling,samples)
    near(separated.matrix[0][0], 1/4.04); assert.equal(separated.contactRows, 0)
  })
  test('constraint servo: one-axis backward Euler torque satisfies anchored inertia, stiffness and damping', async () => {
    const { coupledServo } = await import('../src/sim/physics/coupled-servo')
    const scene = validateScene(rodInput()), states = bodyStates(scene)
    const target = fromRotationVector({x:.1,y:0,z:0}), h = 1/4.04
    const result = coupledServo(scene, states, new Map([['hinge',target]]), [], STEP)
    const expected = 80/(1+(30*STEP+800*STEP**2)*h)
    near(result.torques.get('hinge')!.x, expected); near(result.torques.get('hinge')!.y,0)
    assert.ok(result.diagnostics.relativeResidual < 1e-9); assert.equal(result.diagnostics.saturatedJoints, 0)
  })
  test('constraint servo: coupled motor and directional stop share the final effort bound', async () => {
    const { coupledServo } = await import('../src/sim/physics/coupled-servo')
    const scene = validateScene(rodInput()), states = bodyStates(scene)
    states[1].rotation=fromRotationVector({x:1.2,y:.5,z:.2}); states[1].angularVelocity={x:40,y:20,z:3}
    const saved = structuredClone(states), result = coupledServo(scene,states,new Map(),[],STEP)
    assert.ok(norm(result.torques.get('hinge')!) <= 90+1e-9); assert.equal(result.diagnostics.saturatedJoints,1)
    assert.ok(result.diagnostics.relativeResidual < 1e-9); assert.deepEqual(states,saved)
  })
  test('coupled servo: saturation exposes an applied residual instead of presenting the free solution as applied', async () => {
    const { coupledServo } = await import('../src/sim/physics/coupled-servo')
    const scene=validateScene(rodInput()),states=bodyStates(scene)
    scene.joints[0].motor.maxTorque=1
    const result=coupledServo(scene,states,new Map([['hinge',fromRotationVector({x:.3,y:0,z:0})]]),[],STEP)
    assert.ok(result.diagnostics.relativeResidual<1e-9)
    assert.ok(result.diagnostics.appliedRelativeResidual>.5)
    near(norm(result.torques.get('hinge')!),1)
  })
  test('constraint response: non-finite native state, missing body and oversized contact lists refuse', async () => {
    const { constraintResponse } = await import('../src/sim/physics/constraint-response')
    const scene=validateScene(rodInput()), states=bodyStates(scene)
    assert.throws(()=>constraintResponse(scene,states.slice(1),[]),/state/)
    states[1].position.x=NaN
    assert.throws(()=>constraintResponse(scene,states,[]),/state/)
    const c={a:'base',b:'rod',pointA:{...ZERO},pointB:{...ZERO},normalOnB:{x:0,y:1,z:0},distance:0,impulse:0}
    assert.throws(()=>constraintResponse(scene,bodyStates(scene),Array(257).fill(c)),/contact/)
  })
}
export function humanoidCoupledRuntimeCases(test: Register) {
  test('coupled runtime: exactly one shared solve; equal/opposite effort, no translational servo force', async () => {
    const { actuatorForces } = await import('../src/sim/physics/forces')
    const { coupledServo } = await import('../src/sim/physics/coupled-servo')
    const { DEFAULT_LIMITS } = await import('../src/sim/physics/schema')
    const { orchestrationBackend } = await import('./humanoid-pilot-double')
    const scene=validateScene(rodInput()),backend=await orchestrationBackend(scene,DEFAULT_LIMITS),targets=new Map([['hinge',fromRotationVector({x:.1,y:0,z:0})]])
    const out=new Map(),result=actuatorForces(scene,backend,targets,DEFAULT_LIMITS,out,[])
    const exact=coupledServo(scene,bodyStates(scene),targets,[],STEP).torques.get('hinge')!
    near(out.get('rod').torque.x,exact.x);near(out.get('base').torque.x,-exact.x)
    assert.deepEqual(out.get('rod').force,ZERO);assert.deepEqual(out.get('base').force,ZERO)
    assert.ok(result.coupled); assert.equal(result.coupled!.constraintRank,3)
  })
  test('coupled runtime: missing contact capability faults before the first body step, never silently empty', async () => {
    const { Simulation } = await import('../src/sim/physics/runtime')
    const { orchestrationBackend } = await import('./humanoid-pilot-double')
    let steps=0
    const simulation=new Simulation(rodInput(),async(s,l)=>{ const b=await orchestrationBackend(s,l); delete b.contacts;b.step=()=>{steps++};return b })
    try { await simulation.init();assert.throws(()=>simulation.advance(STEP),/contact/);assert.equal(steps,0);assert.equal(simulation.status,'faulted') }
    finally { simulation.dispose() }
  })
  test('coupled runtime: diagnostics are owned and reset clears them', async () => {
    const { Simulation } = await import('../src/sim/physics/runtime')
    const { orchestrationBackend } = await import('./humanoid-pilot-double')
    const simulation=new Simulation(rodInput(),orchestrationBackend)
    try { await simulation.init();simulation.advance(STEP)
      const diagnostic=simulation.diagnostics();assert.ok(diagnostic.forces.coupled)
      diagnostic.forces.coupled!.constraintRank=-99;assert.equal(simulation.diagnostics().forces.coupled!.constraintRank,3)
      await simulation.reset();assert.equal(simulation.diagnostics().forces.coupled,undefined)
    } finally { simulation.dispose() }
  })
}
export async function supportFixture() {
  const { buildHumanoid }=await import('../src/sim/humanoid/physics/model')
  const { observe }=await import('../src/sim/humanoid/physics/observation')
  const model=buildHumanoid('keel-v1'),states=bodyStates(model.scene),contacts:ContactSample[]=[]
  for(const id of model.feet) { const b=states.find(s=>s.id===id)!
    for(const [x,z] of [[-.04,-.1],[.04,-.1],[.04,.1],[-.04,.1]]) {
      const p={x:b.position.x+x,y:0,z:b.position.z+z}
      contacts.push({a:'floor',b:id,pointA:{...p},pointB:{...p},normalOnB:{x:0,y:1,z:0},distance:0,impulse:1})
    }
  }
  return {model,states,contacts,observe}
}
export function humanoidSupportCases(test: Register) {
  test('support observations: per-foot load and COP are owned; COM velocity is mass weighted', async()=>{
    const {model,states,contacts,observe}=await supportFixture()
    for(const b of states) b.velocity={x:1,y:0,z:0}
    const o=observe(model,states,contacts,1,1)
    near(o.comVelocity.x,1);near(o.support.normalImpulseNs,8)
    for(const f of o.feet) { near(f.normalImpulseNs,4);near(f.centreOfPressure!.x,f.centre.x);near(f.tangentialSpeedMps!,1);assert.equal(f.contactPoints.length,4) }
    contacts[0].pointB.x=400;assert.ok(o.feet[0].contactPoints.every(p=>p.x!==400))
    const noLoad=observe(model,states,contacts.map(c=>({...c,impulse:0})),1,2)
    assert.equal(noLoad.feet[0].centreOfPressure,null);assert.equal(noLoad.feet[0].tangentialSpeedMps,null)
    assert.equal(noLoad.feet[0].contactPoints.length,0)
  })
  test('support observations: a rolling contact has no material-point sliding despite foot-origin translation', async()=>{
    const {model,states,observe}=await supportFixture(),foot=states.find(s=>s.id===model.feet[0])!
    foot.velocity={x:.2,y:0,z:0};foot.angularVelocity={x:0,y:0,z:-.2/foot.position.y}
    const p={x:foot.position.x,y:0,z:foot.position.z},contact={a:'floor',b:foot.id,pointA:p,pointB:p,normalOnB:{x:0,y:1,z:0},distance:0,impulse:1}
    const f=observe(model,states,[contact],1,1).feet[0]
    near(f.speedMps,.2);near(f.tangentialSpeedMps!,0)
  })
  test('slip: actual loaded tangential path and all-state displacement are separate; touchdown does not count an airborne path', async()=>{
    const {LoadedSlipMeter}=await import('../src/sim/humanoid/physics/slip')
    const {model,states,contacts,observe}=await supportFixture(),meter=new LoadedSlipMeter(model,1)
    for(const s of states) s.velocity={x:1,y:0,z:0}
    meter.sample(observe(model,states,contacts,1,1)) // touchdown: establish epoch, no fabricated preceding interval.
    meter.sample(observe(model,states,contacts,1,2));let report=meter.report()
    near(report.feet[model.feet[0]].totalPathMm,1000*STEP);assert.equal(report.feet[model.feet[0]].episodes,1)
    for(const id of model.feet) states.find(s=>s.id===id)!.position.x+=2
    meter.sample(observe(model,states,[],1,3));report=meter.report()
    near(report.fallDisplacementMm,2000);near(report.feet[model.feet[0]].totalPathMm,1000*STEP)
    meter.sample(observe(model,states,contacts,1,4));report=meter.report()
    near(report.feet[model.feet[0]].totalPathMm,1000*STEP);assert.equal(report.feet[model.feet[0]].episodes,2)
    meter.sample(observe(model,states,contacts,1,5));report=meter.report()
    near(report.feet[model.feet[0]].totalPathMm,2000*STEP);near(report.feet[model.feet[0]].maxEpisodePathMm,1000*STEP)
    report.feet[model.feet[0]].totalPathMm=-1;assert.ok(meter.report().feet[model.feet[0]].totalPathMm>=0)
  })
  test('slip: wrong actor/generation, gaps and non-finite samples reject atomically', async()=>{
    const {LoadedSlipMeter}=await import('../src/sim/humanoid/physics/slip')
    const {model,states,contacts,observe}=await supportFixture(),meter=new LoadedSlipMeter(model,1),one=observe(model,states,contacts,1,1)
    meter.sample(one);const before=meter.report()
    for(const bad of [{...one,actorId:'seat2',stateTick:2},{...one,generation:2,stateTick:2},{...one,stateTick:3,timeS:3*STEP}]) assert.throws(()=>meter.sample(bad))
    const two=observe(model,states,contacts,1,2);two.feet[1].tangentialSpeedMps=NaN
    assert.throws(()=>meter.sample(two));assert.deepEqual(meter.report(),before)
    meter.sample(observe(model,states,contacts,1,2))
  })
  test('stance targets: bounded classical input only, with no root/foot state write; gate preserves all identities', async()=>{
    const {StanceController,STANCE_CONTROL}=await import('../src/sim/humanoid/physics/stance')
    const {ActuationGate}=await import('../src/sim/humanoid/physics/contract')
    const {angleBetween}=await import('../src/sim/physics/math')
    const {model,states,contacts,observe}=await supportFixture(),controller=new StanceController(model,1),gate=new ActuationGate(model,1)
    const o=observe(model,states,contacts,1,0),copy=structuredClone(o)
    o.com.z+=.08;const altered=structuredClone(o),r=controller.step(o)
    assert.equal(r.diagnostics.phase,'supported');assert.equal(r.frame.source,'classical');assert.equal(r.frame.actorId,model.actorId)
    assert.equal(Object.keys(r.frame.targets).length,15);assert.equal(Object.hasOwn(r.frame.targets,model.root),false)
    assert.deepEqual(o,altered);assert.ok(r.diagnostics.maxAnkleBiasRad<=STANCE_CONTROL.maxAnkleBiasRad+1e-9)
    const accepted=gate.accept(r.frame)
    for(const j of model.scene.joints) assert.ok(angleBetween(j.motor.target,accepted.targets[j.id])<=4*STEP+1e-9)
    assert.throws(()=>controller.step({...copy,generation:2}));assert.throws(()=>controller.step({...copy,actorId:'seat2'}))
    assert.equal(controller.step(observe(model,states,[],1,1)).diagnostics.phase,'no-support')
  })
  test('stance targets: yaw-covariant world feedback cannot add a heading command', async()=>{
    const {StanceController}=await import('../src/sim/humanoid/physics/stance')
    const {angleBetween,multiply}=await import('../src/sim/physics/math')
    const {model,states,contacts,observe}=await supportFixture(),q=fromRotationVector({x:0,y:1.1,z:0}),controller=new StanceController(model,1)
    const a=observe(model,states,contacts,1,0);a.com.z+=.04;a.comVelocity.x=.1
    const b=structuredClone(a);b.com=rotate(q,a.com);b.comVelocity=rotate(q,a.comVelocity)
    b.bodies=b.bodies.map(s=>({...s,position:rotate(q,s.position),rotation:multiply(q,s.rotation),velocity:rotate(q,s.velocity),angularVelocity:rotate(q,s.angularVelocity)}))
    b.support.polygon=b.support.polygon.map(p=>rotate(q,p));b.support.points=b.support.points.map(p=>rotate(q,p))
    b.feet=b.feet.map(f=>({...f,centre:rotate(q,f.centre),centreOfPressure:f.centreOfPressure?rotate(q,f.centreOfPressure):null,contactPoints:f.contactPoints.map(p=>rotate(q,p))}))
    const x=controller.step(a).frame.targets,y=controller.step(b).frame.targets
    for(const id of Object.keys(x)) near(angleBetween(x[id],y[id]),0,5e-8)
  })
}
export function humanoidReviewFollowupCases(test: Register) {
  test('contact prediction: moving tangentially removes only sticking rows; frictionless contact never locks tangents', async()=>{
    const {constraintResponse}=await import('../src/sim/physics/constraint-response')
    const input=rodInput();input.bodies[1].position={x:0,y:-1,z:0};const scene=validateScene(input),states=bodyStates(scene)
    const p={x:0,y:-2,z:0},c={a:'base',b:'rod',pointA:p,pointB:p,normalOnB:{x:0,y:1,z:0},distance:0,impulse:1}
    const staticCase=constraintResponse(scene,states,[c]);states[1].velocity={x:1,y:0,z:0}
    const sliding=constraintResponse(scene,states,[c]);assert.ok(staticCase.contactRows>sliding.contactRows);assert.equal(sliding.contactRows,1)
    states[1].velocity={...ZERO};scene.bodies[1].friction=0
    assert.deepEqual(constraintResponse(scene,states,[c]).matrix,sliding.matrix)
    // A positive impulse beyond the configured narrow-phase envelope is not support.
    assert.equal(constraintResponse(scene,states,[{...c,distance:.02}]).contactRows,0)
  })
  test('contact prediction: swapping native A/B and negating its normal preserves the response', async()=>{
    const {constraintResponse}=await import('../src/sim/physics/constraint-response')
    const scene=validateScene(rodInput()),states=bodyStates(scene),p={x:.1,y:-2,z:.2}
    const c={a:'base',b:'rod',pointA:p,pointB:p,normalOnB:{x:0,y:1,z:0},distance:0,impulse:1}
    const a=constraintResponse(scene,states,[c]),b=constraintResponse(scene,states,[{...c,a:c.b,b:c.a,normalOnB:{x:0,y:-1,z:0}}])
    assert.deepEqual(a.matrix,b.matrix);assert.equal(a.contactRows,b.contactRows)
  })
  test('coupled zero target: an unforced one-axis implicit step decreases independently calculated spring-plus-kinetic energy', async()=>{
    const {coupledServo}=await import('../src/sim/physics/coupled-servo')
    const input=rodInput();input.gravity={...ZERO};const scene=validateScene(input),states=bodyStates(scene)
    const angle=.03,speed=.2;states[1].rotation=fromRotationVector({x:angle,y:0,z:0})
    states[1].position=rotate(states[1].rotation,{x:0,y:-1,z:0});states[1].angularVelocity={x:speed,y:0,z:0}
    states[1].velocity={x:0,y:-speed*states[1].position.z,z:speed*states[1].position.y}
    const t=coupledServo(scene,states,new Map(),[],STEP).torques.get('hinge')!.x
    const nextSpeed=speed+STEP*t/4.04,nextAngle=angle+STEP*nextSpeed
    const before=.5*4.04*speed**2+.5*800*angle**2,after=.5*4.04*nextSpeed**2+.5*800*nextAngle**2
    assert.ok(after<before,`${after} >= ${before}`)
  })
  test('candidate profiles retain a free 16-body, 59.5 kg model and the 1414 N m summed declared joint caps', async()=>{
    const {buildHumanoid,ALL_PHYSICAL_PROFILES}=await import('../src/sim/humanoid/physics/model')
    const totals: number[]=[]
    for(const profile of ALL_PHYSICAL_PROFILES) { const m=buildHumanoid(profile)
      assert.equal(m.scene.bodies.filter(b=>!b.fixed).length,16);assert.equal(m.scene.bodies.find(b=>b.id===m.root)!.fixed,false)
      near(m.scene.bodies.filter(b=>!b.fixed).reduce((mass,b)=>mass+b.mass,0),59.5)
      assert.equal(m.scene.joints.length,15);assert.ok(m.scene.joints.every(j=>j.motor.integration==='constraint-damped'))
      totals.push(m.scene.joints.reduce((effort,j)=>effort+j.motor.maxTorque,0))
    }
    assert.ok(totals.every(n=>n===totals[0]));near(totals[0],1414)
  })

}
export function humanoidIsolationCases(test: Register) {
  test('coupled math only: disjoint 16-body actors have no off-diagonal response or target cross-talk',async()=>{
    const {buildHumanoid}=await import('../src/sim/humanoid/physics/model')
    const {constraintResponse}=await import('../src/sim/physics/constraint-response')
    const {coupledServo}=await import('../src/sim/physics/coupled-servo')
    const a=buildHumanoid('keel-v1','seat1'),b=buildHumanoid('morrow-v1','seat2')
    const scene=validateScene({...a.scene,bodies:[...a.scene.bodies,...b.scene.bodies.filter(b=>!b.fixed).map(b=>({...b,position:{...b.position,x:b.position.x+2}}))],joints:[...a.scene.joints,...b.scene.joints]})
    const states=bodyStates(scene),h=constraintResponse(scene,states,[])
    for(let i=0;i<45;i++) for(let j=45;j<90;j++) near(h.matrix[i][j],0)
    const base=coupledServo(scene,states,new Map(),[],STEP)
    const changed=coupledServo(scene,states,new Map([[b.scene.joints[0].id,fromRotationVector({x:.2,y:.1,z:0})]]),[],STEP)
    for(const j of a.scene.joints) assert.deepEqual(base.torques.get(j.id),changed.torques.get(j.id))
    assert.ok(norm(changed.torques.get(b.scene.joints[0].id)!)>0)
    assert.equal(h.dimensions,192) // 32 dynamic spatial bodies; this is NOT a native two-actor collision test.
  })
  test('constraint response: kinetic quadratic is nonnegative and symmetric for a tilted full-body configuration',async()=>{
    const {constraintResponse}=await import('../src/sim/physics/constraint-response')
    const {buildHumanoid}=await import('../src/sim/humanoid/physics/model')
    const {multiply}=await import('../src/sim/physics/math')
    const model=buildHumanoid('morrow-v1'),q=fromRotationVector({x:.3,y:.2,z:-.4}),states=bodyStates(model.scene)
    for(const s of states) if(s.id!=='floor') {s.position=rotate(q,s.position);s.rotation=multiply(q,s.rotation)}
    const h=constraintResponse(model.scene,states,[]).matrix
    for(let trial=0;trial<8;trial++) {const v=h.map((_,i)=>Math.sin((i+1)*(trial+1)))
      let quadratic=0;for(let i=0;i<h.length;i++) for(let j=0;j<h.length;j++) {near(h[i][j],h[j][i]);quadratic+=v[i]*h[i][j]*v[j]}
      assert.ok(quadratic>=-1e-8)
    }
  })
}
