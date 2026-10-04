/** Contact-epoch material sliding; the historical all-state foot-origin displacement remains a separate field.
 * Positive native normal impulse is required at BOTH ends of a fixed-tick interval. Airborne motion is never sliding.
 */
import { STEP } from '../../physics/schema'
import type { PhysicalHumanoid } from './model'
import type { Observation } from './observation'
export interface FootSlip { loadedSamples: number; episodes: number; totalPathMm: number; maxEpisodePathMm: number; active: boolean }
interface State extends FootSlip { episodePathMm: number; previousSpeed: number; referenceX: number; referenceZ: number }
export class LoadedSlipMeter {
  private lastTick: number | null = null
  private firstTick: number | null = null
  private displacement = 0
  private samples = 0
  private feet = new Map<string, State>()
  private readonly identity: { profileId: string; actorId: string; version: string; feet: string[] }
  constructor(model: PhysicalHumanoid, private readonly generation: number) {
    if(!Number.isSafeInteger(generation)||generation<1) throw new RangeError('Invalid slip generation')
    this.identity={profileId:model.profileId,actorId:model.actorId,version:model.version,feet:[...model.feet]}
  }
  sample(o: Observation): void {
    const spec=this.identity
    // 1e-10 s is the numerical fixed-tick identity tolerance, not permission to skip or merge samples.
    if(o.schema_version!==1||o.modelVersion!==spec.version||o.profileId!==spec.profileId||o.actorId!==spec.actorId||o.generation!==this.generation||
      !Number.isSafeInteger(o.stateTick)||o.stateTick<0||o.stateTick===Number.MAX_SAFE_INTEGER||Math.abs(o.timeS-o.stateTick*STEP)>1e-10||!Number.isFinite(o.timeS)||
      (this.lastTick!==null&&o.stateTick!==this.lastTick+1)) throw new RangeError('Slip observation identity/tick mismatch')
    if(o.feet.length!==spec.feet.length||new Set(o.feet.map(f=>f.id)).size!==spec.feet.length) throw new RangeError('Invalid slip feet')
    for(const f of o.feet) if(!spec.feet.includes(f.id)||![f.centre.x,f.centre.y,f.centre.z,f.normalImpulseNs].every(Number.isFinite)||f.normalImpulseNs<0||
      (f.normalImpulseNs>0 ? f.tangentialSpeedMps===null||!Number.isFinite(f.tangentialSpeedMps)||f.tangentialSpeedMps<0 : f.tangentialSpeedMps!==null))
      throw new RangeError('Invalid slip sample')
    // Validate every foot first; malformed second-foot input cannot partly advance the first foot or the clock.
    const next=new Map([...this.feet].map(([id,s])=>[id,{...s}]))
    let displacement=this.displacement
    for(const f of o.feet) {
      const state=next.get(f.id)??{loadedSamples:0,episodes:0,totalPathMm:0,maxEpisodePathMm:0,active:false,episodePathMm:0,previousSpeed:0,
        referenceX:f.centre.x,referenceZ:f.centre.z}
      displacement=Math.max(displacement,1000*Math.hypot(f.centre.x-state.referenceX,f.centre.z-state.referenceZ))
      if(f.normalImpulseNs>0) {
        state.loadedSamples++
        if(state.active) { const path=1000*STEP*(state.previousSpeed+f.tangentialSpeedMps!)/2;state.totalPathMm+=path;state.episodePathMm+=path }
        else { state.episodes++;state.episodePathMm=0 }
        state.active=true;state.previousSpeed=f.tangentialSpeedMps!;state.maxEpisodePathMm=Math.max(state.maxEpisodePathMm,state.episodePathMm)
      } else { state.active=false;state.episodePathMm=0;state.previousSpeed=0 }
      if(!Number.isFinite(displacement)||!Number.isFinite(state.totalPathMm)) throw new RangeError('Slip metric overflow')
      next.set(f.id,state)
    }
    this.feet=next;this.displacement=displacement;this.firstTick??=o.stateTick;this.lastTick=o.stateTick;this.samples++
  }
  report() {
    return {schema_version:1 as const,firstTick:this.firstTick,lastTick:this.lastTick,samples:this.samples,fallDisplacementMm:this.displacement,
      feet:Object.fromEntries([...this.feet].map(([id,s])=>[id,{loadedSamples:s.loadedSamples,episodes:s.episodes,totalPathMm:s.totalPathMm,
        maxEpisodePathMm:s.maxEpisodePathMm,active:s.active} satisfies FootSlip]))}
  }
}
