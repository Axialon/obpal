"""Five original hard-surface arm skins, in the existing local joint frames.

The GLB's named groups are rigid appearance slots, not a second kinematic rig.
The live builder supplies the joints, contact fingers, rings and delta rods.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *


def enclosure(g, size, at, taper=0, material='gunmetal'):
    w,h,d=size
    cover=plate(g,(w,h,d),at,material,taper=taper,edge=HOUSING)
    if min(w,h) > .04 and d > .03:
        for side in [-1,1]:
            # Two service sections along a long link; never an array of scales.
            count=2 if h>w*2.5 else 1
            for i in range(count):
                panel_at=(at[0],at[1]+h*.76*((i+.5)/count-.5),at[2]+side*(d/2-.003))
                cutter=plate(g,(w*.68,h*.72/count,.012),(panel_at[0],panel_at[1],at[2]+side*d/2),'carbon',edge=DETAIL)
                mod=cover.modifiers.new('Service recess','BOOLEAN'); mod.operation='DIFFERENCE'; mod.solver='EXACT'; mod.object=cutter
                apply(cover); bpy.data.objects.remove(cutter,do_unlink=True)
                before=set(bpy.context.scene.objects)
                service(g,(w*.68,h*.72/count),panel_at)
                if side<0:
                    # service() creates three meshes, all sharing this rigid parent.
                    for child in set(bpy.context.scene.objects)-before: child.rotation_euler.y=math.pi


def spindle(g,r,h,at=(0,0,0),axis='z'):
    cylinder(g,r,h-.004,at,'darkTitanium',axis,24)
    for side in [-1,1]:
        p=list(at); p[1 if axis=='y' else 2]+=side*(h/2-.001)
        cylinder(g,r*.73,.002,tuple(p),'polished',axis,24)


def palm(g):
    enclosure(g,(.14,.035,.07),(0,.03,0),material='darkTitanium')


for name in ['arm5','six','desk','scara','delta']:
    reset()
    if name in ['arm5','six','desk']:
        groups={n:pivot(n) for n in ['root','yaw','shoulder','elbow','wrist','roll']}
        if name=='six': groups['twist']=pivot('twist')
        root,yaw,sh,el,wr,roll=[groups[n] for n in ['root','yaw','shoulder','elbow','wrist','roll']]
        if name=='arm5':
            enclosure(root,(.50,.1,.50),(0,.05,0))
            spindle(yaw,.17,.16,(0,.08,0),'y')
            spindle(sh,.085,.2); enclosure(sh,(.1,.55,.11),(0,.275,0),.18)
            spindle(el,.07,.17); enclosure(el,(.08,.46,.09),(0,.23,0),.14)
            spindle(wr,.055,.13); spindle(wr,.04,.1,(0,.06,0),'y')
        elif name=='six':
            enclosure(root,(.5,.12,.5),(0,.06,0))
            spindle(yaw,.17,.16,(0,.08,0),'y')
            enclosure(yaw,(.24,.2,.26),(0,.31,0),.12)
            spindle(sh,.11,.3); enclosure(sh,(.13,.55,.15),(0,.275,0),.16)
            spindle(el,.09,.24); enclosure(el,(.14,.14,.15),(0,.05,0),.12)
            enclosure(groups['twist'],(.11,.38,.11),(0,.19,0),.14)
            spindle(wr,.055,.14); spindle(wr,.045,.06,(0,.05,0),'y')
        else:
            enclosure(root,(.32,.08,.32),(0,.04,0))
            spindle(yaw,.13,.14,(0,.07,0),'y'); enclosure(yaw,(.2,.1,.22),(0,.17,0))
            for group,length,width,r,depth,rodx,rodz in [(sh,.34,.07,.06,.2,.045,.06),(el,.37,.06,.05,.14,.04,.05)]:
                spindle(group,r,depth); enclosure(group,(width,length,.05),(0,length/2,0),.12)
                block(group,(.018,length,.018),(rodx,length/2,rodz),'polished',DETAIL)
            enclosure(wr,(.08,.06,.08),(0,.03,0))
            block(roll,(.08,.05,.07),(0,-.01,0),'carbon')
        palm(roll)
    elif name=='scara':
        root,upper,fore,quill,hand=[pivot(n) for n in ['root','upper','fore','quill','hand']]
        enclosure(root,(.38,.06,.38),(0,.03,0)); enclosure(root,(.21,.4,.21),(0,.26,0))
        spindle(upper,.12,.1,axis='y'); enclosure(upper,(.45,.09,.2),(-.225,0,0),.12)
        spindle(fore,.1,.1,axis='y'); enclosure(fore,(.4,.08,.16),(-.2,0,0),.16)
        spindle(fore,.075,.14,(-.4,.02,0),'y'); cylinder(quill,.022,.54,(0,.27,0),'polished')
        spindle(hand,.045,.03,(0,-.005,0),'y'); palm(hand)
    else:
        root,deck,hand=[pivot(n) for n in ['root','plate','hand']]
        enclosure(root,(.34,.04,.34),(.85,.02,0))
        enclosure(root,(.1,1.96,.1),(.85,.98,0))
        enclosure(root,(.85,.07,.09),(.425,1.92,0))
        plate(root,(.38,.38,.06),(0,1.86,0),'gunmetal','z',edge=HOUSING)
        plate(deck,(.20,.20,.03),(0,0,0),'darkTitanium','z',edge=HOUSING)
        spindle(hand,.045,.03,(0,-.005,0),'y'); palm(hand)
        for i in range(3):
            mount,upper=pivot('mount'+str(i)),pivot('upper'+str(i))
            enclosure(mount,(.1,.12,.14),(.02,.02,0))
            enclosure(upper,(.34,.05,.07),(-.17,0,0),.12)
            spindle(upper,.03,.12,(-.34,0,0))
    export(name)
