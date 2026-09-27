"""Layered metal SO-101 armour on the existing six-joint skeleton, Y up."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *

reset()
root = pivot('root')
yaw = pivot('yaw', root, (0,.07,0))
shoulder = pivot('shoulder', yaw, (0,.19,0))
elbow = pivot('elbow', shoulder, (0,.28,0))
wrist = pivot('wrist', elbow, (0,.34,0))
roll = pivot('roll', wrist, (0,.15,0))
plate(root,(.294,.284,.052),(0,.026,0),'carbon','z',edge=HOUSING)
plate(root,(.288,.278,.043),(0,.039,0),'darkTitanium','z',shoulder=.012,edge=HOUSING)
cylinder(root,.128,.009,(0,.066,0),'darkTitanium',segments=48)
for i in range(6):
    a = i*math.pi/3
    cylinder(root,.004,.002,(math.cos(a)*.129,.068,math.sin(a)*.129),'carbon',segments=8)


def bearing(parent, radius, z):
    for side in [-1,1]:
        # Narrow races expose the drive splines; segmented shields protect the bearing.
        lathe(parent, [(radius*.35,-.006),(radius*.72,-.006),(radius*.83,-.004),(radius*.86,0),
                       (radius*.83,.004),(radius*.57,.004),(radius*.54,.008),(radius*.35,.008),
                       (radius*.35,-.006)], (0,0,side*z), 'gunmetal', 'z', 24)
        ring(parent,radius*.78,.0018,(0,0,side*(z+.005)),'polished','z',32)
        cylinder(parent,radius*.40,.013,(0,0,side*z),'carbon','z',16)
        for i in range(6):
            a = i*math.pi/3
            sector(parent,radius*.72,.008,(0,0,side*(z+.007)),a+.035,math.pi/3-.07,'darkTitanium','z',4)
            tooth = block(parent,(radius*.18,.004,.003),(math.cos(a)*radius*.42,math.sin(a)*radius*.42,side*(z+.009)),'polished',DETAIL)
            tooth.rotation_euler.z = a


def facing(parent, side, build):
    """Author a rear cover in its own local frame, then merge it into the rigid link."""
    before=set(bpy.context.scene.objects)
    build()
    if side < 0:
        # Rotate the complete cover instead of mirroring its normals.
        for o in set(bpy.context.scene.objects)-before:
            o.location.x=-o.location.x; o.location.z=-o.location.z
            o.rotation_euler.y=math.pi


def plates(parent,w,h,d,y):
    plate(parent,(w*.65,h*.94,d*.56),(0,y,0),'carbon',taper=.18,edge=HOUSING)
    for side in [-1,1]:
        def cover():
            plate(parent,(w,h*.90,d*.17),(0,y,d*.36),'darkTitanium',taper=.24,shoulder=.003,edge=HOUSING)
            if h > .15:
                # Two access panels follow the link axis, with a constant recessed seam.
                for j in [-1,1]:
                    service(parent,(w*.75,h*.34),(0,y+j*h*.195,d*.445))
                # A hidden tongue joins the two panels beneath the centre seam.
                block(parent,(w*.59,.006,.002),(0,y,d*.43),'carbon',DETAIL)
            else:
                service(parent,(w*.74,max(.024,h*.64)),(0,y,d*.445))
        facing(parent,side,cover)
        for x in [-1,1]:
            plate(parent,(w*.09,h*.68,d*.10),(x*w*.38,y,side*d*.28),'polished',taper=.18,edge=DETAIL)
        if h > .15:
            for j in range(2):
                cable(parent,[(side*w*.32,y-h*.36,(j-.5)*.009),(side*w*.45,y-h*.16,(j-.5)*.009),
                              (side*w*.43,y+h*.18,(j-.5)*.009),(side*w*.27,y+h*.34,(j-.5)*.009)],.0017)


for parent,dims,y in [(yaw,(.12,.09,.15),.045),(shoulder,(.10,.10,.12),0),
                     (elbow,(.09,.09,.11),0),(wrist,(.085,.085,.10),0),(roll,(.09,.05,.08),-.01)]:
    plate(parent,dims,(0,y,0),'carbon',taper=.10,shoulder=.004,edge=HOUSING)
    w,h,d=dims
    for side in [-1,1]:
        def servo_cover():
            plate(parent,(w*.9,h*.83,.005),(0,y,d/2-.002),'gunmetal',taper=.10)
            for i in range(3):
                block(parent,(w*.23,.002,.002),(0,y-h*.18+i*.009,d/2+.001),'carbon',DETAIL)
        facing(parent,side,servo_cover)
plates(yaw,.13,.12,.16,.13)
plates(shoulder,.075,.28,.10,.14)
plates(elbow,.065,.34,.085,.17)
plates(wrist,.06,.10,.07,.07)
plates(roll,.14,.035,.07,.03)
for parent,r,z in [(shoulder,.085,.07),(elbow,.075,.065),(wrist,.065,.06)]:
    bearing(parent,r,z)
cylinder(yaw,.104,.014,(0,.005,0),'darkTitanium',segments=40)
ring(yaw,.115,.003,(0,.006,0),'polished','y',40)
cylinder(roll,.041,.012,(0,-.04,0),'darkTitanium')
ring(roll,.042,.002,(0,-.042,0),'polished','y')
# Independent finger nodes use the same opening travel and inner faces as the collider.
for name, side in [('fingerLeft',-1),('fingerRight',1)]:
    finger = pivot(name, roll, (side*.054,.095,0))
    plate(finger,(.018,.10,.055),(0,0,0),'gunmetal',taper=0,edge=HOUSING)
    # One axial service inset per finger, contained within the collision envelope.
    before=set(bpy.context.scene.objects)
    service(finger,(.044,.071),(0,0,0),material='ceramic')
    for o in set(bpy.context.scene.objects)-before:
        o.rotation_euler.y=side*math.pi/2; o.location.x=side*.005
    for i in range(5):
        block(finger,(.001,.003,.040),(-side*.0084,-.025+i*.011,0),'carbon',DETAIL)

# Separate telescoping pieces span the elbow and wrist; the view solves their end anchors.
for name,parent in [('elbow',shoulder),('wrist',elbow)]:
    sleeve = pivot(name+'Sleeve',parent)
    cylinder(sleeve,.0065,.042,(0,.021,0),'gunmetal',segments=16)
    cylinder(sleeve,.008,.005,(0,.040,0),'gunmetal',segments=16)
    rod = pivot(name+'Rod',parent)
    cylinder(rod,.003,.070,(0,.035,0),'polished',segments=12)
export('so101')
