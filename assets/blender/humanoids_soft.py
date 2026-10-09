"""Cairn, Rill and Hush: original soft covers over a dark under-suit, in two body forms.

Metres, Y up, front -z. Both LODs keep every named joint and three-phalange
tendon frame of the live profile; Keel and Morrow are built elsewhere.

v2 (H2a) replaces the sampled swept Boolean cuts with designed joints. Each
cover ends in a rolled lip short of its joint, over a closed elastomer under-suit
and gaskets that read as the concepts' dark seams. Elbows and knees fold against
a fixed bisector plane; any remaining overlap at the audited poses is relieved by
moving cover vertices smoothly out of the moving cover, at the same 65 samples per
axis the clearance audit uses. Section data and landmark targets live in
humanoid_forms.py and humanoid-forms.json.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from humanoids import joint_tree
from humanoid_surfaces import anatomy2
from humanoid_forms import S, SPEC, PIVOTS, TORSO, PELVIS, UPPER_ARM, FOREARM, THIGH, SHIN, SHOE, SOLE
import humanoid_skin
from mathutils import Matrix
from mathutils.bvhtree import BVHTree

NAMES = ['cairn', 'rill', 'hush']
FORMS = [f'{name}-{form}' for name in NAMES for form in ['i', 'ii']]
# Linear colour, metalness, roughness; soft-materials.ts carries the same values.
FINISHES = {
    'cairnCover': ((.213, .168, .146), .02, .86),
    'rillCover': ((.054, .052, .056), .01, .94),
    'hushCover': ((.024, .023, .024), .01, .94),
    'rillPanel': ((.020, .021, .024), .02, .92),
    'rillHelmet': ((.09, .087, .09), .05, .55),
    'softCore': ((.012, .017, .018), .02, .92),
    'softGraphite': ((.026, .030, .032), .50, .54),
    'softGlass': ((.010, .021, .024), .18, .30),
    'softSignal': ((.56, 1, .035), 0, .65),
    'softAccent': ((.56, 1, .035), 0, .65),
    # The v3 knit suits: white bases tinted by the suit's vertex colours.
    'cairnSuit': ((1, 1, 1), .02, .86),
    'rillSuit': ((1, 1, 1), .01, .94),
    'hushSuit': ((1, 1, 1), .01, .94),
}
# v3: one skinned knit suit replaces the rigid trunk and limb covers; --rigid builds H2a.
SKINNED = '--rigid' not in sys.argv
# Samples per audited axis, as in audit_humanoids.py: the covers are cleared at
# exactly the poses the independent audit then checks.
SAMPLES = 65


def soft_finishes():
    for name, (colour, metal, rough) in FINISHES.items():
        material = bpy.data.materials.new(name)
        MATERIALS[name] = material
        material.diffuse_color = (*colour, 1)
        material.use_nodes = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value = (*colour, 1)
        shader.inputs['Metallic'].default_value = metal
        shader.inputs['Roughness'].default_value = rough
        shader.inputs['Coat Weight'].default_value = 0
        if name.endswith(('Cover', 'Suit')):
            shader.inputs['Sheen Weight'].default_value = .06 if name.startswith('cairn') else .18
            shader.inputs['Sheen Roughness'].default_value = .85
            shader.inputs['Sheen Tint'].default_value = (*FINISHES[name.replace('Suit', 'Cover')][0], 1)
        if name in ['softSignal', 'softAccent']:
            shader.inputs['Emission Color'].default_value = (*colour, 1)
            shader.inputs['Emission Strength'].default_value = 1.6


def closed(obj):
    """Weld, orient outward and mark the part as a protected, closed surface."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def ellipsoid(parent, centre, radii, material, low, name='Elastomer gasket', segments=None):
    count = segments or (10 if low else 12)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=count, ring_count=max(6, count*2//3), radius=1)
    obj = bpy.context.object
    obj.name = name
    finish(obj, parent, material, centre)
    for vertex in obj.data.vertices:
        vertex.co.x *= radii[0]
        vertex.co.y *= radii[1]
        vertex.co.z *= radii[2]
    return closed(obj)


def loft(parent, sections, material, low, hero, lod, caps=(0, 0), sign=1, per=(2, 1), **kwargs):
    if low:
        # The distant level keeps every section and silhouette with fewer facets.
        lod = max(6, round(lod*.85/2)*2)
        kwargs['steps'] = min(kwargs.get('steps') or 3, 2)
    obj = anatomy2(parent, sections, material, count=lod if low else hero, per=per[1] if low else per[0],
                   caps=caps, sign=sign, **kwargs)
    return closed(obj)


def face_z(x, y, surface, lift=0):
    cy, cz, rx, ry, rz = surface
    return cz-rz*math.sqrt(max(.01, 1-(x/rx)**2-((y-cy)/ry)**2))-lift


def patch(head, cx, cy, w, h, material, low, surface, power=1, lift=.001):
    """A continuous curved superellipse lying on the face glass ellipsoid."""
    count, rings = (12, 2) if low else (20, 4)
    vertices = [(cx, cy, face_z(cx, cy, surface, lift))]
    for r in range(1, rings+1):
        for i in range(count):
            angle = math.tau*i/count
            x, y = math.cos(angle), math.sin(angle)
            x = cx+w*math.copysign(abs(x)**power, x)*r/rings
            y = cy+h*math.copysign(abs(y)**power, y)*r/rings
            vertices.append((x, y, face_z(x, y, surface, lift)))
    faces = [(0, 1+(i+1) % count, 1+i) for i in range(count)]
    for r in range(rings-1):
        for i in range(count):
            a, b = 1+r*count+i, 1+r*count+(i+1) % count
            faces.append((a, a+count, b+count, b))
    obj = mesh('Face signature', vertices, faces, head, material)
    return obj


def shell(head, sections, material, low):
    """The head's cover: an inverted egg, widest at the crown and tapering to the chin."""
    return loft(head, sections, material, low, 32, 18, caps=(.008, .028), per=(2, 1), name='Head shell')


HEAD = [S(.064, .030, .028, .030, cz=-.034), S(.082, .050, .046, .052, cz=-.026),
        S(.112, .066, .068, .070, cz=-.014), S(.150, .076, .086, .086, cz=-.004),
        S(.192, .080, .090, .094, cz=.002), S(.232, .078, .084, .092, cz=.004),
        S(.262, .066, .072, .076, cz=.006)]


def ellipsoid_hit(origin, direction, surface):
    """Where a ray from inside the head meets the face-glass ellipsoid."""
    cy, cz, rx, ry, rz = surface
    o = Vector(((origin.x)/rx, (origin.y-cy)/ry, (origin.z-cz)/rz))
    d = Vector((direction.x/rx, direction.y/ry, direction.z/rz))
    a, b, c = d.dot(d), 2*o.dot(d), o.dot(o)-1
    t = (-b+math.sqrt(max(0, b*b-4*a*c)))/(2*a)
    return origin+direction*t


def tube(parent, points, radius, material, low, name):
    """A closed rolled lip following a closed loop of (point, outward normal)."""
    count, sides = len(points), 6 if low else 8
    vertices, faces = [], []
    for i, (point, normal) in enumerate(points):
        tangent = (points[(i+1) % count][0]-points[i-1][0]).normalized()
        side = normal.cross(tangent).normalized()
        up = tangent.cross(side).normalized()
        for j in range(sides):
            a = math.tau*j/sides
            vertices.append(tuple(point+normal*radius*.35+radius*(up*math.cos(a)+side*math.sin(a))))
    for i in range(count):
        for j in range(sides):
            a, b = i*sides+j, i*sides+(j+1) % sides
            c, d = ((i+1) % count)*sides+(j+1) % sides, ((i+1) % count)*sides+j
            faces.append((a, b, c, d))
    return closed(mesh(name, vertices, faces, parent, material))


def cut(shell_obj, cutter_vertices, cutter_faces):
    """One clean Boolean with a smooth, dense designed cutter; never sampled copies."""
    cutter = mesh('Designed window cutter', cutter_vertices, cutter_faces, shell_obj.parent, 'softCore')
    closed(cutter)
    mod = shell_obj.modifiers.new('Designed window', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    apply(shell_obj)
    bpy.data.objects.remove(cutter, do_unlink=True)
    for polygon in shell_obj.data.polygons:
        polygon.use_smooth = True
    shell_obj.data.set_sharp_from_angle(angle=math.radians(40))


def front_window(head, shell_obj, outline, surface, rim, material, low, lift=0):
    """Cut a face window through the front of a head, fill it with a glass lens on
    the face ellipsoid and roll a lip around its edge (front -z)."""
    bpy.context.view_layer.update()
    tree = BVHTree.FromPolygons([v.co.copy() for v in shell_obj.data.vertices], [tuple(p.vertices) for p in shell_obj.data.polygons])
    edge = []
    for x, y in outline:
        hit, normal, _, _ = tree.ray_cast(Vector((x, y, -.5)), Vector((0, 0, 1)))
        edge.append((hit, normal))
    n = len(outline)
    vertices = [(x, y, -.3) for x, y in outline]+[(x, y, -.012) for x, y in outline]
    faces = [tuple(range(n)), tuple(range(2*n-1, n-1, -1))]+[(i, (i+1) % n, n+(i+1) % n, n+i) for i in range(n)]
    cut(shell_obj, vertices, faces)
    # Lens: front on the face ellipsoid, 3 mm deep, reaching under the rim.
    cx = sum(x for x, _ in outline)/n
    cy = sum(y for _, y in outline)/n
    rings = 3 if low else 6
    front, back = [], []
    grown = [(cx+(x-cx)*1.06, cy+(y-cy)*1.06) for x, y in outline]
    for r in range(1, rings+1):
        f = r/rings
        for x, y in grown:
            px, py = cx+(x-cx)*f, cy+(y-cy)*f
            front.append((px, py, face_z(px, py, surface, lift)))
    centre = (cx, cy, face_z(cx, cy, surface, lift))
    vertices = [centre]+front+[(x, y, z+.003) for x, y, z in [centre]+front]
    half = len(front)+1
    faces = []
    for base, flip in [(0, False), (half, True)]:
        ring = [(base+1+i, base+1+(i+1) % n) for i in range(n)]
        for a, b in ring:
            faces.append((base, b, a) if not flip else (base, a, b))
        for r in range(rings-1):
            for i in range(n):
                a, b = base+1+r*n+i, base+1+r*n+(i+1) % n
                faces.append((a, b, b+n, a+n) if not flip else (a, a+n, b+n, b))
    last = 1+(rings-1)*n
    for i in range(n):
        a, b = last+i, last+(i+1) % n
        faces.append((b, a, a+half, b+half))
    closed(mesh('Face glass', vertices, faces, head, 'softGlass'))
    return tube(head, edge, rim, material, low, 'Rolled window lip')


def egg(cx, cy, width, height, taper, power, count):
    """A face outline, wider at the brow than the chin."""
    points = []
    for i in range(count):
        a = math.tau*i/count
        c, s = math.cos(a), math.sin(a)
        w = width*(1+taper*s)
        points.append((cx+w*math.copysign(abs(c)**power, c), cy+height*math.copysign(abs(s)**power, s)))
    return points


def head_cairn(nodes, low, surface, eyes, form='ii'):
    head = nodes['head.pitch']
    shell_obj = shell(head, HEAD, 'cairnCover', low)
    # Concept A suggests a tall oval shield. Only Cairn I uses this opening;
    # shell depth, eyes and every authoritative frame stay unchanged.
    width, height = (.058, .091) if form == 'i' else (.052, .074)
    outline = egg(0, .158, width, height, .16, .92, 40 if low else 72)
    front_window(head, shell_obj, outline, surface, .0032, 'cairnCover', low)
    for sign in [-1, 1]:
        # Recessed ear pods: a dark ring around a cover-coloured centre.
        ellipsoid(head, (sign*.071, .174, .006), (.010, .026, .025), 'softCore', low, 'Ear pod ring', 10 if low else 14)
        ellipsoid(head, (sign*.076, .174, .006), (.006, .016, .015), 'cairnCover', low, 'Ear pod', 8 if low else 12)
    for x in [-.027, .027]:
        patch(head, x, eyes, .012, .0038, 'softSignal', low, surface, .5, .0012)


def head_rill(nodes, low, surface, eyes):
    """Ash helmet with a wraparound visor under a brow cut, and one horizon light."""
    head = nodes['head.pitch']
    shell_obj = shell(head, HEAD, 'rillHelmet', low)
    bpy.context.view_layer.update()
    tree = BVHTree.FromPolygons([v.co.copy() for v in shell_obj.data.vertices], [tuple(p.vertices) for p in shell_obj.data.polygons])
    steps = 30 if low else 56
    reach = math.radians(112)

    def band(phi):
        f = min(1, abs(phi)/reach)
        middle = .176-.004*f
        half = .033*(1-f**3)**.5+.002
        return middle-half*1.05, middle+half
    def ray(phi, y):
        return Vector((0, y, -.004)), Vector((math.sin(phi), 0, -math.cos(phi)))
    loop_top, loop_bottom = [], []
    for i in range(steps+1):
        phi = -reach+2*reach*i/steps
        low_y, high_y = band(phi)
        for y, store in [(high_y, loop_top), (low_y, loop_bottom)]:
            origin, direction = ray(phi, y)
            hit, normal, _, _ = tree.ray_cast(origin, direction)
            store.append((hit, normal))
    edge = loop_top+loop_bottom[::-1][1:-1]
    vertices, faces = [], []
    for i in range(steps+1):
        phi = -reach+2*reach*i/steps
        low_y, high_y = band(phi)
        for r, y in [(.01, low_y), (.2, low_y), (.2, high_y), (.01, high_y)]:
            vertices.append((r*math.sin(phi), y, -.004-r*math.cos(phi)))
    for i in range(steps):
        for j in range(4):
            a, b = i*4+j, i*4+(j+1) % 4
            faces.append((a, b, b+4, a+4))
    faces += [(0, 3, 2, 1), (steps*4, steps*4+1, steps*4+2, steps*4+3)]
    cut(shell_obj, vertices, faces)
    # Visor lens on the ellipsoid, wrapping the band, 3 mm deep.
    rows = 3 if low else 5
    front = []
    for i in range(steps+1):
        phi = -reach*1.02+2*reach*1.02*i/steps
        low_y, high_y = band(max(-reach, min(reach, phi)))
        for j in range(rows+1):
            y = low_y-.002+(high_y-low_y+.004)*j/rows
            origin, direction = ray(phi, y)
            front.append(ellipsoid_hit(origin, direction, surface))
    count = len(front)
    vertices = [tuple(p) for p in front]+[tuple(p-(p-Vector((0, p.y, -.004))).normalized()*.003) for p in front]
    faces = []
    for i in range(steps):
        for j in range(rows):
            a, b = i*(rows+1)+j, (i+1)*(rows+1)+j
            faces.append((a, b, b+1, a+1))
            faces.append((a+count, a+1+count, b+1+count, b+count))
    for i in range(steps):
        for j in [0, rows]:
            a, b = i*(rows+1)+j, (i+1)*(rows+1)+j
            faces.append((a, a+count, b+count, b) if j == 0 else (a, b, b+count, a+count))
    for i in [0, steps]:
        for j in range(rows):
            a = i*(rows+1)+j
            faces.append((a, a+1, a+1+count, a+count) if i == 0 else (a, a+count, a+1+count, a+1))
    closed(mesh('Wraparound visor', vertices, faces, head, 'softGlass'))
    tube(head, edge, .0026, 'rillHelmet', low, 'Visor brow lip')
    # One horizon light: a well-shaped strip along the visor, rounded at both ends.
    count = 24 if low else 48
    vertices = []
    for i in range(count+1):
        t = -1+2*i/count
        half = .0017*max(.2, math.sqrt(max(0, 1-t**8)))
        for y in (eyes-half, eyes+half):
            vertices.append((.066*t, y, face_z(.066*t, y, surface, .0012)))
    mesh('Horizon light', vertices, [(2*i, 2*i+1, 2*i+3, 2*i+2) for i in range(count)], head, 'softSignal')


HOOD = [S(-.004, .058, .054, .060, cz=.004), S(.040, .055, .053, .057), S(.072, .061, .062, .061, cz=-.008),
        S(.104, .071, .078, .072, cz=-.010), S(.150, .080, .090, .086, cz=-.004),
        S(.195, .083, .096, .093, cz=.002), S(.235, .080, .090, .091, cz=.004),
        S(.262, .068, .072, .077, cz=.006)]


def head_hush(nodes, low, surface, eyes):
    """Knit balaclava hood, continuous into the neck, with a recessed capsule visor."""
    head = nodes['head.pitch']
    hood = loft(head, HOOD, 'hushCover', low, 32, 18, caps=(.004, .028), per=(2, 1), name='Knit balaclava hood')
    outline = egg(0, .172, .056, .025, 0, .42, 40 if low else 64)
    front_window(head, hood, outline, surface, .0045, 'hushCover', low)
    for x in [-.024, .024]:
        patch(head, x, eyes, .010, .0034, 'softSignal', low, surface, .5, .0012)


def neck(nodes, family, low, form='ii'):
    """Neck on head.yaw. Cairn's slender graphite neck flows out of the trapezius."""
    material = 'softGraphite' if family == 'cairn' else 'softCore'
    sections = [S(-.070, .066, .056, .062), S(-.030, .052, .046, .050), S(.020, .043, .042, .044),
                S(.070, .042, .044, .042, cz=-.004), S(.100, .040, .040, .040, cz=-.004)]
    if (family, form) == ('cairn', 'i'):
        # The stem enters the head inside its existing bearing, rather than
        # cutting through the lower chin beyond that envelope.
        sections = sections[:2]+[S(.020, .039, .036, .040), S(.060, .031, .026, .032, cz=.006),
                                S(.080, .028, .024, .030, cz=.008)]
    loft(nodes['head.yaw'], sections,
         material, low, 20, 12, caps=(.01, .01), name='Neck')


def collar(torso, family, low):
    """Rill's ribbed turtleneck and Hush's knit yoke rise from the thorax around the neck."""
    cover = family+'Cover'
    if family == 'rill':
        rows = [S(.420, .074, .060, .066)]
        for i, y in enumerate([.440, .450, .460, .470, .480, .490, .500, .508]):
            rows.append(S(y, .059+(.0022 if i % 2 else 0), .053+(.0022 if i % 2 else 0), .057+(.0022 if i % 2 else 0)))
        loft(torso, rows, cover, low, 24, 14, caps=(.003, .006), per=(1, 1), name='Ribbed turtleneck', steps=2)
    elif family == 'hush':
        loft(torso, [S(.420, .080, .062, .068), S(.452, .066, .056, .062), S(.488, .060, .053, .058)],
             cover, low, 28, 16, caps=(.003, .005), per=(2, 1), name='Knit yoke collar', steps=2)


def body(nodes, family, form, low):
    from humanoid_forms import cover_sections
    sections = cover_sections(family, form)
    cover = family+'Cover'
    male = form == 'ii'
    panel = family == 'rill'
    torso, pelvis = nodes['spine.roll'], nodes['pelvis']
    side_window = ('rillPanel', [0, math.pi], .36, (-.1, .33)) if panel else None
    # The thorax finishes in a rolled neckline just outside the neck, so the neck
    # leaves it on a clean ring rather than crossing a shallow dome.
    loft(torso, sections['torso'], cover, low, 32, 20, caps=(.012, .006), per=(2, 1), name='Thorax cover', window=side_window, steps=3)
    loft(pelvis, sections['pelvis'], cover, low, 32, 20, caps=(.010, .016), per=(2, 1), name='Pelvis cover', steps=3,
         window=('rillPanel', [0, math.pi], .36, (-.2, .2)) if panel else None)
    # The under-suit is slim, so a cover that gives way at a joint stays a soft
    # cover-coloured dent; it shows only at the designed seams: the waist seam,
    # armpits, neck, crotch and the limb gaskets.
    k = 1.08 if male else 1
    loft(torso, [S(-.060, .070*k, .050, .050), S(0, .094*k, .072, .068), S(.050, .080*k, .060, .058),
                 S(.250, .090*k, .060, .060), S(.350, .130*k, .055, .060), S(.420, .080*k, .045, .050),
                 S(.470, .052, .042, .046)], 'softCore', low, 20, 12, caps=(.01, .02), per=(1, 1), name='Thorax under-suit', steps=2)
    loft(pelvis, [S(.060, .050, .035, .050), S(.000, .050*k, .032, .058), S(-.045, .044*k, .030, .052),
                  S(-.085, .030, .025, .035)], 'softCore', low, 16, 10,
         caps=(.01, .014), per=(1, 1), name='Pelvis under-suit', steps=2)
    arm, leg = PIVOTS[form]['arm'], PIVOTS[form]['leg']
    for side, sign in [('left', -1), ('right', 1)]:
        ellipsoid(torso, (sign*(arm-.014), .346, -.004), (.044*k, .054*k, .050*k), 'softCore', low, 'Armpit gasket')
        a, l = side+'.arm', side+'.leg'
        shoulder = nodes[a+'.yaw']
        loft(shoulder, sections['upper_arm'], cover, low, 20, 12, caps=(.010, .005), sign=sign, name='Upper arm cover', steps=3)
        # Under the fold bevels the under-suits stop short or taper on the flexing
        # side, as the gaskets do; the upper arm's still reaches the elbow so its
        # bone line stays enclosed when the forearm and gasket fold away.
        loft(shoulder, [S(.030, .026*k, .026*k), S(-.100, .022*k, .022*k), S(-.200, .021*k, .021*k),
                        S(-.250, .016*k, .006, .016*k), S(-.290, .014*k, .004, .014*k)],
             'softCore', low, 10, 6, caps=(.01, .006), per=(1, 1), sign=sign, name='Upper arm under-suit', steps=2)
        elbow = nodes[a+'.elbow']
        loft(elbow, [S(.032, .026*k, .005, .027*k), S(.002, .031*k, .032*k), S(-.028, .026*k, .005, .028*k)], 'softCore', low, 16, 10,
             caps=(.006, .006), per=(1, 1), name='Elbow gasket', steps=2)
        loft(elbow, sections['forearm'], cover, low, 18, 12, caps=(.005, .008), sign=sign, name='Forearm cover', steps=3)
        loft(elbow, [S(-.080, .019*k, .018*k), S(-.150, .018*k, .016*k), S(-.255, .016*k, .014*k)],
             'softCore', low, 10, 6, caps=(.008, .008), per=(1, 1), sign=sign, name='Forearm under-suit', steps=2)
        hand(nodes[a+'.wrist.yaw'], a.replace('.', '_'), cover, low, sign, male, family)
        thigh = nodes[l+'.yaw']
        loft(thigh, sections['thigh'], cover, low, 24, 14, caps=(.012, .006), sign=sign, name='Thigh cover', steps=3,
             window=('rillPanel', [0], .5, (-.36, .02)) if panel else None)
        # The core holds the bone line but stays inside the medially offset cover.
        loft(thigh, [S(.030, .014*k, .028, med=.040*k, cx=-.008), S(-.200, .016*k, .026, med=.034*k, cx=-.006),
                     S(-.430, .026*k, .026)], 'softCore', low, 12, 6, caps=(.01, .01), per=(1, 1), sign=sign,
             name='Thigh under-suit', steps=2)
        knee = nodes[l+'.knee']
        loft(knee, [S(.044, .040*k, .042*k, .010), S(.002, .044*k, .046*k), S(-.038, .038*k, .040*k, .016)], 'softCore', low, 18, 10,
             caps=(.008, .008), per=(1, 1), name='Knee gasket', steps=2)
        loft(knee, sections['shin'], cover, low, 20, 12, caps=(.006, .010), sign=sign, name='Shin cover', steps=3,
             window=('rillPanel', [0], .5, (-.33, -.05)) if panel else None)
        loft(knee, [S(-.080, .021*k, .021*k), S(-.200, .021*k, .021*k), S(-.410, .019*k, .019*k)],
             'softCore', low, 10, 6, caps=(.008, .008), per=(1, 1), sign=sign, name='Shin under-suit', steps=2)
        if family == 'hush':
            # Knit knee patches: shallow ovals standing proud of the gasket band over the kneecap.
            ellipsoid(knee, (0, -.006, -.050*k), (.030*k, .034, .007), cover, low, 'Knit knee patch')
        shoe(nodes[l+'.ankle.roll'], family, low, male)
    collar(torso, family, low)
    if family == 'cairn':
        # Restrained lime chest badge on the right upper chest, angled with the panel line.
        thorax = next(o for o in torso.children if o.name.startswith('Thorax cover'))
        tree = BVHTree.FromPolygons([v.co.copy() for v in thorax.data.vertices], [tuple(p.vertices) for p in thorax.data.polygons])
        hit, normal, _, _ = tree.ray_cast(Vector((.058, .392, -.5)), Vector((0, 0, 1)))
        badge = loft(torso, [S(-.013, .0036, .0026), S(.013, .0036, .0026)], 'softAccent', low, 10, 8,
                     caps=(.0035, .0035), per=(1, 1), name='Chest badge')
        turn = Matrix.Rotation(math.radians(62), 3, 'Z')
        tilt = Vector((0, 0, -1)).rotation_difference(normal).to_matrix()
        for vertex in badge.data.vertices:
            vertex.co = tilt @ (turn @ vertex.co)
        badge.location = hit-normal*.0012


def digit(frame, x, top, length, width, depth, material, low, tip=False):
    """A tapered phalange with knuckle volume, rounded at both ends."""
    rows = [S(top, width, depth, depth*1.12, cx=x, cz=.0005), S(top-length*.5, width*.9, depth*.9, depth, cx=x),
            S(top-length, width*.84, depth*.84, depth*.92, cx=x)]
    return loft(frame, rows, material, low, 8, 6, caps=(.003, width*.95 if tip else .003), per=(1, 1),
                name='Tapered phalange', steps=1 if low else 2)


def hand(wrist, name, cover, low, sign, male, family):
    """Tapered palm, thumb pad and graded fingers on the existing tendon frames."""
    w = 1 if male else .95
    loft(wrist, [S(.008, .024*w, .017, .017), S(-.015, .030*w, .018, .015, cz=-.002),
                 S(-.040, .039*w, .020, .013, med=.037*w, cz=-.006), S(-.062, .043*w, .019, .012, cz=-.011),
                 S(-.079, .043*w, .015, .011, cz=-.016)], cover, low, 18, 10, caps=(.006, .007), per=(2, 1),
         sign=sign, name='Palm cover', steps=3)
    # A smooth band that stays inside the palm's rolled top and shows only above it,
    # tapering into the forearm lip's dome rather than meeting its side.
    loft(wrist, [S(.022, .012*w, .009, .008, cz=-.001), S(.010, .021*w, .015, .014, cz=-.001), S(-.002, .020*w, .014, .013, cz=-.001)],
         'softCore', low, 16, 10, caps=(.004, .004), per=(1, 1), name='Wrist gasket', steps=2)
    ellipsoid(wrist, (sign*.025*w, -.044, -.018), (.012*w, .021, .005), cover, low, 'Thumb pad', 8 if low else 10)
    if family == 'hush':
        loft(wrist, [S(.012, .030*w, .022, .021), S(-.004, .031*w, .023, .022), S(-.016, .030*w, .022, .021)],
             cover, low, 18, 10, caps=(.002, .002), per=(1, 1), name='Knit glove cuff')
    first = pivot(name+'_fingers', wrist, (0, -.08, -.022))
    second = pivot(name+'_tips', first, (0, -.035, 0))
    third = pivot(name+'_distal', second, (0, -.029, 0))
    # Finger index 0 is at -x; the index finger sits beside the thumb on the lateral side.
    for i in range(4):
        x = (i-1.5)*.021
        order = i if sign < 0 else 3-i  # 0 index, 1 middle, 2 ring, 3 little
        width = [.0084, .0087, .0082, .0073][order]*w
        depth = [.0074, .0077, .0073, .0066][order]*w
        start = [-.003, 0, -.003, -.008][order]
        tip = [.023, .026, .023, .019][order]
        digit(first, x, .004+start, .039+start, width, depth, cover, low)
        digit(second, x, .002, .031, width*.93, depth*.93, cover, low)
        digit(third, x, .002, tip, width*.86, depth*.86, cover, low, True)
    thumb = pivot(name+'_thumb', wrist, (sign*.041, -.037, .002))
    thumb.rotation_euler.z = sign*.55
    loft(thumb, [S(.010, .0125*w, .012), S(-.024, .0118*w, .0105), S(-.050, .0102*w, .0092)], cover, low, 8, 6,
         caps=(.004, .004), per=(1, 1), name='Thumb', steps=1 if low else 2)
    tip = pivot(name+'_thumb_tip', thumb, (0, -.05, -.003))
    loft(tip, [S(.004, .0098*w, .0088), S(-.014, .0094*w, .0084), S(-.026, .0080*w, .0072)], cover, low, 8, 6,
         caps=(.003, .007), per=(1, 1), name='Thumb tip', steps=1 if low else 2)


def shoe(foot, family, low, male):
    """A shoe on the physics foot box: flat sole on its bottom plane, toe to heel."""
    w = 1 if male else .95
    cover = {'cairn': 'cairnCover', 'rill': 'rillCover', 'hush': 'hushCover'}[family]
    sole_height = {'cairn': .009, 'rill': .007, 'hush': .016}[family]
    def build(stations, material, lift, grow, name, count=20):
        rows = []
        for z, half, top in stations:
            top = max(top, SOLE+lift) if lift else top
            height = (top-SOLE)/2
            rows.append(S(z, half*w+grow, height*1.25, height, cz=SOLE+height, e=.75))
        obj = loft(foot, rows, material, low, count, count*2//3, caps=(.006, .006), per=(2, 1) if count > 16 else (1, 1), name=name, steps=3)
        for vertex in obj.data.vertices:
            x, y, z = vertex.co
            vertex.co = (x, max(SOLE, z), y)
        return closed(obj)
    # Per direction: Cairn's loafer has a low vamp, Rill's knit slip-on a sock
    # collar up the ankle, Hush's knit sneaker a fuller toe box over a thick sole.
    raise_top = {'cairn': [0, 0, 0, -.002, -.007, -.008, -.002, 0, 0],
                 'rill': [0, 0, 0, 0, .002, .010, .016, .014, .006],
                 'hush': [.005, .005, .004, .003, .002, .004, .006, .005, .003]}[family]
    upper = [(z, half, top+lift) for (z, half, top), lift in zip(SHOE, raise_top)]
    build(upper, cover, 0, 0, 'Shoe upper')
    build([(z, half, SOLE+sole_height) for z, half, _ in SHOE], 'softCore', sole_height, .002, 'Outsole', count=16)
    loft(foot, [S(.050, .027*w, .028*w), S(.010, .031*w, .033*w), S(-.024, .033*w, .040*w, cz=.004)], 'softCore',
         low, 12, 8, caps=(.006, .006), per=(1, 1), name='Ankle gasket', steps=2)


def flatten_hinges(nodes):
    """Elbows and knees fold against a fixed plane through the hinge.

    At full flexion the two covers meet at the plane; the angles either side add
    up to 180 degrees less the flexion limit. The knee gives the calf the larger
    share, so the popliteal side of the thigh flattens rather than the calf. Each
    cover flattens from its lip, as one clean bevel, and the under-suit beyond the
    lip is seated 3 mm under the same plane, so the fold reads as a cover-coloured
    crease rather than a recessed, dark notch.
    """
    for side in ['left', 'right']:
        # Lips: how far each cover's rolled end sits from the hinge, above and below.
        for fixed, moving, offset, splits, flexes_back, lips in [
            (side+'.arm.yaw', side+'.arm.elbow', -.29, (20, 20), False, (.031, .023)),
            (side+'.leg.yaw', side+'.leg.knee', -.43, (20, 30), True, (.044, .024)),
        ]:
            for node, origin, above, split, lip in [(nodes[fixed], offset, True, splits[0], lips[0]),
                                                    (nodes[moving], 0, False, splits[1], lips[1])]:
                slope = math.tan(math.radians(split))
                for obj in node.children:
                    if obj.type != 'MESH':
                        continue
                    core = obj.data.materials[0].name == 'softCore'
                    if not core and not obj.data.materials[0].name.endswith('Cover'):
                        continue
                    for vertex in obj.data.vertices:
                        q = Vector(obj.location)+vertex.co-Vector((0, origin, 0))
                        if (q.y <= 0) == above or (core and abs(q.y) < lip):
                            continue
                        limit = slope*abs(q.y)-(.008 if core else .005)
                        if flexes_back and q.z > limit:
                            vertex.co.z = limit-obj.location.z
                        elif not flexes_back and -q.z > limit:
                            vertex.co.z = -limit-obj.location.z
                    obj.data.update()


def audited_pairs(nodes):
    """The audit's pairs: hinge, leaf, stationary, axis, limits (degrees), bearing radius."""
    pairs = [('spine.yaw', 'spine.roll', 'pelvis', 1, (-35, 35), .115),
             ('spine.pitch', 'spine.roll', 'pelvis', 0, (-20, 30), .115),
             ('spine.roll', 'spine.roll', 'pelvis', 2, (-20, 20), .115),
             ('head.yaw', 'head.pitch', 'spine.roll', 1, (-60, 60), .102),
             ('head.pitch', 'head.pitch', 'spine.roll', 0, (-35, 45), .102)]
    for side, sign in [('left', -1), ('right', 1)]:
        p = side+'.'
        pairs += [(p+'arm.roll', p+'arm.yaw', 'spine.roll', 2, (-15*sign, 110*sign), .100),
                  (p+'arm.pitch', p+'arm.yaw', 'spine.roll', 0, (-80, 140), .100),
                  (p+'arm.yaw', p+'arm.yaw', 'spine.roll', 1, (-70, 70), .100),
                  (p+'leg.roll', p+'leg.yaw', 'pelvis', 2, (-25*sign, 45*sign), .105),
                  (p+'leg.pitch', p+'leg.yaw', 'pelvis', 0, (-35, 100), .105),
                  (p+'leg.yaw', p+'leg.yaw', 'pelvis', 1, (-35, 35), .105),
                  (p+'arm.elbow', p+'arm.elbow', p+'arm.yaw', 0, (0, 140), .070),
                  (p+'arm.wrist.pitch', p+'arm.wrist.yaw', p+'arm.elbow', 0, (-45, 45), .055),
                  (p+'arm.wrist.roll', p+'arm.wrist.yaw', p+'arm.elbow', 1, (-90, 90), .055),
                  (p+'arm.wrist.yaw', p+'arm.wrist.yaw', p+'arm.elbow', 2, (-35, 35), .055),
                  (p+'leg.knee', p+'leg.knee', p+'leg.yaw', 0, (0, -130), .085),
                  (p+'leg.ankle.pitch', p+'leg.ankle.roll', p+'leg.knee', 0, (-35, 25), .064),
                  (p+'leg.ankle.roll', p+'leg.ankle.roll', p+'leg.knee', 2, (-20, 20), .064)]
    return [(nodes[h], nodes[l], nodes[s], axis, limits, radius) for h, l, s, axis, limits, radius in pairs]


# Where a cover gives way: toward a point of its own body, so a recess moves
# monotonically inward and reads as one soft give rather than a cut.
ANCHORS = {
    'pelvis': lambda p: Vector((0, .09, .005)),
    'spine.roll': lambda p: Vector((0, p.y, .005)),
    'arm.yaw': lambda p: Vector((0, p.y, 0)),
    'arm.elbow': lambda p: Vector((0, p.y, 0)),
    'leg.yaw': lambda p: Vector((-.025, p.y, 0)),
    'leg.knee': lambda p: Vector((0, p.y, .002)),
    'head.pitch': lambda p: Vector((0, .17, 0)),
    'arm.wrist.yaw': lambda p: Vector((0, -.04, -.01)),
    'leg.ankle.roll': lambda p: Vector((0, -.04, -.06)),
}


def triangles(points, obj):
    """A BVH over the mesh's triangles: an n-gon cap's normal is then never ambiguous."""
    obj.data.calc_loop_triangles()
    return BVHTree.FromPolygons(points, [tuple(t.vertices) for t in obj.data.loop_triangles], all_triangles=True)


RAY = Vector((.5773, .5774, .5774))


def touching(tree, p, margin):
    """Inside a closed cover, or within the margin of it.

    The nearest-surface normal alone misreads points beside a rim, where the
    nearest point lies on an edge; a point that seems inside is confirmed by
    counting crossings along a fixed ray.
    """
    loc, normal, _, distance = tree.find_nearest(p, .25)
    if loc is None:
        return False
    if distance < margin:
        return True
    if (p-loc).dot(normal) > 0:
        return False
    crossings, origin = 0, p.copy()
    for _ in range(24):
        hit = tree.ray_cast(origin, RAY, 2)[0]
        if hit is None:
            break
        crossings += 1
        origin = hit+RAY*1e-5
    return crossings % 2 == 1


def band(radius):
    """Depth checked inside a bearing envelope: wide at the hips, narrow elsewhere."""
    return .028 if radius == .105 else .015


def anchor_for(node):
    key = node.name.replace('_', '.')
    for prefix in ['left.', 'right.']:
        key = key.replace(prefix, '')
    return ANCHORS[key]


def clear_sweeps(nodes, cover, margin=.009, pairs=None):
    """Recess fixed covers out of the union of every audited moving-cover pose.

    For each stationary part, the moving covers are sampled at the audit's own
    65 angles per axis. A fixed vertex inside any pose (and outside that joint's
    bearing envelope) moves toward an anchor in its own body until it is clear,
    then the recess is relaxed and checked again. Moving monotonically inward,
    unlike pushing to the nearest surface, cannot oscillate between poses.
    """
    groups = {}
    for pair in pairs if pairs is not None else audited_pairs(nodes):
        groups.setdefault(pair[2].name, []).append(pair)
    report = {}
    for pairs in groups.values():
        stationary = pairs[0][2]
        shells = [o for o in stationary.children if o.type == 'MESH' and o.data.materials[0].name == cover]
        if not shells:
            continue
        poses = []
        for hinge, leaf, _, axis, limits, radius in pairs:
            movers = [o for o in leaf.children if o.type == 'MESH' and o.data.materials[0].name == cover]
            if not movers:
                continue
            trees = []
            for o in movers:
                points = [o.matrix_local @ v.co for v in o.data.vertices]
                middle = sum(points, Vector())/len(points)
                reach = max((p-middle).length for p in points)+margin
                trees.append((triangles(points, o), middle, reach))
            for step in range(SAMPLES):
                hinge.rotation_euler[axis] = math.radians(limits[0]+(limits[1]-limits[0])*step/(SAMPLES-1))
                bpy.context.view_layer.update()
                poses.append((leaf.matrix_world.inverted(), hinge.matrix_world.translation.copy(), radius, trees))
            hinge.rotation_euler[axis] = 0
        bpy.context.view_layer.update()

        def blocked(p):
            for inverse, centre, radius, trees in poses:
                # Clear a band inside the bearing envelope too: an edge from an
                # exempt vertex must not cross the moving cover outside it. The
                # band spans the coarsest neighbouring triangles (the pelvis).
                if (p-centre).length < radius-band(radius):
                    continue
                q = inverse @ p
                for tree, middle, reach in trees:
                    if (q-middle).length > reach:
                        continue
                    if touching(tree, q, margin):
                        return True
            return False
        anchor = anchor_for(stationary)
        world = stationary.matrix_world
        for obj in shells:
            local = obj.matrix_local
            inverse = local.inverted()
            touched = set()
            for attempt in range(4):
                moved = []
                for vertex in obj.data.vertices:
                    if not blocked(world @ (local @ vertex.co)):
                        continue
                    start = local @ vertex.co
                    target = anchor(start)
                    point = start
                    for k in range(1, 61):
                        point = start.lerp(target, k/60)
                        if not blocked(world @ point):
                            break
                    vertex.co = inverse @ point
                    moved.append(vertex.index)
                obj.data.update()
                report[obj.name] = report.get(obj.name, 0)+len(moved)
                touched.update(moved)
                if not moved or attempt == 3:
                    break
                if attempt < 2:
                    relax(obj, moved, 3 if attempt == 0 else 1, 8 if attempt == 0 else 2)
            if touched:
                settle(obj, touched, lambda co, local=local: blocked(world @ (local @ co)))
        # Then the moving covers: a lip of the moving cover that still enters the
        # (recessed) fixed cover at a sampled pose eases back into its own body.
        fixed = []
        for obj in shells:
            points = [obj.matrix_local @ v.co for v in obj.data.vertices]
            fixed.append(triangles(points, obj))
        for hinge, leaf, _, axis, limits, radius in pairs:
            movers = [o for o in leaf.children if o.type == 'MESH' and o.data.materials[0].name == cover]
            frames = []
            for step in range(SAMPLES):
                hinge.rotation_euler[axis] = math.radians(limits[0]+(limits[1]-limits[0])*step/(SAMPLES-1))
                bpy.context.view_layer.update()
                frames.append((world.inverted() @ leaf.matrix_world, world.inverted() @ hinge.matrix_world.translation))
            hinge.rotation_euler[axis] = 0
            bpy.context.view_layer.update()

            def inside(q):
                for frame, centre in frames:
                    p = frame @ q
                    if (p-centre).length < radius-band(radius):
                        continue
                    for tree in fixed:
                        if touching(tree, p, margin):
                            return True
                return False
            pull = anchor_for(leaf)
            for obj in movers:
                local = obj.matrix_local
                inverse = local.inverted()
                eased = set()
                for attempt in range(3):
                    moved = []
                    for vertex in obj.data.vertices:
                        start = local @ vertex.co
                        if not inside(start):
                            continue
                        target = pull(start)
                        point = start
                        for k in range(1, 41):
                            point = start.lerp(target, k/40)
                            if not inside(point):
                                break
                        vertex.co = inverse @ point
                        moved.append(vertex.index)
                    obj.data.update()
                    report[obj.name] = report.get(obj.name, 0)+len(moved)
                    eased.update(moved)
                    if not moved or attempt == 2:
                        break
                    # Spread the eased lip over its neighbours, then ease again.
                    relax(obj, moved, 2 if attempt == 0 else 1, 6 if attempt == 0 else 2)
                if eased:
                    settle(obj, eased, lambda co, local=local: inside(local @ co))
    return report


def relax(obj, indices, rings=2, iterations=4):
    """Relax a recess and its neighbours so it reads as one soft, continuous give."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    region = set(indices)
    for _ in range(rings):
        for index in list(region):
            region.update(e.other_vert(bm.verts[index]).index for e in bm.verts[index].link_edges)
    for _ in range(iterations):
        positions = {}
        for index in region:
            v = bm.verts[index]
            around = [e.other_vert(v).co for e in v.link_edges]
            if around:
                positions[index] = v.co*.5+sum(around, Vector())/len(around)*.5
        for index, co in positions.items():
            bm.verts[index].co = co
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def settle(obj, indices, blocked, rings=3, iterations=8):
    """Smooth the rims of a recess without reopening it.

    Each pass moves a recessed vertex or one of its neighbours halfway to the mean
    of its neighbours, but only where that position stays clear of every sampled
    pose, so the rim of a notch eases into a soft give instead of a torn edge.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    region = set(indices)
    for _ in range(rings):
        for index in list(region):
            region.update(e.other_vert(bm.verts[index]).index for e in bm.verts[index].link_edges)
    for _ in range(iterations):
        changed = 0
        for index in region:
            v = bm.verts[index]
            around = [e.other_vert(v).co for e in v.link_edges]
            if not around:
                continue
            target = v.co*.5+sum(around, Vector())/len(around)*.5
            if (target-v.co).length > 1e-5 and not blocked(target):
                v.co = target
                changed += 1
        if not changed:
            break
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def lining(nodes, family):
    """The under-suit at the crotch and hip crease takes the cover's colour.

    The concepts show no dark under-suit there, so the pelvis and thigh linings
    read as one continuous leotard line under the rolled lips. Their geometry is
    unchanged, and they stay outside the cover clearance audit as before.
    """
    cover = MATERIALS[family+'Cover']
    for node in ['pelvis', 'left.leg.yaw', 'right.leg.yaw']:
        for obj in nodes[node].children:
            if obj.type == 'MESH' and 'under-suit' in obj.name:
                obj.data.materials[0] = cover


def build_soft(name, low=False, clear=True):
    family, form = name.split('-')
    assert family in NAMES and form in ['i', 'ii']
    scale = SPEC['forms'][form]['height']/1.8
    if clear:
        reset()
        soft_finishes()
    existing = set(bpy.context.scene.objects)
    nodes = joint_tree()
    for side, sign in [('left', -1), ('right', 1)]:
        nodes[side+'.arm.roll'].location.x = sign*PIVOTS[form]['arm']
        nodes[side+'.leg.roll'].location.x = sign*PIVOTS[form]['leg']
    bpy.context.view_layer.update()
    face = SPEC['faces'][family]
    if family == 'cairn':
        head_cairn(nodes, low, face['surface'], face['eyes'], form)
    else:
        {'rill': head_rill, 'hush': head_hush}[family](nodes, low, face['surface'], face['eyes'])
    neck(nodes, family, low, form)
    body(nodes, family, form, low)
    if SKINNED:
        def clear(pairs):
            clear_sweeps(nodes, family+'Cover', pairs=pairs)
        clear.pairs = audited_pairs(nodes)
        humanoid_skin.skin_body(nodes, family, form, low, loft, S, clear)
    flatten_hinges(nodes)
    if SKINNED:
        humanoid_skin.cores(nodes, family, form, low, loft, S)
    cover = family+'Cover'
    if SKINNED and '--no-relief' not in sys.argv:
        suit = bpy.data.objects['Suit']
        moved = humanoid_skin.relieve(suit, nodes, audited_pairs(nodes),
                                      lambda o: o.data.materials[0].name == cover and 'under-suit' not in o.name)
        print('suit relief', moved)
    if '--no-relief' not in sys.argv and not SKINNED:
        recessed = clear_sweeps(nodes, cover)
        print('recessed', {k: v for k, v in recessed.items() if v})
    lining(nodes, family)
    if scale != 1:
        for obj in set(bpy.context.scene.objects)-existing:
            obj.location *= scale
            if obj.type == 'MESH':
                for vertex in obj.data.vertices:
                    vertex.co *= scale
    bpy.context.view_layer.update()
    return nodes


if __name__ == '__main__':
    selected = sys.argv[sys.argv.index('--only')+1] if '--only' in sys.argv else None
    for name in FORMS:
        if selected and name != selected:
            continue
        if '--start-from' in sys.argv and FORMS.index(name) < FORMS.index(sys.argv[sys.argv.index('--start-from')+1]):
            continue
        for low in [False, True]:
            if '--hero' in sys.argv and low:
                continue
            build_soft(name, low)
            if '--cache' in sys.argv:
                directory = ROOT/'artifacts/humanoid-third/build/source'
                directory.mkdir(parents=True, exist_ok=True)
                bpy.ops.wm.save_as_mainfile(filepath=str(directory/f'{name}{"-lod" if low else ""}.blend'))
            if '--no-export' not in sys.argv:
                humanoid_skin.sidecar(name+('-lod' if low else ''))
                export(name+('-lod' if low else ''), repair_normals=True, position_bits=24)
