"""Keel and Morrow: original ob.Pal articulated shells, in metres with Y up.

Run with Blender's factory startup. Both LODs keep the same machined sockets and
named pivots; the distant mesh simplifies other parts around that fixed envelope.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from humanoid_surfaces import finishes, loft, ball, oval_band, rounded_normals, anatomy, sheath
from humanoid_clearance import machine_openings


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


def axle(parent, radius, width, low, at=(0, 0, 0)):
    segments = (6 if low else 8) if radius < .02 else (12 if low else 24)
    drum = cylinder(parent, radius, width, at, 'graphite', segments=segments)
    drum.rotation_euler.z = math.pi / 2
    return drum


def seam(parent, size, at, low=False, material='graphite'):
    """A recessed panel over a dark seam bed, with a fine light-catching bevel."""
    w, h, d = size
    plate(parent, (w, h, d), at, material, edge=.0007)
    x, y, z = at
    if not low:
        plate(parent, (w-.005, h-.005, d*.5), (x, y, z-.0015), 'obsidian', edge=.0008)


def hand(wrist, name, morrow, low):
    """A palm, a separate opposable thumb and three phalanges per collective digit.

    The original two control frames remain; the distal frame adds the third
    knuckle. All hands have a visible web and separated tips at neutral.
    """
    ball(wrist, .037, low=low, material='elastomer', scale=(1, 1.2, .9))
    anatomy(wrist, [(.005, .031, .027, 0), (-.027, .052, .034, -.001),
                   (-.071, .053, .029, -.004), (-.087, .045, .023, -.010)], low=low)
    sign = -1 if name.startswith('left') else 1
    ball(wrist, .026, (sign*.038, -.051, -.004), low, 'obsidian', (1, 1.3, .8))
    first = pivot(name+'_fingers', wrist, (0, -.08, -.022))
    second = pivot(name+'_tips', first, (0, -.035, 0))
    third = pivot(name+'_distal', second, (0, -.029, 0))
    count = 4 if morrow else 3
    width = .021 if morrow else .027
    for n in range(count):
        x = (n-(count-1)/2)*(width+.006)
        for frame, length, w in [(first, .035, width), (second, .029, width*.94), (third, .029, width*.84)]:
            ball(frame, .013, (x, 0, 0), low, 'elastomer', (w/.026, 1, .9))
            anatomy(frame, [(.004, w*.45, .012, 0), (-length*.35, w*.51, .014, -.001),
                            (-length, w*.40, .011, -.002)], 'elastomer', low, (x, 0, 0))
        ball(wrist, .014, (x, -.077, -.025), low, 'obsidian', (1, .85, .8))
    thumb = pivot(name+'_thumb', wrist, (sign*.050, -.040, .005))
    thumb.rotation_euler.z = sign*.55
    anatomy(thumb, [(0, .017, .017, 0), (-.025, .017, .015, -.001), (-.050, .013, .013, -.003)], 'elastomer', low)
    thumb_tip = pivot(name+'_thumb_tip', thumb, (0, -.05, -.003))
    anatomy(thumb_tip, [(.006, .014, .013, 0), (-.015, .014, .013, -.003), (-.032, .010, .009, -.005)], 'elastomer', low)
    for x in [-.017, .017]:
        sheath(wrist, [(x, .018, .020), (x, -.006, .031), (x, -.034, .032)], .002)


def build_robot(name, low=False, clear=True):
    distant = low
    # Both LODs start from the same machined shell. Re-authoring the Boolean cuts
    # with coarse cutters can bridge a concavity that the hero cleared correctly.
    low = False
    if clear:
        reset()
    finishes()
    existing = set(bpy.context.scene.objects)
    morrow = name == 'morrow'
    scale = 1.65/1.8 if morrow else 1
    nodes = joint_tree()
    if morrow:
        for side, sign in [('left', -1), ('right', 1)]:
            nodes[side+'.arm.roll'].location.x = sign*.21/scale
            nodes[side+'.leg.roll'].location.x = sign*.18/scale
    seg = 12 if low else 28
    torso, pelvis = nodes['spine.roll'], nodes['pelvis']

    # The hip bridge rises into the abdominal ball. Nested lamellae replace the
    # old rod: broad lower plates overlap a continuous dark core through bending.
    anatomy(pelvis, [(-.077, .071 if not morrow else .097, .067, .008),
                    (-.018, .169 if not morrow else .190, .089, .006),
                    (.044, .182 if not morrow else .207, .100, 0),
                    (.096, .126 if not morrow else .159, .077, 0)], low=low)
    ball(torso, .104, low=low, material='elastomer', scale=(1, 1.15, 1))
    # A quiet soft core and abdominal plates replace the exposed bearing rings.
    anatomy(torso, [(-.095, .096, .081, .006), (-.025, .105, .086, .003),
                    (.052, .111, .088, 0), (.119, .123, .096, -.002)], 'elastomer', low)
    for y, width in [(-.015, .125), (.041, .145), (.092, .174)]:
        plate(torso, (width, .043, .019), (0, y, -.092), 'obsidian', taper=.15, edge=.004)
    for x in [-.058, .058]:
        sheath(torso, [(x, -.05, .080), (x*.85, .03, .087), (x, .12, .079)], .003, 'elastomer')
    seam(pelvis, (.16 if not morrow else .20, .051, .008), (0, .018, -.080), low)

    # A continuous spine sweeps behind the thorax. Its depth is intentional in
    # side silhouette; front and rear plates never share the same flat outline.
    loft(torso, [(.065, .045, .034, .067), (.18, .057, .038, .099),
                 (.33, .078, .034, .104), (.415, .073, .033, .078)], 'graphite', low)
    for y in [.15, .22, .29, .36]:
        plate(torso, (.113, .045, .025), (0, y, .135), 'obsidian', taper=.28, edge=.003)

    if morrow:
        # A swept dorsal crescent gives Morrow a separate side silhouette as well
        # as its open front. Its narrow centre web clears both shoulder sweeps.
        back = prism(torso, [(.09, .10), (.14, .12), (.225, .245), (.194, .345),
                             (.110, .432), (.129, .345), (.172, .250)], .040,
                     material='obsidian', edge=.004)
        for vertex in back.data.vertices:
            x, y, z = vertex.co
            vertex.co = (-z, y, x)
        rounded_normals(back)
        # An open, offset double ellipse is Morrow's defining negative space.
        # The forward glass ribs float on the structural rim, not across the gap.
        oval_band(torso, .151, .171, -.016, .035, low=low, at_y=.279, depth=1.85)
        oval_band(torso, .117, .163, .031, .014, 'graphite', low, at_y=.27, depth=1.8)
        for y, sign in [(.185, -1), (.286, 1), (.376, -1)]:
            rib = anatomy(torso, [(-.019, .061, .018, 0), (0, .116, .037, -.017), (.019, .071, .020, 0)],
                          'smokedGlass', low, (sign*.010, y, -.069))
            rib.rotation_euler.z = sign*.19
        loft(torso, [(.14, .018, .019, .012), (.35, .025, .025, .012)], 'lime', low, .002)
        # Compact shoulder girdle nests behind the oval and under each cap.
        plate(torso, (.422, .071, .095), (0, .367, .035), 'graphite', taper=.15, edge=.006)
        for sign in [-1, 1]:
            anatomy(torso, [(.150, .039, .073, .010), (.249, .051, .086, -.006),
                            (.351, .050, .088, -.011), (.407, .036, .059, .006)], low=low, at=(sign*.130, 0, 0))
    else:
        # Two deep, swept shield leaves: an actual vertical void separates their
        # inner edges, with a small smoked sternum bridge above the opening.
        for sign in [-1, 1]:
            points = [(sign*x, y) for x, y in [(.021, .116), (.090, .135), (.185, .330),
                       (.198, .397), (.145, .444), (.032, .365)]]
            if sign < 0:
                points.reverse()
            shell = prism(torso, points, .15, (0, 0, -.036), 'obsidian', .009 if not low else .006)
            shell['shieldSide'] = sign
            # Pectoral camber gives the shield actual chest depth, preserving its
            # central void and crisp perimeter instead of flattening the ribcage.
            for vertex in shell.data.vertices:
                vertex.co.z -= .032*math.exp(-((vertex.co.y-.343)/.105)**2)
            rounded_normals(shell)
            anatomy(torso, [(.144, .046, .067, .019), (.233, .077, .108, .010),
                            (.335, .086, .121, -.007), (.408, .068, .093, .011)], low=low, at=(sign*.108, 0, 0))
            # Layered upper panels leave a two-millimetre recessed seam border.
            panel = plate(torso, (.100, .062, .017), (sign*.124, .377, -.119), 'graphite', taper=.18, edge=.002)
            panel.rotation_euler.z = -sign*.32
            if not low:
                inset = plate(torso, (.093, .055, .015), (sign*.124, .377, -.122), 'obsidian', taper=.18, edge=.002)
                inset.rotation_euler.z = -sign*.32
        plate(torso, (.087, .096, .037), (0, .336, -.120), 'smokedGlass', taper=.2, edge=.004)
        plate(torso, (.009, .073, .006), (-.025, .337, -.142), 'lime', edge=.0007)
        plate(torso, (.422, .058, .091), (0, .371, .036), 'graphite', taper=.18, edge=.004)

    # Neck column, ball and collar overlap; the head grows from inside the collar.
    # The upper head reaches the specified nominal 1.80/1.65 m standing height.
    neck = nodes['head.yaw']
    cylinder(neck, .050, .139, (0, -.008, .012), 'graphite', segments=seg)
    ball(nodes['head.pitch'], .068, (0, .036, .009), low, 'elastomer', (1, 1.25, 1))
    anatomy(torso, [(.396, .105, .071, .013), (.448, .072, .063, .014),
                   (.493, .069, .061, .012)], 'elastomer', low)
    collar = ring(nodes['head.pitch'], .082, .012, (0, .049, .006), 'obsidian', axis='y', segments=seg)
    collar.scale.y = 1.2
    collar['clearanceProtected'] = True
    # Rear collar sweeps upward like a hood, while the chin stays free to pitch.
    plate(torso, (.182, .058, .021), (0, .429, .108), 'obsidian', taper=.12, edge=.005)
    head = nodes['head.pitch']
    head_shell = loft(head, [(.066, .061, .058, -.007), (.105, .078, .067, -.011), (.151, .093, .079, -.003),
                           (.216, .117 if morrow else .110, .094, .001),
                           (.290, .079, .072, .018)], low=low, edge=.009)
    head_shell['clearanceProtected'] = True
    brow = plate(head, (.199 if not morrow else .210, .061, .035), (0, .211, -.120 if not morrow else -.107), 'smokedGlass', taper=.12, edge=.004)
    brow.rotation_euler.x = -.13
    plate(head, (.078 if morrow else .128, .005, .008), (0, .205, -.140 if not morrow else -.126), 'lime', edge=.0008)
    plate(head, (.091, .029, .012), (0, .104, -.077), 'obsidian', taper=.2, edge=.002)

    for side, sign in [('left', -1), ('right', 1)]:
        a, l = side+'.arm', side+'.leg'
        shoulder = nodes[a+'.yaw']
        # Full spheres provide uninterrupted structure while the rigid sleeves
        # move around them. Shoulder shells grow from a 90 mm bearing envelope.
        ball(shoulder, .088 if not morrow else .081, low=low, material='elastomer')
        anatomy(shoulder, [(.055, .058, .062, .003), (.006, .102 if not morrow else .090, .091, 0),
                          (-.068, .094 if not morrow else .084, .084, -.002), (-.144, .068, .061, .003),
                          (-.221, .048, .042, .009), (-.273, .043, .036, .010)], low=low)
        # A closed soft tendon core bridges the machined folding clearance.
        core = cylinder(shoulder, .029, .235, (0, -.153, .006), 'elastomer', segments=12)
        core['clearanceProtected'] = True
        # A slim panel follows the upper-arm taper rather than a uniform tube.
        seam(shoulder, (.053, .071, .006), (0, -.145, -.057), low, 'elastomer')
        elbow = nodes[a+'.elbow']
        ball(elbow, .057, low=low, material='elastomer', scale=(1, 1.18, .9))
        anatomy(elbow, [(.020, .040, .031, .005), (-.008, .051, .039, .007), (-.067, .071 if not morrow else .067, .053, .012),
                       (-.128, .062, .052, .019), (-.202, .044, .036, .012),
                       (-.244, .032, .028, .006)], low=low)
        anatomy(elbow, [(-.038, .039, .028, .045), (-.098, .047, .031, .047),
                       (-.186, .034, .023, .035), (-.226, .025, .017, .016)], 'elastomer', low)
        if morrow:
            for s in [-1, 1]:
                points = [(s*x, y) for x, y in [(.042, -.058), (.079, -.089), (.067, -.16), (.039, -.208), (.055, -.127)]]
                if s < 0:
                    points.reverse()
                prism(elbow, points, .068, (0, 0, .020), 'obsidian', .003)
        for x in [-.019, .019]:
            sheath(elbow, [(x, -.16, .055), (x, -.22, .043), (x, -.256, .025)], .0027, 'elastomer')
        hand(nodes[a+'.wrist.yaw'], a.replace('.', '_'), morrow, low)

        thigh = nodes[l+'.yaw']
        ball(thigh, .088, low=low, material='elastomer', scale=(1, 1.1, 1))
        anatomy(thigh, [(.066, .042, .042, .008), (.016, .078, .076, .005), (-.006, .085, .082, .004), (-.079, .098, .100, -.011),
                       (-.185, .096, .092, -.015), (-.291, .068, .059, -.006),
                       (-.395, .051, .043, -.002)], low=low)
        core = cylinder(thigh, .034, .440, (0, -.230, 0), 'elastomer', segments=12)
        core['clearanceProtected'] = True
        anatomy(thigh, [(-.042, .056, .031, .065), (-.119, .071, .033, .085),
                       (-.259, .047, .029, .051), (-.340, .035, .018, .031)], 'elastomer', low)
        knee = nodes[l+'.knee']
        ball(knee, .075, low=low, material='elastomer', scale=(1, 1.08, .88))
        # A low-profile upper cuff clears the thigh during the full knee fold.
        anatomy(knee, [(.030, .047, .034, -.006), (-.012, .057, .042, -.010), (-.107, .072, .074, -.004),
                      (-.204, .067, .073, .005), (-.315, .041, .044, .007),
                      (-.381, .034, .031, .001)], low=low)
        if morrow:
            for s in [-1, 1]:
                points = [(s*x, y) for x, y in [(.039, -.063), (.086, -.101), (.108, -.214), (.054, -.341), (.035, -.35), (.066, -.205)]]
                if s < 0:
                    points.reverse()
                prism(knee, points, .070, (0, 0, -.035), 'obsidian', .004)
        plate(knee, (.12, .105, .034), (0, -.047, -.052), 'obsidian', taper=.3, edge=.005)
        foot = nodes[l+'.ankle.roll']
        ball(foot, .051, low=low, material='elastomer', scale=(1, 1.2, 1))
        for x in [-.031, .031]:
            sheath(foot, [(x, .034, .029), (x, .007, .043), (x, -.025, .054)], .003, 'elastomer')
        # Split sloped soles form a toe, instep and heel instead of two blocks.
        # The ankle shroud swallows the bottom of the shin at neutral.
        loft(foot, [(.021, .038, .039, 0), (-.025, .065, .071, -.020),
                    (-.052, .071, .078, -.026)], low=low, edge=.004)
        for s in [-1, 1]:
            sole = prism(foot, [(-.130, -.077), (.118, -.077), (.134, -.062),
                                (.101, -.023), (.008, -.014), (-.120, -.030)], .074,
                         (s*.042, 0, 0), 'obsidian', .004)
            # Local XY polygon above describes the Z/Y side profile of a shoe.
            for vertex in sole.data.vertices:
                x, y, z = vertex.co
                vertex.co = (z, y, -x-.047)
            rounded_normals(sole)
        for s in [-1, 1]:
            cylinder(foot, .012, .062, (s*.037, -.007, .054), 'elastomer', segments=seg)
        if not low:
            for z in [-.095, -.133]:
                plate(foot, (.141, .006, .005), (0, -.044, z), 'elastomer', edge=.0005)

    machine_openings(nodes, morrow, low)
    if not morrow:
        # Keel's two shield leaves are a manufactured mirror pair. Reuse the
        # cleared right-hand tool result so mirrored Boolean triangulation cannot
        # leave a different socket lip on the left.
        right = next(obj for obj in torso.children if obj.get('shieldSide') == 1)
        left = next(obj for obj in torso.children if obj.get('shieldSide') == -1)
        left.data = right.data.copy()
        for vertex in left.data.vertices:
            vertex.co.x *= -1
        bm = bmesh.new()
        bm.from_mesh(left.data)
        bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
        bm.to_mesh(left.data)
        bm.free()
        left['machined'] = True
    if scale != 1:
        for obj in set(bpy.context.scene.objects)-existing:
            obj.location *= scale
            if obj.type == 'MESH':
                for vertex in obj.data.vertices:
                    vertex.co *= scale
    parts = [obj for obj in set(bpy.context.scene.objects)-existing if obj.type == 'MESH']
    def triangles(obj):
        obj.data.calc_loop_triangles()
        return len(obj.data.loop_triangles)
    def protected(obj):
        return obj.get('machined') or obj.get('clearanceProtected')
    fixed = sum(triangles(obj) for obj in parts if protected(obj))
    flexible = sum(triangles(obj) for obj in parts if not protected(obj))
    ratio = max(.02, min(1, ((8800 if distant else 23500)-fixed)/max(1, flexible)))
    for obj in parts:
        if protected(obj) or len(obj.data.polygons) <= 3 or ratio >= 1:
            continue
        mod = obj.modifiers.new('Distant shell simplification' if distant else 'Hero tessellation budget', 'DECIMATE')
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        apply(obj)
    for obj in set(bpy.context.scene.objects)-existing:
        if obj.type != 'MESH' or not obj.get('machined'):
            continue
        # Swept booleans can leave sub-quantisation slivers. Collapse them before
        # export, not after a decoder has already flipped their tiny triangles.
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=.00003)
        bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=.00003)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.normals_split_custom_set([(0, 0, 0)]*len(obj.data.loops))
        # Curved anatomical armour keeps smooth outer reflections. Sharp socket
        # edges split the normals; manufactured shield facets stay planar.
        smooth = bool(obj.get('anatomical'))
        if smooth:
            obj.data.set_sharp_from_angle(angle=math.radians(35))
        for polygon in obj.data.polygons:
            polygon.use_smooth = smooth
    return nodes


if __name__ == '__main__':
    for name in ['keel', 'morrow']:
        for low in [False, True]:
            build_robot(name, low)
            export(name+('-lod' if low else ''), repair_normals=True, position_bits=24)
