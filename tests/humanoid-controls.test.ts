import { describe,it,expect } from 'vitest'
import { ActorControl,classical,PRESETS,presetPose,restIntent } from '../src/sim/humanoid/controls'
import { HUMANOID,neutral } from '../src/sim/humanoid/profile'
import { restInput } from '../src/sim/devices/types'
describe('humanoid control arbitration',()=>{
  it.each(PRESETS)('%s stays bounded and returns after completion',name=>{
    const a=new ActorControl(HUMANOID);a.play(name)
    for(let i=0;i<180;i++){const q=a.step(1/60,restIntent(),null);for(const j of HUMANOID.joints){expect(q[j.id]).toBeGreaterThanOrEqual(j.limits[0]);expect(q[j.id]).toBeLessThanOrEqual(j.limits[1])}}
    expect(a.preset).toBeNull()
  })
  it('Stop freezes joints and root, cancels presets and refuses new moves',()=>{
    const a=new ActorControl(HUMANOID);a.play('jab');a.step(.05,restIntent(),null);a.stop();const q={...a.q};a.play('wave');a.step(.05,{x:1,z:1,yaw:1,manual:true},presetPose(HUMANOID,'block',.5));expect(a.q).toEqual(q);expect(a.position.length()).toBe(0);expect(a.preset).toBeNull()
    a.resume();a.step(.05,{x:1,z:0,yaw:0,manual:true},null);expect(a.position.x).toBeGreaterThan(0)
  })
  it('manual input cancels presets and walking owns legs while BODY keeps the arms',()=>{
    const a=new ActorControl(HUMANOID),q=neutral(HUMANOID);q['left.arm.elbow']=1;a.play('jab')
    let excursion=0
    for(let i=0;i<30;i++){a.step(1/60,{x:0,z:-1,yaw:0,manual:true},q);excursion=Math.max(excursion,Math.abs(a.q['left.leg.pitch']))}
    expect(a.preset).toBeNull();expect(a.q['left.arm.elbow']).toBeGreaterThan(.95);expect(excursion).toBeGreaterThan(.1)
    for(let i=0;i<60;i++)a.step(1/60,restIntent(),q);expect(Math.abs(a.q['left.leg.pitch'])).toBeLessThan(.001)
  })
  it('supports tilt and trackpad locomotion without any camera',()=>{
    const input=restInput();input.tilt=[.4,-.5];expect(classical(input).manual).toBe(true);input.tilt=[0,0];input.drag=[5,-6];expect(classical(input).x).toBeCloseTo(.35)
  })
})
