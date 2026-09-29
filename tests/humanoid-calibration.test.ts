import { describe,it,expect } from 'vitest'
import { mapRange,parseCalibration,freshCalibration,RangeWalkthrough } from '../src/sim/humanoid/calibration'
import { HUMANOID,mirrorAngles,neutral } from '../src/sim/humanoid/profile'
import { Retargeter } from '../src/sim/humanoid/retarget'
import { humanoidBody } from './humanoid-fixture'
describe('personal range calibration',()=>{
  it('is monotonic and clamped for every reference joint',()=>{
    for(const j of HUMANOID.joints){let last=-Infinity;for(let i=-100;i<101;i++){const q=mapRange(i/50,[-.5,.8],j.limits);expect(q).toBeGreaterThanOrEqual(last);expect(q).toBeGreaterThanOrEqual(j.limits[0]);expect(q).toBeLessThanOrEqual(j.limits[1]);last=q}}
  })
  it('is identity when personal and robot ranges match',()=>{for(const j of HUMANOID.joints)for(let i=0;i<=20;i++){const v=j.limits[0]+(j.limits[1]-j.limits[0])*i/20;expect(mapRange(v,j.limits,j.limits)).toBeCloseTo(v)}})
  it('maps the full personal reach onto the full safe range',()=>{expect(mapRange(.2,[.2,.8],[-1,2])).toBe(-1);expect(mapRange(.8,[.2,.8],[-1,2])).toBe(2)})
  it('keeps asymmetric anatomical ranges when mirror changes',()=>{
    const r=new Retargeter(HUMANOID),q=neutral(HUMANOID);q['left.arm.elbow']=.7;q['right.arm.elbow']=.5
    r.data.ranges={'left.arm.elbow':[.2,.7],'right.arm.elbow':[0,1.8]};r.mirror=false
    const original=r.step(humanoidBody(q),100).q;r.setMirror(true)
    const mirrored=r.step(humanoidBody(q,200),200).q
    expect(mirrored['right.arm.elbow']).toBeCloseTo(original['left.arm.elbow']);expect(mirrored['left.arm.elbow']).toBeCloseTo(original['right.arm.elbow'])
    expect(mirrorAngles(HUMANOID,mirrorAngles(HUMANOID,q))).toEqual(q)
  })
  it('rejects corrupt, tiny, reversed and non-finite calibration ranges',()=>{
    expect(mapRange(.2,[0,0],[-1,1])).toBe(.2)
    expect(parseCalibration('{',HUMANOID)).toEqual(freshCalibration(HUMANOID))
    const data={v:1,profile:HUMANOID.id,ranges:{'head.yaw':[1,-1],'head.pitch':[0,.01]},lengths:{'left.arm.upper':10}}
    expect(parseCalibration(JSON.stringify(data),HUMANOID)).toEqual(freshCalibration(HUMANOID))
  })
  it('serialises only known derived ranges and lengths',()=>{
    const data={v:1,profile:HUMANOID.id,ranges:{'head.yaw':[-.5,.5],secret:[1,2]},lengths:{'left.arm.upper':.3},landmarks:[[1,2,3]],frames:'image'}
    expect(parseCalibration(JSON.stringify(data),HUMANOID)).toEqual({v:1,profile:HUMANOID.id,ranges:{'head.yaw':[-.5,.5]},lengths:{'left.arm.upper':.3}})
  })
  it('completes, skips and redoes individual steps without inventing unseen ranges',()=>{
    const w=new RangeWalkthrough(HUMANOID,freshCalibration(HUMANOID)),q=neutral(HUMANOID);w.start()
    expect(w.complete()).toBe(false)
    const id=w.step.joints[0];w.sample(q,new Set([id]));q[id]=.8;w.sample(q,new Set([id]));expect(w.complete()).toBe(true)
    expect(w.done.has('shoulders')).toBe(true);expect(Object.keys(w.data.ranges)).toEqual([id]);w.skip();expect(w.skipped.has('elbows')).toBe(true)
    w.redo(0);expect(w.data.ranges[id]).toBeUndefined();expect(w.done.has('shoulders')).toBe(false)
  })
})
