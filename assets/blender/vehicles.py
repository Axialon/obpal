"""Original chassis skins. Wheels, steering, tracks, tools and controls stay procedural."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import *

reset()
g=pivot('chassisSkin')
equipment(g,(.66,.2,.68),(0,.36,-.53),.32)
plate(g,(.90,.20,.13),(0,.3,-.96),'darkTitanium','z',taper=.18,edge=HOUSING)
for x in [-.5,.5]: equipment(g,(.18,.25,.63),(x,.34,.05),.18)
export('kart')

reset()
g=pivot('hullSkin')
# The bow facets terminate in a broad clipped nose, clear of the waterline.
equipment(g,(.94,.38,1.90),(0,.09,-.1),.42)
equipment(g,(.63,.10,.65),(0,.27,.23),.06,'darkTitanium')
plate(g,(.58,.53,.3),(0,.43,-.15),'gunmetal','z',taper=.12,shoulder=.025,edge=HOUSING)
plate(g,(.55,.20,.02),(0,.57,-.43),'optic',taper=.15,edge=DETAIL)
equipment(g,(.65,.05,.64),(0,.66,-.17),.12)
export('boat')

reset()
g=pivot('chassisSkin'); equipment(g,(1.15,.3,1.7),(0,.5,0),.18)
equipment(g,(1.5,.09,1.9),(0,.62,0),.10,'darkTitanium')
t=pivot('turretSkin'); equipment(t,(.75,.25,.65),(0,.12,0),.22)
export('tank')

reset()
g=pivot('chassisSkin'); equipment(g,(1,.4,1.55),(0,.48,0),.1)
equipment(g,(1.04,.6,.5),(0,.68,.55),.08,'darkTitanium')
equipment(g,(1.02,.08,1.08),(0,1.82,0),.08)
export('forklift')

reset()
g=pivot('upperSkin'); equipment(g,(1.35,.4,1.35),(0,0,.2),.12)
equipment(g,(.74,.07,.9),(-.37,.98,.13),.12,'darkTitanium')
for name,w,h,length in [('boomSkin',.23,.24,1.7),('stickSkin',.2,.2,1.45)]:
    g=pivot(name); equipment(g,(w,h,length),(0,0,-length/2),.18)
export('excavator')

reset()
g=pivot('bodySkin'); equipment(g,(.26,.1,.62),(0,.08,0),.23)
plate(g,(.22,.28,.1),(0,.17,.02),'optic','z',taper=.18,shoulder=.015,edge=DETAIL)
equipment(g,(.2,.025,.19),(0,.23,.025),.18,'darkTitanium')
export('slotcars')

reset()
g=pivot('chassisSkin'); equipment(g,(.95,.28,1.2),(0,.57,0),.16)
m=pivot('mastSkin'); equipment(m,(.38,.18,.23),(0,0,0),.08,'darkTitanium')
export('planetary')

reset()
g=pivot('hullSkin')
# Functional pressure cylinder with faceted ballast shoulders; no oval armour caps.
lathe(g,[(0,-1.2),(.20,-1.17),(.42,-.97),(.48,-.72),(.48,.72),(.37,1.05),(.18,1.2),(0,1.2)],material='darkTitanium',axis='z',segments=48)
equipment(g,(.46,.46,.52),(0,.51,.04),.20)
cover=plate(g,(.52,1.20,.06),(0,.47,0),'gunmetal','z',taper=.15,edge=HOUSING)
access(g,cover,(.34,.78),(0,.497,0),'z')
for x in [-.47,.47]:
    lathe(g,[(0,-.68),(.10,-.64),(.13,-.55),(.13,.55),(.10,.64),(0,.68)],(x,-.22,.1),'gunmetal','z',24)
export('submarine')
