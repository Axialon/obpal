"""A continuous knit bodysuit for the soft humanoids, skinned to the live pivots.

v3 (D2) replaces the rigid trunk and limb covers, their dark gaskets and the
pelvis brief with one closed suit. The H2a covers remain the design source:
their union, with the under-suits filling the joint gaps, is voxel remeshed,
relaxed and reduced to the level's budget. Each suit vertex belongs to the pivot
of the nearest source part; inside a ball around each flexing joint the weights
are then diffused over the surface, so the suit bends as one knit rather than
meeting at bands. The head, neck, collar, hands and shoes stay rigid on their
pivots, and every pivot, joint frame and rest proportion is unchanged.

The suit's knit tones (Rill's side panels, Cairn's graphite joint inserts,
Hush's knee patches) are vertex colours on one material. Weights and colours
travel to the GLB in a sidecar that compress.mjs turns into a glTF skin whose
joints are the existing pivot nodes.
"""
import json
import math
import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from common import MATERIALS, ROOT

# Pivots the suit is weighted to; the wrist and ankle cuffs ride the forearm and shin.
BONES = ['pelvis', 'spine.roll'] + [f'{side}.{part}' for side in ['left', 'right']
                                    for part in ['arm.yaw', 'arm.elbow', 'leg.yaw', 'leg.knee']]
# H2a trunk parts fused into the suit; the limbs are lofted through their joints instead.
FUSED = ('Thorax cover', 'Pelvis cover')
# H2a parts the suit replaces, by name; everything else on these pivots stays rigid.
SOURCES = ('Thorax cover', 'Pelvis cover', 'Upper arm cover', 'Forearm cover', 'Thigh cover', 'Shin cover',
           'Thorax under-suit', 'Pelvis under-suit', 'Upper arm under-suit', 'Forearm under-suit',
           'Thigh under-suit', 'Shin under-suit', 'Armpit gasket', 'Elbow gasket', 'Knee gasket', 'Knit knee patch')
# Where weights blend: a ball around each joint, by the joint's reach (authoring metres).
BLENDS = {'spine.yaw': .15, 'arm.roll': .11, 'arm.elbow': .046, 'leg.knee': .058}
# Degrees each arm is abducted while the suit is fused and weighted.
SPREAD = 12
# Knit tones, linear: the suit's base, and per family the inserts or panels.
TONES = {
    'cairn': {'base': (.213, .168, .146), 'insert': (.026, .030, .032)},
    'rill': {'base': (.054, .052, .056), 'panel': (.011, .012, .014)},
    'hush': {'base': (.024, .023, .024), 'patch': (.046, .044, .045), 'yoke': (.040, .038, .039)},
}
# Triangles for the suit at each level; the rigid parts take the rest of the budget.
BUDGET = {False: 11000, True: 4200}


def source_parts(nodes, names=SOURCES):
    parts = []
    for bone in BONES:
        for obj in nodes[bone].children:
            if obj.type == 'MESH' and obj.name.split('.')[0] in names:
                parts.append((bone, obj))
    return parts


def shifted(section, dy):
    return {**section, 'y': section['y']+dy}


def limbs(nodes, form, family, low, loft, S):
    """One loft per limb through its hinge, from the H2a cover sections.

    The upper and lower cover sections meet in an elbow or knee section between
    their former lips, so the suit tapers through the joint without a band.
    Returns (upper pivot, lower pivot, loft) for each limb.
    """
    from humanoid_forms import UPPER_ARM, FOREARM, THIGH, SHIN
    out = []
    cover = family+'Cover'
    for side, sign in [('left', -1), ('right', 1)]:
        a, l = side+'.arm', side+'.leg'
        arm = UPPER_ARM[form]+[S(-.290, .031, .027, .032, med=.031, cz=.002)]+[shifted(x, -.29) for x in FOREARM[form]]
        out.append((a+'.yaw', a+'.elbow', loft(nodes[a+'.yaw'], arm, cover, False, 24, 16, caps=(.010, .008), sign=sign,
                                              per=(2, 1), name='Arm suit source', steps=2)))
        # The thigh starts at its second section under a deep rounded cap, so its top
        # tucks under the pelvis as a dome rather than standing beside it.
        leg = THIGH[form][1:]+[S(-.430, .045, .046, .044, med=.045)]+[shifted(x, -.43) for x in SHIN[form]]
        out.append((l+'.yaw', l+'.knee', loft(nodes[l+'.yaw'], leg, cover, False, 28, 16, caps=(.03, .010), sign=sign,
                                             per=(2, 1), name='Leg suit source', steps=2)))
    return out


