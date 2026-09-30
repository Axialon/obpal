"""Authoring clearance audit. BVH intersections outside a joint's nested bearing
are reported, never silently counted as an acceptable overlap. Run headlessly.
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

OUT = Path(tempfile.mkdtemp(prefix='obpal-humanoid-clearance-'))


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


report = []
poses = 0
soft = '--soft' in sys.argv
for name, low in [(name, low) for name in (FORMS if soft else ['keel', 'morrow']) for low in [False, True]]:
    if '--only' in sys.argv and name != sys.argv[sys.argv.index('--only')+1]:
        continue
    if soft and '--cache' in sys.argv:
        bpy.ops.wm.open_mainfile(filepath=str(ROOT/'artifacts/humanoid-third/build/source'/f'{name}{"-lod" if low else ""}.blend'))
        nodes = {obj.name.replace('_', '.'): obj for obj in bpy.context.scene.objects if obj.type == 'EMPTY'}
    else:
        nodes = build_soft(name, low) if soft else build_robot(name, low)
    scale = (1.73/1.8 if name.endswith('-i') else 1) if soft else (1.65/1.8 if name == 'morrow' else 1)
    material = name.split('-')[0]+'Cover' if soft else 'obsidian'
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
            children = [o for o in leaf.children if o.type == 'MESH' and o.data.materials[0].name == material]
            parents = [o for o in stationary.children if o.type == 'MESH' and o.data.materials[0].name == material]
            for a in children:
                tree_a, va, fa = shell_tree(a)
                for b in parents:
                    tree_b, vb, fb = shell_tree(b)
                    overlap = tree_a.overlap(tree_b)
                    exterior = []
                    for ia, ib in overlap:
                        crossings = intersections([va[i] for i in fa[ia]], [vb[i] for i in fb[ib]])
                        exterior += [(point-centre).length for point in crossings if (point-centre).length > radius*scale]
                    if exterior:
                        report.append({'robot': name, 'lod': int(low), 'joint': moving.name, 'angle': angle,
                                       'parts': [a.name, b.name], 'triangles': len(exterior), 'radius': max(exterior)})
        moving.rotation_euler[axis] = 0
result = {'poses': poses, 'scope': f'Adjacent exterior {"soft covers" if soft else "obsidian shells"}, independent axes, 65 positions including limits, both LODs. Nested bearings and internal structure are intentional overlaps. Arbitrary simultaneous whole-body self-collision is outside this visual audit.', 'crossings': report}
print(json.dumps(result, indent=2))
OUT.mkdir(parents=True, exist_ok=True)
(OUT/'clearance.json').write_text(json.dumps(result, indent=2))
print(f'Clearance evidence: {OUT}')
if report:
    raise RuntimeError(f'{len(report)} exterior shell crossing cases remain')
