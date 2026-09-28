"""Original instrument shells. Membranes, keys, cymbals and their animation stay live."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import *

reset()
drums=[(0,0,0,0,0,.46,.55),(0,1,-.64,.64,.55,.28,.18),
       (0,4,.73,.52,.22,.34,.39),(0,5,.3,1,-.14,.25,.24),(0,6,-.26,1.03,-.13,.22,.22)]
for unit in [1,7]:
    drums.extend([(unit,9,-.43,.46,-.12,.26,.75),(unit,10,.24,.65,-.22,.2,.26),(unit,12,.58,.32,.4,.26,.5)])
for unit,n,x,y,z,r,h in drums:
    g=pivot('drum_'+str(unit)+'_'+str(n))
    # Resonant cylinders are intentional. Machined lips expose their construction.
    lathe(g,[(r-.015,-h/2),(r,-h/2),(r,h/2),(r-.015,h/2),(r-.015,-h/2)],(x,y,z),'darkTitanium','y',48)
for unit in [2,3,4,5]:
    g=pivot('case_'+str(unit))
    w,h,d,y=(1.4,.14,.95,.8) if unit==2 else (1.8,.18,.8,.72)
    cover=plate(g,(w,h,d),(0,y,0),'gunmetal',edge=HOUSING)
    for side in [-1,1]:
        panel=pivot('instrument-access',g,(0,y,side*(d/2-.003)))
        if side<0: panel.rotation_euler.y=math.pi
        access(panel,cover,(w*.65,h*.6),(0,0,0),'y')
export('studio')
