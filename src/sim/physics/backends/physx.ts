/** Browser-only PhysX 2.8.0. Native reduced-coordinate links, not a chain of maximal-coordinate joints. */
import wasmUrl from 'physx-js-webidl/physx-js-webidl.wasm?url'
import type { BackendFactory, Backend, Body, BodyState } from '../schema'
import { ZERO, cross, sub, multiply, conjugate, fromRotationVector, norm, type Vec3, type Quat } from '../math'
import { nativePointer, type PhysXAPI, type Handle, type Physics, type Scene, type Actor, type Rigid, type Dynamic, type Link, type Articulation, type PxVector, type PxPose, type Releasable, type Tolerances } from './physx-api'
interface SDK { P: PhysXAPI; physics: Physics; scale: Tolerances; mark: (label: string) => void }
let sdk: Promise<SDK> | undefined
async function load(): Promise<SDK> {
  if (typeof window === 'undefined') throw new Error('physx-js-webidl@2.8.0 is web-only; run OBPAL_E2E_SIMS_ONLY=physics-bench')
  if (!sdk) sdk = (async () => {
    const module = await import('physx-js-webidl')
    let phase = 'WASM initialization'
    const init = module.default as unknown as (options: { locateFile: (path: string) => string; onAbort: (reason: string) => void; print: (message: string) => void }) => Promise<PhysXAPI>
    if (typeof init !== 'function') throw new Error('PhysX 2.8.0 module factory is unavailable')
    const P = await init({ locateFile: path => { if (!path.endsWith('.wasm')) throw new Error(`Unexpected PhysX asset: ${path}`); return wasmUrl },
      onAbort: reason => console.error(`PhysX abort during ${phase}: ${reason}`), print: message => console.error(`PhysX native: ${message}`) })
    if (!Number.isInteger(P.PHYSICS_VERSION) || !P.PxArticulationJointTypeEnum || !P.PxArticulationAxisEnum) throw new Error('Unsupported PhysX binding API')
    // Shared SDK + WASM are intentionally process-lifetime caches. Each scene and its actors are owned below.
    const allocator = new P.PxDefaultAllocator(), error = new P.PxErrorCallbackImpl(), scale = new P.PxTolerancesScale()
    const string = (ptr: string | number) => { if (typeof ptr === 'string') return ptr; const heap = P.HEAPU8; let end = ptr; while (end < heap.length && heap[end]) end++; return new TextDecoder().decode(heap.subarray(ptr, end)) }
    error.reportError = (code, message, file, line) => console.error(`PhysX error ${code}: ${string(message)} (${string(file)}:${line})`)
    let foundation: Releasable | undefined
    try {
      if (!scale.isValid()) throw new Error('Invalid PhysX tolerances scale')
      phase = 'CreateFoundation'; foundation = P.CreateFoundation(P.PHYSICS_VERSION, allocator, error)
      if (!foundation || nativePointer(foundation) === 0) throw new Error('PhysX foundation allocation failed')
      phase = 'CreatePhysics'; const physics = P.CreatePhysics(P.PHYSICS_VERSION, foundation, scale)
      if (!physics || nativePointer(physics) === 0) throw new Error('PhysX physics allocation failed')
      phase = 'scene initialization or step'; return { P, physics, scale, mark: (label: string) => { phase = label } }
    } catch (e) { foundation?.release(); P.destroy(scale); P.destroy(error); P.destroy(allocator); throw e }
  })().catch(error => { sdk = undefined; throw error })
  return sdk
}
interface Entry { spec: Body; actor: Actor; rigid: Rigid | null; dynamic: Dynamic | null; art: Articulation | null }
export const createPhysXBackend: BackendFactory = async (input, limits): Promise<Backend> => {
  if (input.joints.some(j => j.motor.integration !== undefined)) throw new RangeError('PhysX native drives do not support inertia-damped torque integration')
  if (input.contact) throw new RangeError('PhysX backend does not support requested contact solver settings')
  const { P, physics, scale: tolerance, mark } = await load()
  const cleanup: (() => void)[] = [], entries = new Map<string, Entry>()
  let nativeScene: Scene | undefined, disposed = false
  const own = <T extends Releasable>(value: T): T => { if (!value || nativePointer(value) === 0) throw new Error('PhysX allocation failed'); cleanup.push(() => value.release()); return value }
  const temp = <T extends Handle, R>(value: T, fn: (v: T) => R, label = value.constructor.name): R => { try { return fn(value) } finally { mark(`destroy ${label}`); P.destroy(value) } }
  const vector = (v: Vec3) => new P.PxVec3(v.x, v.y, v.z)
  const withVector = <T>(v: Vec3, fn: (p: PxVector) => T) => temp(vector(v), fn)
  const pose = (p: Vec3, q: Quat, fn: (pose: PxPose) => void) => temp(new P.PxTransform(P.PxIDENTITYEnum.PxIdentity), t => {
    withVector(p, v => t.p = v); temp(new P.PxQuat(q.x, q.y, q.z, q.w), r => t.q = r); fn(t)
  })
  const readVector = (v: PxVector): Vec3 => ({ x: v.x, y: v.y, z: v.z })
  const dispose = () => {
    if (disposed) return; disposed = true; entries.clear()
    mark('release native scene objects')
    // Reverse dependency order; continue freeing after one failure, but never hide that failure.
    const errors: unknown[] = []
    for (const release of cleanup.reverse()) try { release() } catch (e) { errors.push(e) }
    cleanup.length = 0
    if (errors.length) throw new Error(`PhysX disposal failure: ${String(errors[0])}`)
  }
  const get = (id: string) => { if (disposed) throw new Error('PhysX backend disposed'); const e = entries.get(id); if (!e) throw new RangeError('Unknown PhysX body'); return e }
  const configure = (b: Body, actor: Actor, rigid: Rigid | null) => {
    const material = physics.createMaterial(Math.sqrt(b.friction), Math.sqrt(b.friction), b.restitution)
    try {
      material.setFrictionCombineMode(P.PxCombineModeEnum.eMULTIPLY); material.setRestitutionCombineMode(P.PxCombineModeEnum.eMIN)
      const geometry = b.shape.kind === 'sphere' ? new P.PxSphereGeometry(b.shape.radius) : b.shape.kind === 'box' ?
        new P.PxBoxGeometry(b.shape.half.x, b.shape.half.y, b.shape.half.z) : new P.PxPlaneGeometry()
      temp(geometry, geometry => temp(new P.PxShapeFlags(P.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | P.PxShapeFlagEnum.eSIMULATION_SHAPE), flags => {
        const shape = physics.createShape(geometry, material, true, flags)
        try {
          temp(new P.PxFilterData(1, 1, 0, 0), filter => shape.setSimulationFilterData(filter))
          shape.setRestOffset(0); shape.setContactOffset(.001)
          // PhysX plane's local normal is +X; the shared scene convention is +Y.
          if (b.shape.kind === 'plane') pose(ZERO, fromRotationVector({ x: 0, y: 0, z: Math.PI / 2 }), t => shape.setLocalPose(t))
          if (!actor.attachShape(shape)) throw new Error('PhysX shape attachment failed')
        } finally { shape.release() }
      }))
    } finally { material.release() }
    if (rigid) {
      rigid.setMass(b.mass)
      const inertia = b.shape.kind === 'sphere' ? { x: .4 * b.mass * b.shape.radius ** 2, y: .4 * b.mass * b.shape.radius ** 2, z: .4 * b.mass * b.shape.radius ** 2 } :
        b.shape.kind === 'box' ? { x: b.mass / 3 * (b.shape.half.y ** 2 + b.shape.half.z ** 2), y: b.mass / 3 * (b.shape.half.x ** 2 + b.shape.half.z ** 2), z: b.mass / 3 * (b.shape.half.x ** 2 + b.shape.half.y ** 2) } : { x: 1, y: 1, z: 1 }
      withVector(inertia, i => rigid.setMassSpaceInertiaTensor(i))
      rigid.setLinearDamping(b.linearDamping); rigid.setAngularDamping(b.angularDamping)
      rigid.setMaxLinearVelocity(limits.maxSpeed); rigid.setMaxAngularVelocity(limits.maxAngularSpeed)
    }
  }
  try {
    mark('DefaultCpuDispatcherCreate'); const dispatcher = P.DefaultCpuDispatcherCreate(0)
    if (!dispatcher || nativePointer(dispatcher) === 0) throw new Error('PhysX dispatcher allocation failed')
    // The binding exposes a destructor, not PxDefaultCpuDispatcher::release.
    cleanup.push(() => P.destroy(dispatcher))
    mark('PxSceneDesc constructor')
    temp(new P.PxSceneDesc(tolerance), desc => {
      withVector(input.gravity, g => desc.gravity = g); mark('set_cpuDispatcher'); desc.cpuDispatcher = dispatcher
      mark('DefaultFilterShader'); const shader = P.DefaultFilterShader(); mark('set_filterShader'); desc.filterShader = shader; desc.bounceThresholdVelocity = .2; desc.solverType = P.PxSolverTypeEnum.eTGS
      if (!desc.isValid()) throw new Error('Invalid PhysX scene descriptor')
      mark('createScene'); nativeScene = own(physics.createScene(desc))
    })
    const byId = new Map(input.bodies.map(b => [b.id, b])), children = new Map<string, typeof input.joints>()
    for (const j of input.joints) children.set(j.parent, [...(children.get(j.parent) ?? []), j])
    const childIds = new Set(input.joints.map(j => j.child))
    for (const root of input.bodies.filter(b => !childIds.has(b.id))) {
      if (!children.has(root.id)) {
        pose(root.position, root.rotation, t => {
          mark('createRigidActor'); const actor = own(root.fixed ? physics.createRigidStatic(t) : physics.createRigidDynamic(t)), dynamic = root.fixed ? null : actor as Dynamic
          mark('configure actor'); configure(root, actor, dynamic)
          entries.set(root.id, { spec: root, actor, rigid: dynamic, dynamic, art: null })
          if (dynamic) { dynamic.setSolverIterationCounts(8, 2); withVector(root.velocity, v => dynamic.setLinearVelocity(v, false)); withVector(root.angularVelocity, v => dynamic.setAngularVelocity(v, false)) }
          mark('addActor'); if (nativeScene!.addActor(actor) === false) throw new Error('PhysX actor insertion failed')
        })
        continue
      }
      const art = own(physics.createArticulationReducedCoordinate())
      art.setArticulationFlag(P.PxArticulationFlagEnum.eFIX_BASE, root.fixed)
      art.setArticulationFlag(P.PxArticulationFlagEnum.eDISABLE_SELF_COLLISION, false)
      art.setSolverIterationCounts(8, 2)
      const addLink = (b: Body, parent: Link | null): Link => {
        // A cache/coordinate initial-velocity API is deliberately not fabricated for articulation links.
        if (b.shape.kind === 'plane' || norm(b.velocity) > 0 || norm(b.angularVelocity) > 0) throw new Error('Unsupported PhysX articulated plane or nonzero initial link velocity')
        let link!: Link
        // Native createLink accepts null for the root; the generated declaration omits nullability.
        pose(b.position, b.rotation, t => { link = art.createLink(parent as Link, t) })
        if (!link || nativePointer(link) === 0) throw new Error('PhysX articulation link allocation failed')
        configure(b, link, link); entries.set(b.id, { spec: b, actor: link, rigid: link, dynamic: null, art })
        for (const j of children.get(b.id) ?? []) {
          const child = byId.get(j.child)!, childLink = addLink(child, link), joint = childLink.getInboundJoint()
          if (!joint || nativePointer(joint) === 0) throw new Error('PhysX inbound joint allocation failed')
          // Native default is 0.05 Coulomb friction; the shared joint law only specifies motor damping.
          joint.setFrictionCoefficient(0)
          joint.setJointType(P.PxArticulationJointTypeEnum.eSPHERICAL)
          pose(j.anchorParent, j.frameParent, t => joint.setParentPose(t))
          // Zero native coordinates correspond to the supplied initial orientation. All 3 axes are free;
          // the common controller evaluates limits in the original, independent controller frames.
          const initialFrame = multiply(conjugate(child.rotation), multiply(b.rotation, j.frameParent))
          pose(j.anchorChild, initialFrame, t => joint.setChildPose(t))
          for (const axis of [P.PxArticulationAxisEnum.eTWIST, P.PxArticulationAxisEnum.eSWING1, P.PxArticulationAxisEnum.eSWING2]) joint.setMotion(axis, P.PxArticulationMotionEnum.eFREE)
        }
        return link
      }
      addLink(root, null)
      if (nativeScene!.addArticulation(art) === false) throw new Error('PhysX articulation insertion failed')
    }
    return {
      id: 'physx', version: `physx-js-webidl@2.8.0 / PHYSICS_VERSION=${P.PHYSICS_VERSION}`,
      capabilities: { contacts: 'sphere, box and infinite half-space', articulation: 'native reduced-coordinate spherical tree (TGS)', motor: 'bounded-torque',
        cones: 'common compliant elliptical swing/twist stop', wheels: 'static-ray-suspension', buoyancy: 'sampled-displacement',
        unsupported: ['Node environment', 'native motor comparison (common torque law used)', 'nonzero initial articulation link velocities', 'articulated plane root', 'compound or mesh colliders in this adapter', 'dynamic tyre terrain', 'CCD in this adapter'] },
      read(id): BodyState {
        const e = get(id); mark('read body state')
        // WebIDL [Value] getters use static return storage. Copy immediately; never destroy it.
        const t = e.actor.getGlobalPose(), q = t.q, position = readVector(t.p), rotation = { x: q.x, y: q.y, z: q.z, w: q.w }
        return { id, position, rotation,
          velocity: e.spec.fixed ? { ...ZERO } : readVector(e.rigid!.getLinearVelocity()),
          angularVelocity: e.spec.fixed ? { ...ZERO } : readVector(e.rigid!.getAngularVelocity()),
          sleeping: e.spec.fixed || (e.art ? e.art.isSleeping() : e.dynamic!.isSleeping()) }
      },
      force(id, f, p) {
        const e = get(id); if (e.spec.fixed) return
        withVector(f, v => e.rigid!.addForce(v, P.PxForceModeEnum.eFORCE, false))
        const centre = readVector(e.actor.getGlobalPose().p)
        withVector(cross(sub(p, centre), f), v => e.rigid!.addTorque(v, P.PxForceModeEnum.eFORCE, false))
      },
      torque(id, t) { const e = get(id); if (!e.spec.fixed) withVector(t, v => e.rigid!.addTorque(v, P.PxForceModeEnum.eFORCE, false)) },
      sleep(id, sleeping) { const e = get(id); if (e.spec.fixed) return; const target = e.art ?? e.dynamic!; if (sleeping) target.putToSleep(); else target.wakeUp() },
      step(dt) {
        if (disposed) throw new Error('PhysX backend disposed')
        mark('simulate')
        nativeScene!.simulate(dt)
        mark('fetchResults')
        if (!nativeScene!.fetchResults(true)) throw new Error('PhysX fetchResults failed')
        mark('clear accumulated forces')
        for (const e of entries.values()) if (!e.spec.fixed) { e.rigid!.clearForce(P.PxForceModeEnum.eFORCE); e.rigid!.clearTorque(P.PxForceModeEnum.eFORCE) }
      },
      memoryBytes: () => P.HEAPU8?.byteLength ?? null, // Entire shared WASM heap, not live per-world allocation.
      dispose,
    }
  } catch (error) { try { dispose() } catch { /* Preserve the original init error; all releases were attempted. */ }; throw error }
}
