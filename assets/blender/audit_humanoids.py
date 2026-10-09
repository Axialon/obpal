"""Authoring clearance audit. BVH intersections outside a joint's nested bearing
are reported, never silently counted as an acceptable overlap. Run headlessly.

A soft model's skinned suit is deformed by its own linear blend at every audited
pose, exactly as the browser skins it. Each triangle belongs to the pivot that
carries most of its weight, so the suit's region on the moving pivot is checked
against its region on the stationary one (and both against the rigid covers),
as adjacent rigid covers are. Triangles that share a vertex across the region
boundary are the suit's own continuous surface, not a crossing.
"""
import sys
import json
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from humanoids import build_robot
from humanoids_soft import build_soft, FORMS
from common import *
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_ray_tri
import numpy as np

OUT = Path(tempfile.mkdtemp(prefix='obpal-humanoid-clearance-'))
CACHE = Path(sys.argv[sys.argv.index('--cache-dir')+1]) if '--cache-dir' in sys.argv else ROOT/'artifacts/humanoid-third/build/source'


def shell_tree(obj):
    vertices = [obj.matrix_world @ v.co for v in obj.data.vertices]
    # The cuts leave concave polygons. Blender's tessellator is essential here:
    # a fan from polygon vertex zero would invent triangles across a socket.
    obj.data.calc_loop_triangles()
    faces = [tuple(tri.vertices) for tri in obj.data.loop_triangles]
    return BVHTree.FromPolygons(vertices, faces, all_triangles=True), vertices, faces


def intersections(a, b):
    """Actual segment/triangle crossing points, not broad-phase face centroids."""
    result = []
    for polygon, other in [(a, b), (b, a)]:
        for i in range(len(polygon)):
            origin, end = polygon[i], polygon[(i+1)%len(polygon)]
            direction = end-origin
            if direction.length_squared < 1e-14:
                continue
            for j in range(1, len(other)-1):
                hit = intersect_ray_tri(other[0], other[j], other[j+1], direction, origin, True)
                if hit is not None:
                    t = (hit-origin).dot(direction)/direction.length_squared
                    if 1e-6 < t < 1-1e-6:
                        result.append(hit)
    return result


class Suit:
    """The suit's rest vertices, weights and triangle owners; posed() blends it like the GPU."""

    def __init__(self, nodes):
        suit = bpy.data.objects['Suit']
        data = suit.data
        self.names = [g.name for g in suit.vertex_groups]
        self.bones = [nodes[name.replace('_', '.')] for name in self.names]
        self.weights = np.zeros((len(data.vertices), len(self.names)))
        for v in data.vertices:
            for g in v.groups:
                self.weights[v.index, g.group] = g.weight
        self.rest = np.array([(*(suit.matrix_world @ v.co), 1) for v in data.vertices])
        self.inverse = [bone.matrix_world.inverted() for bone in self.bones]
        data.calc_loop_triangles()
        self.triangles = np.array([tuple(t.vertices) for t in data.loop_triangles])
        self.owner = np.argmax(self.weights[self.triangles].sum(axis=1), axis=1)

    def posed(self):
        out = np.zeros((len(self.rest), 3))
        for b, bone in enumerate(self.bones):
            matrix = np.array(bone.matrix_world @ self.inverse[b])
            out += self.weights[:, b, None]*(self.rest @ matrix.T)[:, :3]
        return [Vector(p) for p in out]

    def region(self, node, points):
        name = node.name
        if name not in self.names:
            return None
        faces = [tuple(int(i) for i in t) for t in self.triangles[self.owner == self.names.index(name)]]
        return ('Suit:'+name, BVHTree.FromPolygons(points, faces, all_triangles=True), points, faces, True)


def rigid(obj):
    tree, vertices, faces = shell_tree(obj)
    return (obj.name, tree, vertices, faces, False)


