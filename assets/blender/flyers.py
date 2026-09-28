"""Original flyer skins. All rotor and landing-gear frames remain in the live rigs."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import *

reset()
cabin=pivot('cabinSkin')
# A low keel, sloping windshield and equipment shoulder replace the oval cabin.
plate(cabin,(.82,1.55,.70),(0,.48,-.2),'darkTitanium','z',taper=.22,shoulder=.10,edge=HOUSING)
plate(cabin,(.65,.72,.035),(0,.68,-.68),'optic',taper=.2,edge=DETAIL)
plate(cabin,(.56,.6,.24),(0,.82,.15),'darkTitanium','z',shoulder=.06,edge=HOUSING)
for side in [-1,1]:
    panel=pivot('access'+str(side),cabin,(side*.379,.40,-.19)); panel.rotation_euler.y=side*math.pi/2
    service(panel,(.50,.29),(0,0,0))
    # A small exposed turbine intake at the shoulder, with a continuous bore.
    lathe(cabin,[(.09,-.045),(.105,-.045),(.11,-.03),(.11,.03),(.105,.045),(.09,.045),(.09,-.045)],(side*.22,.88,.18),'titanium','z',32)
export('helicopter')

reset()
body=pivot('airframe')
# Deliberate planar fuselage shoulders, tapered aft, with thin airfoil plates.
plate(body,(.4,1.94,.44),(0,.15,0),'darkTitanium','z',taper=.48,shoulder=.075,edge=HOUSING)
plate(body,(2.55,.43,.075),(0,.23,-.05),'darkTitanium','z',taper=.18,edge=HOUSING)
plate(body,(1.02,.26,.045),(0,.3,.77),'titanium','z',taper=.28,edge=HOUSING)
plate(body,(.05,.42,.38),(0,.45,.7),'darkTitanium',taper=.3,edge=HOUSING)
plate(body,(.32,.64,.26),(0,.31,-.12),'optic','z',taper=.25,shoulder=.025,edge=DETAIL)
for x in [-.72,.72]: service(body,(.55,.24),(x,.270,-.05),'z')
service(body,(.18,.42),(0,.375,.31),'z')
export('plane')
