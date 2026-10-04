/** Orchestration-only session checks; not native physics evidence. */
import { assert } from './sim-node.mjs'
import { supportFixture, type Register } from './humanoid-balance-cases'
const near = (a: number,b: number,e=1e-9) => assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`)
export function humanoidBalanceSessionCases(test: Register) {
  test('classical targets replay through the unchanged policy contract across partitions (synthetic contact orchestration only)', async()=>{
    const {HumanoidPilot}=await import('../src/sim/humanoid/physics/pilot')
    const {StanceController}=await import('../src/sim/humanoid/physics/stance')
    const {orchestrationBackend}=await import('./humanoid-pilot-double')
    const {angleBetween}=await import('../src/sim/physics/math')
    const {model,contacts}=await supportFixture()
    const factory:typeof orchestrationBackend=async(s,l)=>{const b=await orchestrationBackend(s,l);b.contacts=()=>structuredClone(contacts);return b}
    const first=await HumanoidPilot.create(model,{factory}),second=await HumanoidPilot.create(model,{factory})
    try { const controller=new StanceController(model,first.generation)
      for(let i=0;i<15;i++) first.advance(1/60,o=>controller.step(o).frame)
      const journal=first.journal();assert.equal(journal.length,60)
      for(let i=0;i<10;i++) second.advance(1/40,o=>({...journal[o.stateTick].action,source:'replay'}))
      const replay=second.journal();assert.equal(replay.length,60);assert.deepEqual(first.snapshot(),second.snapshot())
      for(let i=0;i<journal.length;i++) for(const id of Object.keys(journal[i].action.targets)) near(angleBetween(journal[i].action.targets[id],replay[i].action.targets[id]),0,5e-8)
    } finally {first.dispose();second.dispose()}
  })
}
