"""An original eight-metre practice deck, with quiet distance marks and glass fins."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from humanoid_surfaces import finishes


def build_arena(clear=True):
    if clear:
        reset()
    finishes()
    deck = pivot('arena')
    # A 200 mm corner clip leaves every fin and luminous corner on the deck.
    # The kit's much larger equipment-case clip would cut under those fixtures.
    outline_points = outline(8, 8, clip=.025)
    vertices = [(x, y, z) for z in [-.06, .06] for x, y in outline_points]
    faces = [tuple(reversed(range(8))), tuple(range(8, 16))]
    faces += [(i, (i+1)%8, (i+1)%8+8, i+8) for i in range(8)]
    hard_mesh('Training deck', vertices, faces, deck, 'deckObsidian', (0, -.062, 0), 'z', .008)
    # Inlaid geometry costs two triangles per mark, with no texture or alpha sort.
    for i in range(-7, 8):
        for axis in [0, 1]:
            x, z = (i*.5, 0) if axis == 0 else (0, i*.5)
            w, d = (.003, 7.5) if axis == 0 else (7.5, .003)
            mesh('Etched half-metre grid', [(x-w/2, -.0005, z-d/2), (x+w/2, -.0005, z-d/2),
                 (x+w/2, -.0005, z+d/2), (x-w/2, -.0005, z+d/2)], [(3, 2, 1, 0)], deck, 'etch')
    for radius in [1, 2, 3]:
        points = []
        for r in [radius-.004, radius+.004]:
            points += [(r*math.cos(i*math.tau/128), .0001, r*math.sin(i*math.tau/128)) for i in range(128)]
        faces = [(i, i+128, (i+1)%128+128, (i+1)%128) for i in range(128)]
        mesh('Etched distance ring', points, faces, deck, 'etch')
    # Two diagonal luminous corners identify seats without outlining every edge.
    for s in [-1, 1]:
        for axis in [0, 1]:
            block(deck, (.018, .008, 1.05) if axis == 0 else (1.05, .008, .018),
                  (s*3.50 if axis == 0 else s*3.0, .002, s*3.0 if axis == 0 else s*3.50), 'lime', .001)
        # Fins surround all four sides, with small joints and a chamfered base.
        for axis in [0, 1]:
            for i in range(5):
                along = (i-2)*1.43
                fin = plate(deck, (1.34, .31, .026), (along, .146, s*3.82), 'arenaGlass', edge=.004)
                base = plate(deck, (1.35, .032, .072), (along, .009, s*3.82), 'graphite', edge=.003)
                if axis:
                    for obj in [fin, base]:
                        obj.location.x, obj.location.z = obj.location.z, obj.location.x
                        obj.rotation_euler.y = math.pi/2
    # A suspended quiet halo leaves every floor-to-robot camera sightline clear.
    ring(deck, 3.46, .028, (0, 3.18, 0), 'graphite', axis='y', segments=128)
    ring(deck, 3.46, .008, (0, 3.155, 0), 'halo', axis='y', segments=128)
    for x, z in [(-2.45, -2.45), (2.45, -2.45), (-2.45, 2.45), (2.45, 2.45)]:
        cylinder(deck, .008, .7, (x, 3.56, z), 'graphite', segments=8)
    return deck


if __name__ == '__main__':
    build_arena()
    export('humanoid-arena')
