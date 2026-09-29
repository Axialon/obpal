"""An original eight-metre practice deck, with quiet distance marks and glass fins."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *


def build_arena(clear=True):
    if clear:
        reset()
    deck = pivot('arena')
    plate(deck, (8, 8, .12), (0, -.07, 0), 'carbon', axis='z', edge=.008)
    # Fine inlaid marks remain opaque, avoiding transparent sorting and textures.
    for i in range(-3, 4):
        for j in range(-3, 4):
            block(deck, (.032, .002, .004), (i, -.009, j), 'gunmetal', edge=.0002)
            block(deck, (.004, .002, .032), (i, -.009, j), 'gunmetal', edge=.0002)
    for s in [-1, 1]:
        block(deck, (.014, .006, 1), (s*2, -.005, 0), 'lime', edge=.001)
        for z in [-2.8, 2.8]:
            block(deck, (.75, .003, .014), (s*2.55, -.008, z), 'gunmetal', edge=.0002)
            plate(deck, (.75, .16, .035), (s*3.5, .065, z), 'optic', edge=.002)
    return deck


if __name__ == '__main__':
    build_arena()
    export('humanoid-arena')
