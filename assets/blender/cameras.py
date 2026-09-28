"""Original camera and cleaning-device enclosures, independent of the working rigs."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import *

for name,size in [('film-camera',(.48,.31,.3)),('gimbal',(.52,.35,.3)),('ptz',(.18,.13,.26))]:
    reset()
    g=pivot('cameraSkin')
    cover=plate(g,size,(0,0,0),'gunmetal',edge=HOUSING)
    w,h,d=size
    for side in [-1,1]:
        side_access(g,cover,(d*.6,h*.58),(side*(w/2-.003),0,0),side)
    export(name)

reset()
g=pivot('bodySkin')
# The bumper and lidar retain their functional circles; the top is a clipped plate.
equipment(g,(.68,.095,.68),(0,.18,0),.05)
export('vacuum')
