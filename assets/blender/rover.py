"""Faceted rover equipment housings with exposed suspension and four independent wheels."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *

reset()
rubber = bpy.data.materials.new('rubber'); rubber.diffuse_color = (.01,.014,.015,1); MATERIALS['rubber'] = rubber
root = pivot('root')
body = pivot('body',root)
# One structural keel, two long wheel-clearance fenders and one equipment enclosure.
plate(body,(.28,.43,.068),(0,.098,0),'carbon','z',taper=.16,shoulder=.008,edge=HOUSING)
plate(body,(.265,.42,.045),(0,.121,0),'gunmetal','z',taper=.20,shoulder=.014,edge=HOUSING)
for side in [-1,1]:
    plate(body,(.069,.355,.028),(side*.104,.137,.009),'darkTitanium','z',taper=.16,shoulder=.010,edge=HOUSING)
    service(body,(.046,.175),(side*.103,.152,.007),'z')
    # The front cover follows the steering clearance; the rear opening exhausts heat.
    nose = plate(body,(.063,.067,.008),(side*.091,.149,-.155),'gunmetal','z',taper=.30)
    status_slit(body,nose,.029,.002,(side*.088,.153,-.164))
    for j in range(4):
        block(body,(.031,.002,.003),(side*.098,.151,.113+j*.012),'carbon',DETAIL)
    plate(body,(.018,.292,.018),(side*.138,.10,.009),'polished','z',edge=DETAIL)
    for z in [-.09,.10]:
        block(body,(.005,.013,.019),(side*.139,.106,z),'gunmetal',DETAIL)
plate(body,(.163,.209,.076),(0,.181,.014),'gunmetal','z',taper=.22,shoulder=.017,edge=HOUSING)
service(body,(.112,.137),(0,.219,.02),'z')
plate(body,(.093,.032,.003),(0,.216,-.069),'optic','z',taper=.15)
# A central nose hatch and straight rear louvres describe the accessible systems.
plate(body,(.078,.090,.015),(0,.145,-.155),'darkTitanium','z',taper=.30,shoulder=.004,edge=HOUSING)
for i in range(4):
    block(body,(.07,.002,.004),(0,.146,.145+i*.012),'carbon',DETAIL)
for side in [-1,1]:
    for offset in [-.003,0,.003]:
        cable(body,[(side*.10,.116,-.13),(side*(.13+offset),.11,-.06),
                    (side*(.13+offset),.11,.06),(side*.10,.116,.13)],.0014)
for z in [-.245,.245]:
    plate(body,(.27,.035,.04),(0,.085,z),'carbon','z',taper=.12,edge=HOUSING)
cylinder(body,.017,.029,(0,.217,.045),'carbon',segments=24)
cylinder(body,.033,.021,(0,.236,.045),'titanium',segments=40)
ring(body,.0335,.0017,(0,.24,.045),'lime','y',40)
cylinder(body,.026,.006,(0,.248,.045),'optic',segments=40)
for side in [-1,1]:
    block(body,(.059,.022,.012),(side*.09,.105,-.232),'head',DETAIL)
    block(body,(.05,.02,.012),(side*.1,.105,.232),'tail',DETAIL)
    for z in [-.15,.15]:
        axle = cylinder(root,.009,.11,(side*.12,.068,z),'titanium',segments=16)
        axle.rotation_euler.z = math.pi/2
antenna = pivot('antenna',body,(.1,.135,.17))
cylinder(antenna,.0035,.20,(0,.10,0),'carbon',segments=12)
cylinder(antenna,.008,.019,(0,.009,0),'titanium',segments=16)
plate(antenna,(.016,.021,.015),(0,.20,0),'owner',edge=DETAIL)
for i,(x,z) in enumerate([(-.135,-.15),(-.135,.15),(.135,-.15),(.135,.15)]):
    shock = pivot('shock'+str(i),root,(x,.10,z))
    # The coil follows the spring length; rigid sleeve and sliding rod have separate frames.
    sleeve = pivot('shockSleeve'+str(i),root)
    cylinder(sleeve,.009,.034,(0,.017,0),'gunmetal',segments=16)
    rod = pivot('shockRod'+str(i),root)
    cylinder(rod,.004,.05,(0,.025,0),'polished',segments=12)
    cable(shock,[(.014*math.cos(j*math.pi/4),-.033+j*.0014,.014*math.sin(j*math.pi/4)) for j in range(49)],.0018,'titanium')
    for y in [-.032,.033]:
        cylinder(shock,.016,.004,(0,y,0),'titanium',segments=24)
for i,(x,z) in enumerate([(-.17,-.15),(.17,-.15),(-.17,.15),(.17,.15)]):
    steering = pivot('steer'+str(i),root,(x,.065,z))
    wheel = pivot('wheel'+str(i),steering)
    wheel.rotation_euler.z = math.pi/2
    lathe(wheel,[(.035,-.026),(.047,-.027),(.058,-.023),(.062,-.015),(.062,.015),(.058,.023),(.047,.027),(.035,.026),(.035,-.026)],material='rubber',segments=48)
    for j in range(20):
        a = j*math.pi/10
        tread = block(wheel,(.016,.050,.008),(math.sin(a)*.062,0,math.cos(a)*.062),'rubber',DETAIL)
        tread.rotation_euler.y = a
    cylinder(wheel,.036,.049,material='gunmetal',segments=24)
    for side in [-1,1]:
        ring(wheel,.032,.002,(0,side*.026,0),'polished','y',40)
        cylinder(wheel,.011,.003,(0,side*.029,0),'titanium',segments=24)
        for j in range(6):
            a=j*math.pi/3
            spoke = block(wheel,(.026,.003,.006),(math.cos(a)*.022,side*.026,math.sin(a)*.022),'titanium',DETAIL)
            spoke.rotation_euler.y = -a
export('rover')
