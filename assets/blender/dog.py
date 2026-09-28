"""Original rigid quadruped plates; gait pivots and feet belong to the procedural rig."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import *

reset()
g=pivot('bodySkin'); cover=plate(g,(.52,.27,1.03),(0,0,0),'gunmetal',edge=HOUSING)
for side in [-1,1]:
    side_access(g,cover,(.67,.16),(side*.257,0,0),side)
g=pivot('headSkin'); equipment(g,(.43,.3,.36),(0,.03,0),.2)
for n in range(4):
    g=pivot('hipSkin'+str(n)); plate(g,(.115,.32,.14),(0,-.17,0),'darkTitanium',taper=.15,edge=HOUSING)
    g=pivot('kneeSkin'+str(n)); plate(g,(.078,.32,.1),(0,-.17,0),'darkTitanium',taper=.18,edge=HOUSING)
export('dog')
