"""Keel and Morrow: original ob.Pal articulated shells, in metres with Y up.

Run with Blender's factory startup. Low LOD keeps the same pivots and silhouette;
it removes service details and reduces bearing tessellation, not joint frames.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *


def joint_tree(scale=1):
    """The reference map in src/sim/humanoid/profile.ts; contract tests compare every frame."""
    nodes = {}
    def add(name, parent, at):
        nodes[name] = pivot(name.replace('.', '_'), nodes.get(parent), tuple(v * scale for v in at))
    add('pelvis', None, (0, .92, 0))
    add('spine.yaw', 'pelvis', (0, .12, 0))
    add('spine.pitch', 'spine.yaw', (0, 0, 0))
    add('spine.roll', 'spine.pitch', (0, 0, 0))
    add('head.yaw', 'spine.roll', (0, .47, 0))
    add('head.pitch', 'head.yaw', (0, 0, 0))
    for side, sign in [('left', -1), ('right', 1)]:
        a, l = side + '.arm', side + '.leg'
        add(a + '.roll', 'spine.roll', (sign * .26, .36, 0))
        add(a + '.pitch', a + '.roll', (0, 0, 0))
        add(a + '.yaw', a + '.pitch', (0, 0, 0))
        add(a + '.elbow', a + '.yaw', (0, -.29, 0))
        add(a + '.wrist.roll', a + '.elbow', (0, -.26, 0))
        add(a + '.wrist.pitch', a + '.wrist.roll', (0, 0, 0))
        add(a + '.wrist.yaw', a + '.wrist.pitch', (0, 0, 0))
        add(l + '.roll', 'pelvis', (sign * .15, 0, 0))
        add(l + '.pitch', l + '.roll', (0, 0, 0))
        add(l + '.yaw', l + '.pitch', (0, 0, 0))
        add(l + '.knee', l + '.yaw', (0, -.43, 0))
        add(l + '.ankle.pitch', l + '.knee', (0, -.41, 0))
        add(l + '.ankle.roll', l + '.ankle.pitch', (0, 0, 0))
    return nodes


def prism(parent, points, depth, at=(0, 0, 0), material='gunmetal', edge=.003):
    """A bevelled XY silhouette extruded through Z, with a real planar chamfer."""
    count = len(points)
    vertices = [(x, y, z) for z in [-depth / 2, depth / 2] for x, y in points]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces += [(i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)]
    return hard_mesh('Armour', vertices, faces, parent, material, at, 'y', edge)


def bearing(parent, radius, width, low, at=(0, 0, 0)):
    # The exposed drum stops 10 mm inside the adjoining shell's side walls.
    drum = cylinder(parent, radius, width, at, 'darkTitanium', segments=12 if low else 24)
    drum.rotation_euler.z = math.pi / 2
    return drum


def build_robot(name, low=False, clear=True):
    if clear:
        reset()
    existing = set(bpy.context.scene.objects)
    morrow = name == 'morrow'
    scale = 1.65 / 1.8 if morrow else 1
    # Author in the reference size, then apply one uniform geometry scale. Joint
    # translations are scaled separately; runtime never scales a rotating pivot.
    nodes = joint_tree()
    if morrow:
        for side, sign in [('left', -1), ('right', 1)]:
            nodes[side + '.arm.roll'].location.x = sign * .21 / scale
            nodes[side + '.leg.roll'].location.x = sign * .18 / scale
    seg = 12 if low else 28
    torso = nodes['spine.roll']
    pelvis = nodes['pelvis']
    plate(pelvis, (.32 if not morrow else .39, .14, .20), (0, 0, 0), 'carbon', taper=.25, edge=.004)
    plate(pelvis, (.27, .055, .025), (0, -.016, -.107), 'gunmetal', taper=.4)
    cylinder(nodes['spine.yaw'], .063, .095, (0, .015, 0), 'darkTitanium', segments=seg)
    cylinder(nodes['head.yaw'], .036, .14, (0, .005, 0), 'darkTitanium', segments=seg)
    for s in [-1, 1]:
        plate(torso, (.035, .22, .035), (s * .075, .22, .075), 'gunmetal', taper=.12)
    if morrow:
        # An open oval in place of a breastplate, with three offset smoked ribs.
        thorax = ring(torso, .158, .026, (0, .23, 0), 'gunmetal', segments=seg)
        thorax.scale = (1.10, 1.32, 1.5)
        for y, x in [(.12, -.014), (.23, .014), (.34, -.014)]:
            rib = plate(torso, (.22, .042, .038), (x, y, -.04), 'optic', taper=.28, edge=.004)
            rib.rotation_euler.z = -.18
        plate(torso, (.025, .20, .036), (.02, .23, .015), 'lime', taper=.3)
        ring(nodes['head.yaw'], .095, .016, (0, .008, 0), 'gunmetal', axis='y', segments=seg)
        prism(nodes['head.pitch'], [(-.067, .043), (-.1, .105), (-.067, .17), (.067, .17), (.1, .105), (.067, .043)], .15, material='carbon')
        plate(nodes['head.pitch'], (.15, .033, .018), (0, .115, -.079), 'optic', edge=.001)
        plate(nodes['head.pitch'], (.032, .009, .019), (.037, .115, -.085), 'lime', edge=.0005)
    else:
        # Paired shield rails leave a through-void below the floating sternum.
        for s in [-1, 1]:
            points = [(s*x, y) for x, y in [(.028, .03), (.15, .11), (.222, .34), (.157, .404), (.059, .355)]]
            if s < 0:
                points.reverse()
            prism(torso, points, .15, material='gunmetal', edge=.005)
        plate(torso, (.09, .20, .03), (0, .267, -.086), 'optic', taper=.2, edge=.003)
        filament = plate(torso, (.009, .251, .018), (-.103, .23, -.088), 'lime', edge=.0005)
        filament.rotation_euler.z = -.34
        prism(nodes['head.pitch'], [(-.078, .045), (-.105, .17), (-.06, .205), (.068, .205), (.105, .17), (.06, .045)], .18, material='carbon', edge=.004)
        plate(nodes['head.pitch'], (.172, .046, .027), (0, .137, -.092), 'optic', taper=.08, edge=.002)
        plate(nodes['head.pitch'], (.095, .007, .014), (-.025, .127, -.112), 'lime', edge=.0005)
    for side, s in [('left', -1), ('right', 1)]:
        a, l = side + '.arm', side + '.leg'
        shoulder = nodes[a + '.yaw']
        bearing(shoulder, .062, .115, low)
        if not low:
            cuff = sector(shoulder, .077, .092, (0, 0, 0), -.5, 3.5, 'gunmetal', segments=12)
            cuff.rotation_euler.z = math.pi / 2
        # The cuff is open around the bearing; there is no spherical shoulder cap.
        plate(shoulder, (.092, .176, .117), (0, -.147, 0), 'carbon', taper=.16, edge=.004)
        elbow = nodes[a + '.elbow']
        bearing(elbow, .052, .115, low)
        if morrow:
            for sign in [-1, 1]:
                prism(elbow, [(sign*x, y) for x, y in [(.024, -.053), (.07, -.095), (.066, -.17), (.026, -.223), (.045, -.141)]][::sign], .12, material='gunmetal', edge=.002)
        else:
            plate(elbow, (.121, .171, .135), (0, -.146, -.014), 'gunmetal', taper=.23, edge=.004)
        if not low:
            plate(elbow, (.05, .075, .012), (0, -.142, -.09), 'gunmetal', taper=.2)
        wrist = nodes[a + '.wrist.yaw']
        cylinder(wrist, .027, .055, (0, .014, 0), 'carbon', segments=seg)
        plate(wrist, (.10, .080, .076), (0, -.043, 0), 'carbon', taper=.1, edge=.003)
        # Three long fingers versus four shorter fingers, in two collective curl
        # frames per hand. They do not claim five independent human digits.
        first = pivot((a + '.fingers').replace('.', '_'), wrist, (0, -.08, -.022))
        second = pivot((a + '.tips').replace('.', '_'), first, (0, -.035, 0))
        count = 4 if morrow else 3
        width = .021 if morrow else .027
        for n in range(count):
            x = (n - (count-1)/2) * (width + .004)
            plate(first, (width, .027, .027), (x, -.014, 0), 'gunmetal', edge=.001)
            plate(second, (width * .9, .033, .025), (x, -.016, -.002), 'gunmetal', taper=.22, edge=.001)
        thigh = nodes[l + '.yaw']
        bearing(thigh, .067, .135, low)
        plate(thigh, (.13, .272, .145), (0, -.223, 0), 'carbon', taper=.22, edge=.004)
        knee = nodes[l + '.knee']
        bearing(knee, .068, .145, low)
        if morrow:
            for sign in [-1, 1]:
                points = [(sign*x, y) for x, y in [(.017, -.065), (.071, -.097), (.096, -.221), (.054, -.34), (.028, -.346), (.060, -.209)]]
                if sign < 0:
                    points.reverse()
                prism(knee, points, .10, material='gunmetal', edge=.003)
        else:
            plate(knee, (.132, .268, .139), (0, -.223, .015), 'gunmetal', taper=.35, edge=.004)
            plate(knee, (.125, .085, .045), (0, -.044, -.057), 'gunmetal', taper=.35, edge=.003)
        foot = nodes[l + '.ankle.roll']
        cylinder(foot, .027, .082, (0, .018, 0), 'carbon', segments=seg)
        # An 8 mm slot divides the two soles. Lowest face is the reference ground.
        for sign in [-1, 1]:
            plate(foot, (.080, .062, .27), (sign*.044, -.047, -.046), 'carbon', taper=.08, edge=.004)
        if not low:
            cylinder(foot, .016, .065, (0, -.004, .07), 'carbon', segments=seg)
    if scale != 1:
        for obj in set(bpy.context.scene.objects) - existing:
            obj.location *= scale
            if obj.type == 'MESH':
                for vert in obj.data.vertices:
                    vert.co *= scale
    return nodes


if __name__ == '__main__':
    for name in ['keel', 'morrow']:
        for low in [False, True]:
            build_robot(name, low)
            export(name + ('-lod' if low else ''))