def evaluated(obj):
    """Apply the object's modifier stack to its own mesh."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    result = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    obj.modifiers.clear()
    old = obj.data
    obj.data = result
    bpy.data.meshes.remove(old)
    return obj


def remeshed(name, parts, low):
    """One region's parts as a single closed, relaxed voxel surface, in world space."""
    bm = bmesh.new()
    for _, obj in parts:
        data = obj.data.copy()
        data.transform(obj.matrix_world)
        bm.from_mesh(data)
        bpy.data.meshes.remove(data)
    data = bpy.data.meshes.new(name)
    bm.to_mesh(data)
    bm.free()
    region = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(region)
    remesh = region.modifiers.new('Union', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = .0065 if low else .0042
    remesh.adaptivity = 0
    smooth = region.modifiers.new('Relax', 'LAPLACIANSMOOTH')
    # Enough relaxation to melt the H2a covers' rolled lips into one surface.
    smooth.lambda_factor = .6
    smooth.iterations = 5 if low else 18
    smooth.use_volume_preserve = True
    return evaluated(region)


def relax(obj, zones, low):
    """Extra relaxation where H2a covers met: the hip creases, crotch and shoulders."""
    group = obj.vertex_groups.new(name='Relax')
    co = np.array([tuple(v.co) for v in obj.data.vertices])
    weight = np.zeros(len(co))
    for centre, radius in zones:
        d = np.linalg.norm(co-np.array(tuple(centre)), axis=1)
        weight = np.maximum(weight, np.clip((radius-d)/(radius*.5), 0, 1))
    for i in np.flatnonzero(weight > 0):
        group.add([int(i)], float(weight[i]), 'REPLACE')
    smooth = obj.modifiers.new('Crease', 'LAPLACIANSMOOTH')
    smooth.lambda_factor = .7
    smooth.iterations = 12 if low else 50
    smooth.use_volume_preserve = True
    smooth.vertex_group = 'Relax'
    evaluated(obj)
    obj.vertex_groups.clear()


def joined(shells, low):
    """Reduce each shell to the level's budget in proportion, then join them; returns the
    suit and each vertex's shell index."""
    total = 0
    for shell in shells:
        shell.data.calc_loop_triangles()
        total += len(shell.data.loop_triangles)
    bm = bmesh.new()
    labels = []
    for k, shell in enumerate(shells):
        decimate = shell.modifiers.new('Budget', 'DECIMATE')
        decimate.decimate_type = 'COLLAPSE'
        decimate.use_collapse_triangulate = True
        decimate.ratio = min(1, BUDGET[low]/total)
        evaluated(shell)
        before = len(bm.verts)
        bm.from_mesh(shell.data)
        labels += [k]*(len(bm.verts)-before)
    suit = shells[0]
    for shell in shells[1:]:
        bpy.data.objects.remove(shell, do_unlink=True)
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(suit.data)
    bm.free()
    suit.data.name = 'Suit'
    suit.name = 'Suit'
    for polygon in suit.data.polygons:
        polygon.use_smooth = True
    return suit, np.array(labels)


def fuse(parts, low, shoulders):
    """Three closed shells in one mesh: the trunk with both arms, and each leg.

    The trunk and each arm are remeshed apart and united only at the shoulders: a
    single voxel union would also weld a hanging forearm to the hip it nearly
    touches. Each leg is its own shell whose top tucks under the pelvis at the
    hip seam, as the concepts' leotard line, panel and insert do.
    """
    trunk = remeshed('Suit', [p for p in parts if p[0] in ('pelvis', 'spine.roll')], low)
    for side in ['left', 'right']:
        arm = remeshed(side+' arm', [p for p in parts if p[0].startswith(side+'.arm')], low)
        union = trunk.modifiers.new('Shoulder', 'BOOLEAN')
        union.operation = 'UNION'
        union.solver = 'EXACT'
        union.object = arm
        evaluated(trunk)
        bpy.data.objects.remove(arm, do_unlink=True)
    relax(trunk, shoulders, low)
    legs = [remeshed(side+' leg', [p for p in parts if p[0].startswith(side+'.leg')], low) for side in ['left', 'right']]
    return joined([trunk, *legs], low)


def neighbours(data):
    around = [set() for _ in data.vertices]
    for edge in data.edges:
        a, b = edge.vertices
        around[a].add(b)
        around[b].add(a)
    return [list(a) for a in around]


def diffuse(values, around, active, iterations):
    """Average each active vertex with its neighbours; inactive vertices hold the boundary."""
    index = np.flatnonzero(active)
    for _ in range(iterations):
        nxt = values.copy()
        for i in index:
            nxt[i] = values[i]*.5+values[around[i]].mean(axis=0)*.5
        values = nxt
    return values


def rill_panel(bone, local, side):
    """Rill's ash panels, as in concept B: down each side of the ribcage, over the
    hip and the front of the outer thigh and shin to the ankle, and a yoke stripe
    over each shoulder beside the collar."""
    sign = -1 if side == 'left' else 1
    if bone in ('pelvis', 'spine.roll'):
        around = math.degrees(math.atan2(abs(local.x), -local.z))
        if bone == 'spine.roll':
            return (75 < around < 118 and -.02 < local.y < .30) or (local.y > .41 and .07 < abs(local.x) < .15)
        return 52 < around < 112 and local.y > -.045
    if '.leg.' in bone:
        around = math.degrees(math.atan2(sign*local.x, -local.z))
        return 28 < around < 96
    return False


def tone(family, part, local, side, bone):
    """The knit tone near an H2a part, at a point in its owning pivot's rest frame."""
    tones = TONES[family]
    if family == 'cairn':
        # Graphite inserts where the H2a gaskets and crotch lining showed, as in concept A.
        inserts = ('Armpit gasket', 'Elbow gasket', 'Knee gasket', 'Pelvis under-suit')
        return tones['insert'] if part.split('.')[0] in inserts else tones['base']
    if family == 'rill':
        return tones['panel'] if rill_panel(bone, local, side) else tones['base']
    if part.startswith('Knit knee patch'):
        return tones['patch']
    # Hush's ribbed yoke over the shoulders and upper chest (concept C), a shade lighter.
    if bone == 'spine.roll' and local.y > .32+.05*(1-min(1, abs(local.x)/.15)):
        return tones['yoke']
    if bone.endswith('arm.yaw') and local.y > -.06:
        return tones['yoke']
    return tones['base']


def skin_body(nodes, family, form, low, loft, S, clear):
    """Replace the trunk and limb covers with one weighted suit; returns the suit object.

    The suit is fused and weighted with the arms abducted by SPREAD, clear of the
    hips they hang beside, then returned to rest through the inverse of its own
    blend, so posing that abduction reproduces the fused surface exactly.
    """
    rest_world = {}
    bpy.context.view_layer.update()
    for bone in BONES:
        rest_world[bone] = nodes[bone].matrix_world.copy()
    for side, sign in [('left', -1), ('right', 1)]:
        nodes[side+'.arm.roll'].rotation_euler[2] = math.radians(sign*SPREAD)
    bpy.context.view_layer.update()
    spread = {bone: nodes[bone].matrix_world @ rest_world[bone].inverted() for bone in BONES}
    parts = source_parts(nodes)
    # The H2a surfaces set the knit tones; keep them as trees, then retire all but the trunk covers.
    trees = []
    for bone, obj in parts:
        world = [obj.matrix_world @ v.co for v in obj.data.vertices]
        obj.data.calc_loop_triangles()
        tris = [tuple(t.vertices) for t in obj.data.loop_triangles]
        trees.append((bone, obj.name, BVHTree.FromPolygons(world, tris, all_triangles=True)))
    for _, obj in parts:
        if obj.name.split('.')[0] not in FUSED:
            bpy.data.objects.remove(obj, do_unlink=True)
    lofts = limbs(nodes, form, family, low, loft, S)
    bpy.context.view_layer.update()
    # The hip seam is cleared like the H2a covers: the pelvis recessed out of every
    # sampled thigh pose and the thigh tops eased back, before anything is fused.
    clear([pair for pair in clear.pairs if pair[1].name.endswith('leg_yaw')])
    fused = source_parts(nodes, FUSED)+[(upper, obj) for upper, _, obj in lofts]
    rest = {bone: nodes[bone].matrix_world.translation.copy() for bone in BONES}

    def at(name):
        return nodes[name].matrix_world.translation.copy()
    shoulders = [(at(side+'.arm.roll'), .10) for side in ['left', 'right']]
    suit, shells = fuse(fused, low, shoulders)
    hinges = {obj.name: (upper, lower, at(lower), (at(upper)-at(lower)).normalized()) for upper, lower, obj in lofts}
    legs = {k+1: obj.name for k, (upper, _, obj) in enumerate([l for l in lofts if '.leg.' in l[0]])}
    data = suit.data
    count = len(data.vertices)
    points = [v.co.copy() for v in data.vertices]
    # Nearest source of the vertex's own shell: its pivot owns the vertex, or for a
    # limb loft the side of its hinge plane. The nearest H2a surface sets the tone.
    owners = []
    for bone, obj in fused:
        world = [obj.matrix_world @ v.co for v in obj.data.vertices]
        obj.data.calc_loop_triangles()
        owners.append((bone, obj.name, BVHTree.FromPolygons(world, [tuple(t.vertices) for t in obj.data.loop_triangles], all_triangles=True)))
    weights = np.zeros((count, len(BONES)))
    colours = np.zeros((count, 3))
    for i, p in enumerate(points):
        best = None
        shell = int(shells[i])
        for bone, name, tree in owners:
            if (shell == 0 and name in legs.values()) or (shell > 0 and name != legs[shell]):
                continue
            hit, _, _, distance = tree.find_nearest(p, .3)
            if hit is not None and (best is None or distance < best[0]):
                best = (distance, bone, name)
        _, bone, name = best
        loft_name = name
        if name in hinges:
            upper, lower, centre, up = hinges[name]
            bone = upper if (p-centre).dot(up) > 0 else lower
            # The arm's rounded top reaches over the shoulder; the trunk keeps the
            # trapezius slope medial of the shoulder pivot, inside the shoulder blend.
            shoulder, sign = at(upper), (1 if upper.startswith('right') else -1)
            if '.arm.' in upper and sign*(p.x-shoulder.x) < -.01 and shoulder.y-p.y < .05:
                bone = 'spine.roll'
        weights[i, BONES.index(bone)] = 1
        best = None
        for part_bone, name, tree in trees:
            hit, _, _, distance = tree.find_nearest(p, .2)
            if hit is not None and (best is None or distance < best[0]):
                best = (distance, part_bone, name)
        _, _, name = best
        side = 'left' if bone.startswith('left') else 'right' if bone.startswith('right') else ''
        colours[i] = tone(family, name, p-rest[bone], side, bone)
        if family == 'cairn' and loft_name in hinges:
            # Concept A's graphite elbow and knee inserts: a band about each hinge.
            upper, lower, centre, up = hinges[loft_name]
            if abs((p-centre).dot(up)) < (.03 if '.leg.' in upper else .024):
                colours[i] = TONES['cairn']['insert']
    around = neighbours(data)
    around = [np.array(a, dtype=int) for a in around]
    # Blend balls: the waist about the spine pivot, the shoulders, elbows and knees.
    centres = [(nodes['spine.yaw'].matrix_world.translation, BLENDS['spine.yaw'])]
    for side in ['left', 'right']:
        for joint in ['arm.roll', 'arm.elbow', 'leg.knee']:
            centres.append((nodes[f'{side}.{joint}'].matrix_world.translation, BLENDS[joint]))
    co = np.array([tuple(p) for p in points])
    active = np.zeros(count, dtype=bool)
    for centre, radius in centres:
        active |= np.linalg.norm(co-np.array(tuple(centre)), axis=1) < radius
    weights = diffuse(weights, around, active, 60 if not low else 30)
    colours = diffuse(colours, around, np.ones(count, dtype=bool), 1)
    # At most four influences, normalised.
    order = np.argsort(-weights, axis=1)[:, :4]
    for i in range(count):
        keep = order[i]
        kept = weights[i, keep]
        weights[i] = 0
        weights[i, keep] = kept/kept.sum()
    for b, bone in enumerate(BONES):
        group = suit.vertex_groups.new(name=bone.replace('.', '_'))
        for i in np.flatnonzero(weights[:, b] > 1e-4):
            group.add([int(i)], float(weights[i, b]), 'REPLACE')
    for side in ['left', 'right']:
        nodes[side+'.arm.roll'].rotation_euler[2] = 0
    bpy.context.view_layer.update()
    for i, vertex in enumerate(data.vertices):
        blend = sum((spread[bone]*float(weights[i, b]) for b, bone in enumerate(BONES) if weights[i, b] > 0), Matrix.Diagonal((0, 0, 0, 0)))
        vertex.co = blend.inverted() @ vertex.co
    data.update()
    attribute = data.attributes.new('tint', 'FLOAT_VECTOR', 'POINT')
    attribute.data.foreach_set('vector', colours.astype(np.float32).ravel())
    suit.data.materials.clear()
    suit.data.materials.append(MATERIALS[family+'Suit'])
    for polygon in suit.data.polygons:
        polygon.material_index = 0
    # The replaced parts go; slim closed cores keep the limb bone lines enclosed.
    for _, obj in source_parts(nodes, FUSED):
        bpy.data.objects.remove(obj, do_unlink=True)
    for _, _, obj in lofts:
        bpy.data.objects.remove(obj, do_unlink=True)
    return suit


def cores(nodes, family, form, low, loft, S):
    """Slim closed cores along each limb, inside the suit, in the suit's own colour.

    They keep every limb bone line enclosed in straight, halfway and folded poses
    (the closed-core contract) and stay well inside the suit at rest.
    """
    k = 1.08 if form == 'ii' else 1
    cover = family+'Cover'
    for side, sign in [('left', -1), ('right', 1)]:
        a, l = side+'.arm', side+'.leg'
        loft(nodes[a+'.yaw'], [S(.030, .016*k, .016*k), S(-.150, .015*k, .015*k), S(-.270, .013*k, .013*k)],
             cover, low, 8, 6, caps=(.01, .01), per=(1, 1), sign=sign, name='Upper arm under-suit', steps=1)
        loft(nodes[a+'.elbow'], [S(.022, .013*k, .013*k), S(-.120, .013*k, .012*k), S(-.250, .011*k, .010*k)],
             cover, low, 8, 6, caps=(.01, .008), per=(1, 1), sign=sign, name='Forearm under-suit', steps=1)
        loft(nodes[l+'.yaw'], [S(.012, .020*k, .020*k), S(-.200, .022*k, .022*k), S(-.410, .022*k, .022*k)],
             cover, low, 8, 6, caps=(.006, .01), per=(1, 1), sign=sign, name='Thigh under-suit', steps=1)
        loft(nodes[l+'.knee'], [S(.028, .021*k, .021*k), S(-.200, .017*k, .017*k), S(-.395, .014*k, .014*k)],
             cover, low, 8, 6, caps=(.01, .01), per=(1, 1), sign=sign, name='Shin under-suit', steps=1)


def sidecar(name):
    """Write the suit's weights and tones for compress.mjs, keyed by exported position."""
    out = ROOT/'artifacts/codex-style/authored'
    out.mkdir(parents=True, exist_ok=True)
    path = out/(name+'.skin.json')
    suit = bpy.data.objects.get('Suit')
    if suit is None:
        path.unlink(missing_ok=True)
        return
    data = suit.data
    groups = [g.name for g in suit.vertex_groups]
    tint = np.zeros(len(data.vertices)*3, dtype=np.float32)
    data.attributes['tint'].data.foreach_get('vector', tint)
    rows = []
    for v in data.vertices:
        influences = sorted(((g.weight, g.group) for g in v.groups if g.weight > 1e-4), reverse=True)[:4]
        rows.append([[float(c) for c in v.co], [g for _, g in influences], [round(w, 6) for w, _ in influences],
                     [round(float(c), 5) for c in tint[v.index*3:v.index*3+3]]])
    path.write_text(json.dumps({'mesh': 'Suit', 'joints': groups, 'vertices': rows}))


class Blend:
    """The suit's rest geometry and weights, posed by linear blending as the GPU does."""

    def __init__(self, suit, nodes):
        data = suit.data
        self.suit, self.data = suit, data
        self.bones = [nodes[g.name.replace('_', '.')] for g in suit.vertex_groups]
        self.names = [g.name.replace('_', '.') for g in suit.vertex_groups]
        self.weights = np.zeros((len(data.vertices), len(self.bones)))
        for v in data.vertices:
            for g in v.groups:
                self.weights[v.index, g.group] = g.weight
        self.owner = np.argmax(self.weights, axis=1)
        self.inverse = [np.array(bone.matrix_world.inverted()) for bone in self.bones]
        self.rest_matrix = [np.array(bone.matrix_world) for bone in self.bones]
        data.calc_loop_triangles()
        self.triangles = [tuple(t.vertices) for t in data.loop_triangles]
        self.tri_owner = np.argmax(self.weights[np.array(self.triangles)].sum(axis=1), axis=1)

    def rest(self):
        return np.array([(*v.co, 1) for v in self.data.vertices])

    def matrices(self):
        return [np.array(bone.matrix_world) @ self.inverse[b] for b, bone in enumerate(self.bones)]

    def pose(self, rest, matrices):
        out = np.zeros((len(rest), 3))
        for b, m in enumerate(matrices):
            out += self.weights[:, b, None]*(rest @ m.T)[:, :3]
        return out

    def point(self, index, co, matrices):
        p = np.array((*co, 1))
        return Vector(sum(self.weights[index, b]*(m @ p)[:3] for b, m in enumerate(matrices) if self.weights[index, b] > 0))


def anchor(name, centre, p):
    """Where a buried suit vertex gives way, as in clear_sweeps: the pelvis toward a
    point above the hip line, the thorax and limbs toward their long axes."""
    if name == 'pelvis':
        return Vector((0, centre.y+.09, centre.z+.005))
    if name == 'spine.roll':
        return Vector((0, p.y, centre.z+.005))
    return Vector((centre.x, p.y, centre.z))


def relieve(suit, nodes, pairs, rigid, samples=33, step=.002, passes=28):
    """Recess the suit at rest only where an audited pose makes it cross itself or a cover.

    The skinned counterpart of clear_sweeps, driven by the crossings the audit
    measures. Each audited axis is sampled through its limits and the suit is
    blended at each sample; where its region on the moving pivot crosses its region
    on the stationary pivot, or either crosses the other pivot's rigid covers,
    outside the joint's bearing, the crossing triangles' vertices step a little
    toward their own pivot's axis (against the trunk, only the moving side's). The step is spread over the neighbouring rings
    with the stepped vertices held at their depth, so each give stays one smooth
    recess rather than a crumple, and the axes that still cross are sampled again.
    """
    blend = Blend(suit, nodes)
    data = suit.data
    around = [np.array(a, dtype=int) for a in neighbours(data)]
    triangles = np.array(blend.triangles)
    active = list(pairs)
    stepped = 0
    for attempt in range(passes):
        rest = blend.rest()
        hits = set()
        crossing = []
        for pair in active:
            hinge, leaf, stationary, axis, limits, radius = pair
            names = [n.name.replace('_', '.') for n in (leaf, stationary)]
            regions = [blend.names.index(n) if n in blend.names else None for n in names]
            if regions == [None, None]:
                continue
            faces = [triangles[blend.tri_owner == r] if r is not None else None for r in regions]
            covers = [[o for o in node.children if o.type == 'MESH' and rigid(o)] for node in (leaf, stationary)]
            found = False
            for k in range(samples):
                hinge.rotation_euler[axis] = math.radians(limits[0]+(limits[1]-limits[0])*k/(samples-1))
                bpy.context.view_layer.update()
                posed = blend.pose(rest, blend.matrices())
                points = posed.tolist()
                centre = np.array(tuple(hinge.matrix_world.translation))
                trees = [BVHTree.FromPolygons(points, f.tolist(), all_triangles=True) if f is not None else None for f in faces]
                rigid_trees = []
                for side in covers:
                    built = []
                    for o in side:
                        o.data.calc_loop_triangles()
                        built.append(BVHTree.FromPolygons([o.matrix_world @ v.co for v in o.data.vertices],
                                                          [tuple(t.vertices) for t in o.data.loop_triangles], all_triangles=True))
                    rigid_trees.append(built)

                def outside(tri):
                    return np.linalg.norm(posed[tri]-centre, axis=1).max() > radius-.008
                if trees[0] is not None and trees[1] is not None:
                    for a, b in trees[0].overlap(trees[1]):
                        ta, tb = faces[0][a], faces[1][b]
                        if set(ta) & set(tb) or not (outside(ta) or outside(tb)):
                            continue
                        # Both sides of a limb fold give way; against the trunk only the
                        # moving region does, so the trunk keeps its waist and chest.
                        hits.update(int(i) for i in ta)
                        if names[1] not in ('spine.roll', 'pelvis'):
                            hits.update(int(i) for i in tb)
                        found = True
                # Each suit region against the other pivot's rigid covers.
                for own, other in [(0, 1), (1, 0)]:
                    if trees[own] is None:
                        continue
                    for cover in rigid_trees[other]:
                        for a, _ in trees[own].overlap(cover):
                            ta = faces[own][a]
                            if outside(ta):
                                hits.update(int(i) for i in ta)
                                found = True
            hinge.rotation_euler[axis] = 0
            bpy.context.view_layer.update()
            if found:
                crossing.append(pair)
        print('suit relief pass', attempt, 'vertices', len(hits), 'axes', [p[0].name for p in crossing][:4])
        if not hits:
            break
        active = crossing
        stepped += len(hits)
        # Later passes take longer steps: what still crosses needs to go further.
        step = .002*(1+attempt*.25)
        co = rest[:, :3].copy()
        start = co.copy()
        direction = {}
        for i in hits:
            name = blend.names[blend.owner[i]]
            target = anchor(name, Vector(blend.rest_matrix[blend.owner[i]][:3, 3]), Vector(co[i]))
            d = np.array(tuple(target))-co[i]
            length = np.linalg.norm(d)
            if length > 1e-6:
                direction[i] = d/length
                co[i] += direction[i]*min(step, length*.5)
        region = set(hits)
        for _ in range(3):
            region |= {int(j) for i in list(region) for j in around[i]}
        for _ in range(6):
            nxt = co.copy()
            for i in region:
                nxt[i] = co[i]*.5+co[around[i]].mean(axis=0)*.5
            for i, u in direction.items():
                need = min(step, np.linalg.norm(np.array(tuple(anchor(blend.names[blend.owner[i]], Vector(blend.rest_matrix[blend.owner[i]][:3, 3]), Vector(start[i]))))-start[i])*.5)
                depth = (nxt[i]-start[i]) @ u
                if depth < need:
                    nxt[i] += (need-depth)*u
            co = nxt
        for i in region:
            data.vertices[i].co = co[i]
        data.update()
    untangle(suit, around)
    return stepped


def untangle(suit, around, rounds=12):
    """Smooth away any fold a recess left at rest: triangles that cross without sharing a
    vertex, or that face against their own smooth corner normals."""
    data = suit.data
    for _ in range(rounds):
        data.calc_loop_triangles()
        tris = [tuple(t.vertices) for t in data.loop_triangles]
        co = [v.co.copy() for v in data.vertices]
        tree = BVHTree.FromPolygons(co, tris, all_triangles=True)
        crossed = {i for a, b in tree.overlap(tree) if not set(tris[a]) & set(tris[b]) for i in tris[a]+tris[b]}
        for t in data.loop_triangles:
            if t.normal.dot(sum((data.vertices[i].normal for i in t.vertices), Vector())) < .05:
                crossed.update(t.vertices)
        if not crossed:
            return
        region = set(crossed)
        region |= {int(j) for i in crossed for j in around[i]}
        points = np.array([tuple(c) for c in co])
        for i in region:
            data.vertices[i].co = Vector(points[i]*.5+points[around[i]].mean(axis=0)*.5)
        data.update()
    print('suit folds left at rest', len(crossed))
