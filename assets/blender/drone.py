"""Four duct survey drone, authored from an empty scene. Run with Blender -b."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *

reset()
body = pivot('body')
# A faceted avionics wedge, not a tiled sphere. The access split follows its spine.
plate(body,(.205,.264,.068),(0,.112,0),'carbon','z',taper=.16,shoulder=.011,edge=HOUSING)
avionics = plate(body,(.202,.259,.074),(0,.119,0),'gunmetal','z',taper=.20,shoulder=.019,edge=HOUSING)
for side in [-1,1]:
    service(body,(.066,.155),(side*.038,.156,.006),'z')
    plate(body,(.026,.159,.019),(side*.092,.105,.01),'darkTitanium','z',taper=.16,edge=HOUSING)
    for i in range(5):
        block(body,(.013,.008,.003),(side*.096,.107,-.03+i*.013),'carbon',DETAIL)
    cable(body,[(side*.065,.075,-.083),(side*.09,.013,-.12),(side*.09,.013,.12),(side*.064,.07,.08)],.005,'polished')
    status_slit(body,avionics,.023,.002,(side*.042,.156,-.086))
plate(body,(.027,.211,.009),(0,.154,.005),'darkTitanium','z',taper=.18,edge=DETAIL)
gimbal = pivot('gimbal',body,(0,.065,-.132))
plate(gimbal,(.058,.044,.030),(0,0,0),'carbon','z',taper=.18,edge=HOUSING)
plate(gimbal,(.060,.034,.013),(0,.015,0),'darkTitanium','z',taper=.15,edge=DETAIL)
block(gimbal,(.047,.023,.008),(0,0,-.025),'gunmetal',DETAIL)
block(gimbal,(.039,.016,.003),(0,0,-.03),'optic',DETAIL)
block(gimbal,(.022,.002,.004),(0,-.013,-.027),'lime',DETAIL)
for side in [-1,1]:
    b = cylinder(gimbal,.013,.004,(side*.033,0,0),'polished','z',24)
    b.rotation_euler.y=math.pi/2
leads = pivot('leads', body, (.065, .067, .055))
for offset in [-.0025,0,.0025]:
    cable(leads, [(0,0,0), (.012+offset,-.025,.02), (.012+offset,-.02,.045), (0,0,.06)], .0012)
for i, (x, z) in enumerate([(-1,-1), (1,-1), (-1,1), (1,1)]):
    arm = plate(body,(.036,.20,.025),(x*.105,.09,z*.105),'carbon','z',taper=.12,edge=HOUSING)
    arm.rotation_euler.y = math.pi / 4 if x*z > 0 else -math.pi / 4
    cap = plate(body,(.032,.09,.010),(x*.107,.105,z*.107),'darkTitanium','z',taper=.25,edge=DETAIL)
    cap.rotation_euler.y = arm.rotation_euler.y
    # Continuous turned bores with eight precision guard segments and radial vanes.
    profile = [(.096,-.019),(.106,-.019),(.108,.011),(.103,.019),(.097,.017),(.096,-.019)]
    lathe(body, profile, (x*.17,.119,z*.17), 'carbon',segments=48)
    for j in range(8):
        sector(body,.111,.038,(x*.17,.119,z*.17),j*math.pi/4+SEAM/(2*.111),math.pi/4-SEAM/.111,
               'darkTitanium')
    ring(body, .102, .0018, (x*.17, .139, z*.17), 'polished', 'y', 48)
    cylinder(body, .023, .032, (x*.17, .105, z*.17), 'carbon')
    cylinder(body, .019, .036, (x*.17, .108, z*.17), 'polished')
    for j in range(5):
        a = j*2*math.pi/5
        fin = block(body, (.075, .006, .004), (x*.17+math.cos(a)*.06, .107, z*.17+math.sin(a)*.06), 'carbon', DETAIL)
        fin.rotation_euler.y = -a
    prop = pivot('prop'+str(i), body, (x*.17, .133, z*.17))
    for j in range(3):
        a = j*2*math.pi/3
        blade = plate(prop,(.022,.087,.003),(math.sin(a)*.05,0,math.cos(a)*.05),'rotor','z',taper=.38)
        blade.rotation_euler = (.10, a, .12)
    cylinder(prop, .014, .009, (0,.001,0), 'polished', segments=20)
    for j in range(6):
        a=j*math.pi/3
        tooth=block(prop,(.005,.009,.003),(math.cos(a)*.017,-.008,math.sin(a)*.017),'titanium',.0005)
        tooth.rotation_euler.y=-a
    cable(body, [(x*.063,.086,z*.045),(x*.105,.099,z*.1),(x*.163,.098,z*.16)], .002)
block(body, (.045,.004,.006), (0,.10,.134), 'owner', DETAIL)
export('drone')