report = []
combined = []
poses = 0
soft = '--soft' in sys.argv
for name, low in [(name, low) for name in (FORMS if soft else ['keel', 'morrow']) for low in [False, True]]:
    if '--only' in sys.argv and name != sys.argv[sys.argv.index('--only')+1]:
        continue
    if soft and '--cache' in sys.argv:
        bpy.ops.wm.open_mainfile(filepath=str(CACHE/f'{name}{"-lod" if low else ""}.blend'))
        nodes = {obj.name.replace('_', '.'): obj for obj in bpy.context.scene.objects if obj.type == 'EMPTY'}
    else:
        nodes = build_soft(name, low) if soft else build_robot(name, low)
    scale = (1.73/1.8 if name.endswith('-i') else 1) if soft else (1.65/1.8 if name == 'morrow' else 1)
    material = name.split('-')[0]+'Cover' if soft else 'obsidian'
    suit = Suit(nodes) if soft and bpy.data.objects.get('Suit') else None
    # Adjacent outer armour; spheres, drums and nested bearing collars are the
    # intended overlap inside the envelopes below, not an external collision.
    pairs = []
    for hinge, leaf, parent, axis, limits, radius in [
        ('spine.yaw', 'spine.roll', 'pelvis', 1, (-35, 35), .115),
        ('spine.pitch', 'spine.roll', 'pelvis', 0, (-20, 30), .115),
        ('spine.roll', 'spine.roll', 'pelvis', 2, (-20, 20), .115),
        ('head.yaw', 'head.pitch', 'spine.roll', 1, (-60, 60), .102),
        ('head.pitch', 'head.pitch', 'spine.roll', 0, (-35, 45), .102),
    ]:
        pairs.append((nodes[hinge], nodes[leaf], nodes[parent], axis, limits, radius))
    for side in ['left', 'right']:
        sign = -1 if side == 'left' else 1
        for hinge, leaf, parent, axis, limits, radius in [
            ('arm.roll', 'arm.yaw', 'spine.roll', 2, (-15*sign, 110*sign), .100),
            ('arm.pitch', 'arm.yaw', 'spine.roll', 0, (-80, 130 if name == 'morrow' else 140), .100),
            ('arm.yaw', 'arm.yaw', 'spine.roll', 1, (-70, 70), .100),
            ('leg.roll', 'leg.yaw', 'pelvis', 2, (-25*sign, 45*sign), .105),
            ('leg.pitch', 'leg.yaw', 'pelvis', 0, (-35, 100), .105),
            ('leg.yaw', 'leg.yaw', 'pelvis', 1, (-35, 35), .105),
        ]:
            pairs.append((nodes[side+'.'+hinge], nodes[side+'.'+leaf], nodes[parent], axis, limits, radius))
        for group, hinge, parent, axis, limits, radius in [
            ('arm', 'elbow', 'yaw', 0, (0, 130 if name == 'morrow' else 140), .070),
            ('arm', 'wrist.pitch', 'elbow', 0, (-45, 45), .055),
            ('arm', 'wrist.roll', 'elbow', 1, (-90, 90), .055),
            ('arm', 'wrist.yaw', 'elbow', 2, (-35, 35), .055),
            ('leg', 'knee', 'yaw', 0, (0, -130), .085),
            ('leg', 'ankle.pitch', 'knee', 0, (-35, 25), .064),
            ('leg', 'ankle.roll', 'knee', 2, (-20, 20), .064),
        ]:
            prefix = side+'.'+group+'.'
            moving = nodes[prefix+hinge]
            leaf = nodes[prefix+('wrist.yaw' if 'wrist' in hinge else 'ankle.roll' if 'ankle' in hinge else hinge)]
            stationary = nodes[prefix+parent]
            pairs.append((moving, leaf, stationary, axis, limits, radius))
    for moving, leaf, stationary, axis, limits, radius in pairs:
        for step in range(65):
            poses += 1
            angle = limits[0]+(limits[1]-limits[0])*step/64
            moving.rotation_euler[axis] = math.radians(angle)
            bpy.context.view_layer.update()
            centre = moving.matrix_world.translation
            # Exterior covers only: a soft form's cover-coloured lining is the under-suit, audited as before (not at all).
            children = [rigid(o) for o in leaf.children if o.type == 'MESH' and o.data.materials[0].name == material and 'under-suit' not in o.name]
            parents = [rigid(o) for o in stationary.children if o.type == 'MESH' and o.data.materials[0].name == material and 'under-suit' not in o.name]
            if suit:
                points = suit.posed()
                children += [r for r in [suit.region(leaf, points)] if r]
                parents += [r for r in [suit.region(stationary, points)] if r]
            for a_name, tree_a, va, fa, a_suit in children:
                for b_name, tree_b, vb, fb, b_suit in parents:
                    overlap = tree_a.overlap(tree_b)
                    exterior = []
                    for ia, ib in overlap:
                        if a_suit and b_suit and set(fa[ia]) & set(fb[ib]):
                            continue
                        crossings = intersections([va[i] for i in fa[ia]], [vb[i] for i in fb[ib]])
                        exterior += [(point-centre).length for point in crossings if (point-centre).length > radius*scale]
                    if exterior:
                        report.append({'robot': name, 'lod': int(low), 'joint': moving.name, 'angle': angle,
                                       'parts': [a_name, b_name], 'triangles': len(exterior), 'radius': max(exterior)})
        moving.rotation_euler[axis] = 0
    if '--combined' in sys.argv and suit:
        # Fixed, bounded visual poses supplement the independent sweep. Nonadjacent
        # forearm/hip pairs have no bearing exemption, including at true rest.
        postures = {
            'rest': {},
            'bend-reach': {'spine_pitch': -12, 'head_pitch': 20, 'left_arm_pitch': -35, 'right_arm_pitch': -35,
                           'left_arm_elbow': 60, 'right_arm_elbow': 60},
            'turn-reach': {'spine_yaw': 20, 'head_yaw': -20, 'left_arm_pitch': -25,
                           'right_arm_pitch': -25, 'left_arm_elbow': 40, 'right_arm_elbow': 40},
            'visual-stride-left': {'left_leg_pitch': -18, 'right_leg_pitch': 18,
                                   'left_leg_knee': -25, 'right_leg_knee': -5,
                                   'left_arm_pitch': 15, 'right_arm_pitch': -15},
            'visual-stride-right': {'left_leg_pitch': 18, 'right_leg_pitch': -18,
                                    'left_leg_knee': -5, 'right_leg_knee': -25,
                                    'left_arm_pitch': -15, 'right_arm_pitch': 15},
        }
        axes = {moving.name: axis for moving, _, _, axis, _, _ in pairs}
        for label, posture in postures.items():
            for node in nodes.values():
                node.rotation_euler = (0, 0, 0)
            for joint, degrees in posture.items():
                nodes[joint.replace('_', '.')].rotation_euler[axes[joint]] = math.radians(degrees)
            bpy.context.view_layer.update()
            points = suit.posed()
            checks = [(leaf, stationary, moving.matrix_world.translation, radius*scale)
                      for moving, leaf, stationary, _, _, radius in pairs]
            for side in ['left', 'right']:
                for target in ['pelvis', side+'.leg.yaw']:
                    checks.append((nodes[side+'.arm.elbow'], nodes[target], Vector(), 0))
                    checks.append((nodes[side+'.arm.wrist.yaw'], nodes[target], Vector(), 0))
            checks.append((nodes['head.pitch'], nodes['head.yaw'], nodes['head.pitch'].matrix_world.translation, .102*scale))
            for leaf, stationary, centre, radius in checks:
                def regions(node):
                    parts = [rigid(o) for o in node.children if o.type == 'MESH' and
                             o.data.materials[0].name in [material, 'softGlass', 'softGraphite'] and 'under-suit' not in o.name]
                    skin = suit.region(node, points)
                    return parts+([skin] if skin else [])
                for a in regions(leaf):
                    for b in regions(stationary):
                        hits = []
                        for ia, ib in a[1].overlap(b[1]):
                            if a[4] and b[4] and set(a[3][ia]) & set(b[3][ib]):
                                continue
                            hits += [p for p in intersections([a[2][i] for i in a[3][ia]], [b[2][i] for i in b[3][ib]])
                                     if (p-centre).length > radius]
                        vertices = set(i for face in a[3] for i in face)
                        distances = [b[1].find_nearest(a[2][i])[3] for i in vertices if b[1].find_nearest(a[2][i])[0] is not None]
                        combined.append({'robot': name, 'lod': int(low), 'pose': label,
                                         'parts': [a[0], b[0]], 'bearingM': radius,
                                         'crossingPoints': len(hits), 'sampledVertexDistanceM': min(distances) if distances else None,
                                         'crossingBounds': [[min(p[k] for p in hits), max(p[k] for p in hits)] for k in range(3)] if hits else None})
        for node in nodes.values():
            node.rotation_euler = (0, 0, 0)
result = {'poses': poses, 'scope': f'Adjacent exterior {"soft covers and skinned suit regions, blended at each pose" if soft else "obsidian shells"}, independent axes, 65 positions including limits, both LODs. Nested bearings and internal structure are intentional overlaps. Arbitrary simultaneous whole-body self-collision is outside this visual audit.', 'crossings': report}
if '--combined' in sys.argv:
    result['combined'] = combined
    result['combinedScope'] = 'Five authored visual postures; skinned and rigid exterior covers/glass/neck, unchanged adjacent bearings, no forearm or hand/hip bearing exclusion. Vertex distance is sampled surface distance, not a signed clearance or whole-body certificate.'
print(json.dumps(result, indent=2))
OUT.mkdir(parents=True, exist_ok=True)
(OUT/'clearance.json').write_text(json.dumps(result, indent=2))
print(f'Clearance evidence: {OUT}')
if report:
    raise RuntimeError(f'{len(report)} exterior shell crossing cases remain')
if any(row['crossingPoints'] for row in combined):
    raise RuntimeError('Combined or rest crossing cases remain; see retained measurements')
