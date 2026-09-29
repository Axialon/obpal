/** Procedural stand-ins. Phase 3 can replace skins without changing named joint pivots. */
import * as THREE from 'three'
import { box, plastic, metal, batch } from '../kit'
import { forward, v } from './ik'
import { neutral, type Angles, type RigProfile } from './profile'
import type { ContactActor } from './contacts'
import { previewScene, type Preview } from '../devices/view'
import { HUMANOID } from './profile'
import { presetPose } from './controls'

export class Rig {
  readonly root=new THREE.Group()
  readonly pivots=new Map<string,THREE.Group>()
  private fk=forward(this.profile,neutral(this.profile))
  constructor(readonly profile:RigProfile, readonly variant=0) {
    const shell=plastic(variant?'#3b4549':'#252b32'), trim=plastic('#11171d')
    const lime=new THREE.MeshStandardMaterial({color:'#c6ff34',emissive:'#c6ff34',emissiveIntensity:.3,roughness:.35})
    const glass=plastic('#455c63')
    for(const j of profile.joints) {
      const pivot=new THREE.Group();pivot.name=j.id;pivot.position.set(...j.offset)
      this.pivots.set(j.id,pivot);(j.parent?this.pivots.get(j.parent)!:this.root).add(pivot)
    }
    const materials={shell,trim,glass,accent:lime,metal}
    for(const skin of profile.skins) {
      const mesh=skin.axle?new THREE.Mesh(new THREE.CylinderGeometry(skin.size[0],skin.size[0],skin.size[1],12),materials[skin.finish]):box(...skin.size,materials[skin.finish])
      if(skin.axle)mesh.rotation.z=Math.PI/2
      mesh.position.set(...skin.offset);this.pivots.get(skin.joint)!.add(mesh)
    }
    batch(this.root,[...this.pivots.values()])
  }
  pose(q:Angles,position=new THREE.Vector3(),yaw=0,offset=new THREE.Vector3()) {
    for(const j of this.profile.joints)this.pivots.get(j.id)!.quaternion.setFromAxisAngle(v(j.axis),q[j.id]||0)
    this.root.position.copy(offset).applyAxisAngle(new THREE.Vector3(0,1,0),yaw).add(position);this.root.rotation.y=yaw
    this.fk=forward(this.profile,q)
  }
  point(id:string) {return this.fk.get(id)!.p.clone().applyAxisAngle(new THREE.Vector3(0,1,0),this.root.rotation.y).add(this.root.position)}
  contact(id:string,blocked:boolean):ContactActor {
    const arms=this.profile.chains.filter(c=>c.group==='arms')
    const chest=this.point(this.profile.frame?.head[0]??this.profile.root).add(new THREE.Vector3(0,-.12,0)),fists=arms.map(c=>this.point(c.end))
    return {id,blocked:blocked||fists.some(p=>p.y>chest.y-.12),chest,pelvis:this.point(this.profile.root),fists,elbows:arms.map(c=>this.point(c.joints[3])),shoulders:arms.map(c=>this.point(c.joints[0]))}
  }
}
export function arena() {
  const group=new THREE.Group(),floor=box(8,.12,8,new THREE.MeshStandardMaterial({color:'#1b2328',roughness:.9,metalness:.1}))
  floor.position.y=-.08;group.add(floor)
  const lines:number[]=[]
  for(let i=-3;i<=3;i++){lines.push(i,-.014,-3.6,i,-.014,3.6,-3.6,-.014,i,3.6,-.014,i)}
  const grid=new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(lines,3)),new THREE.LineBasicMaterial({color:'#394449'}));group.add(grid)
  const edge=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(7.7,.012,7.7)),new THREE.LineBasicMaterial({color:'#72863f'}));group.add(edge)
  const line=box(.012,.015,1.2,plastic('#c6ff34'));line.position.set(-2,0,0);group.add(line)
  const other=line.clone();other.position.x=2;group.add(other)
  batch(group);return group
}
export function preview():Preview {
  const scene=previewScene(),rig=new Rig(HUMANOID);scene.add(rig.root)
  const camera=new THREE.PerspectiveCamera(35,1.6,.05,40);camera.position.set(2,1.7,-3.3);camera.lookAt(0,.9,0)
  return {scene,camera,step:t=>rig.pose(presetPose(HUMANOID,'wave',(t%2.2)/2.2))}
}
