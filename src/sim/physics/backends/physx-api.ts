/** Aliases to the installed 2.8.0 declaration. WebIDL return-value ownership still needs the IDL. */
import type PhysX from 'physx-js-webidl'
export type PhysXAPI = typeof PhysX & typeof PhysX.PxTopLevelFunctions
export type Handle = object
export interface Releasable { release(): void }
export type Physics = PhysX.PxPhysics
export type Scene = PhysX.PxScene
export type Actor = PhysX.PxRigidActor
export type Rigid = PhysX.PxRigidBody
export type Dynamic = PhysX.PxRigidDynamic
export type Link = PhysX.PxArticulationLink
export type Articulation = PhysX.PxArticulationReducedCoordinate
export type PxVector = PhysX.PxVec3
export type PxPose = PhysX.PxTransform
export type Tolerances = PhysX.PxTolerancesScale
/** Runtime WebIDL handles carry a pointer that the generated declaration omits. */
export const nativePointer = (value: object): number => (value as { ptr: number }).ptr
