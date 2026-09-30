"""Cairn, Rill and Hush: original continuous soft covers and two body forms.

Metres, Y up. Both LODs retain the named joint and three-phalange tendon frames.
Existing Keel/Morrow geometry and finishes are unchanged.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from humanoids import joint_tree
from humanoid_surfaces import anatomy, ball as base_ball
from humanoid_clearance import machine_openings

NAMES = ['cairn', 'rill', 'hush']
FORMS = [f'{name}-{form}' for name in NAMES for form in ['i', 'ii']]

def ball(*args, **kwargs):
    obj = base_ball(*args, **kwargs)
    obj['softBearing'] = True
    if len(args) > 1 and args[1] >= .045:
        obj['clearanceProtected'] = True
    return obj


def sleeve(parent, radius, length, at):
    """A closed core must survive simplification even beside a deep folding cut."""
    obj = cylinder(parent, radius, length, at, 'softCore', segments=12)
    obj['clearanceProtected'] = True
    return obj


def soft_normals():
    """Smooth the outer cover while the socket boundaries retain split normals."""
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH' and obj.get('machined'):
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.dissolve_limit(bm, angle_limit=.03, use_dissolve_boundaries=False,
                                    verts=list(bm.verts), edges=list(bm.edges), delimit={'NORMAL'})
            bmesh.ops.triangulate(bm, faces=list(bm.faces))
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(obj.data)
            bm.free()
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
            obj.data.normals_split_custom_set([(0, 0, 0)]*len(obj.data.loops))
            obj.data.set_sharp_from_angle(angle=math.radians(35))


def trim_waist(scale):
    """Keep the upper stationary waist inside the existing spine bearing envelope."""
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not obj.get('softWaistBridge'):
            continue
        for vertex in obj.data.vertices:
            if vertex.co.y <= .060*scale:
                continue
            dy = vertex.co.y-.120*scale
            radius = math.sqrt(max(0, (.103*scale)**2-dy*dy))
            length = math.hypot(vertex.co.x, vertex.co.z)
            if length > radius:
                vertex.co.x *= radius/length
                vertex.co.z *= radius/length
        obj.data.update()


def soft_finishes():
    """Linear colours and tiers match soft-materials.ts, including the phone path."""
    definitions = {
        'cairnCover': ((.43, .40, .34), .02, .86),
        'rillCover': ((.18, .195, .20), .01, .94),
        'hushCover': ((.035, .043, .045), .01, .94),
        'softCore': ((.012, .017, .018), .02, .92),
        'softGraphite': ((.026, .030, .032), .50, .54),
        'softGlass': ((.010, .021, .024), .18, .30),
        'softSignal': ((.56, 1, .035), .0, .65),
        'softAccent': ((.56, 1, .035), .0, .65),
    }
    for name, (colour, metal, rough) in definitions.items():
        material = bpy.data.materials.new(name)
        MATERIALS[name] = material
        material.diffuse_color = (*colour, 1)
        material.use_nodes = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value = (*colour, 1)
        shader.inputs['Metallic'].default_value = metal
        shader.inputs['Roughness'].default_value = rough
        shader.inputs['Coat Weight'].default_value = 0
        if name.endswith('Cover'):
            shader.inputs['Sheen Weight'].default_value = .06 if name == 'cairnCover' else .18
            shader.inputs['Sheen Roughness'].default_value = .85
            shader.inputs['Sheen Tint'].default_value = (*colour, 1)
            noise = material.node_tree.nodes.new('ShaderNodeTexNoise')
            noise.inputs['Scale'].default_value = 240 if name == 'cairnCover' else 160
            bump = material.node_tree.nodes.new('ShaderNodeBump')
            bump.inputs['Strength'].default_value = .12
            bump.inputs['Distance'].default_value = .0004
            material.node_tree.links.new(noise.outputs['Fac'], bump.inputs['Height'])
            material.node_tree.links.new(bump.outputs['Normal'], shader.inputs['Normal'])
        if name in ['softSignal', 'softAccent']:
            shader.inputs['Emission Color'].default_value = (*colour, 1)
            shader.inputs['Emission Strength'].default_value = 1.6


def soft_sheen():
    """Knit sheen follows its base tint, matching the runtime's material tier."""
    for material in bpy.data.materials:
        if material.name.endswith('Cover') and material.use_nodes:
            shader = material.node_tree.nodes.get('Principled BSDF')
            shader.inputs['Sheen Tint'].default_value = shader.inputs['Base Color'].default_value


def face_z(x, y, lift=0):
    return .008-.093*math.sqrt(max(.01, 1-(x/.094)**2-((y-.165)/.125)**2))-lift


def patch(head, cx, cy, w, h, material, low, power=1, lift=.001):
    """A continuous curved superellipse on the front of the rounded head."""
    count, rings = (24, 6) if low else (40, 10)
    vertices = [(cx, cy, face_z(cx, cy, lift))]
    for r in range(1, rings+1):
        for i in range(count):
            angle = math.tau*i/count
            x, y = math.cos(angle), math.sin(angle)
            x = cx+w*math.copysign(abs(x)**power, x)*r/rings
            y = cy+h*math.copysign(abs(y)**power, y)*r/rings
            vertices.append((x, y, face_z(x, y, lift)))
    faces = [(0, 1+(i+1)%count, 1+i) for i in range(count)]
    for r in range(rings-1):
        for i in range(count):
            a, b = 1+r*count+i, 1+r*count+(i+1)%count
            faces.append((a, a+count, b+count, b))
    obj = mesh('Curved face' if material == 'softGlass' else 'Face signature', vertices, faces, head, material)
    obj['clearanceProtected'] = True
    return obj


def visor_welt(head, low):
    """A rounded knit lip stands above Hush's recessed glass and light signature."""
    count = 24 if low else 40
    vertices = []
    for w, h, lift in [(.0722, .0392, .0030), (.0755, .0430, .0045), (.079, .0465, .001)]:
        for i in range(count):
            angle = math.tau*i/count
            x = w*math.copysign(abs(math.cos(angle))**.48, math.cos(angle))
            y = .196+h*math.copysign(abs(math.sin(angle))**.48, math.sin(angle))
            vertices.append((x, y, face_z(x, y, lift)))
    faces = []
    for ring in range(2):
        for i in range(count):
            a, b = ring*count+i, ring*count+(i+1)%count
            faces.append((a, b, b+count, a+count))
    obj = mesh('Sculpted knit visor lip', vertices, faces, head, 'hushCover')
    obj['clearanceProtected'] = True
    obj['softBearing'] = True
    obj['visorWelt'] = True
    return obj


def digit(parent, length, width, cover, low, at=(0, 0, 0)):
    """Small elliptical phalanges have their own modest tessellation budget."""
    count = 6 if low else 8
    sections = [(.003, width*.45, .009), (-length*.25, width*.52, .011),
                (-length*.72, width*.47, .010), (-length, width*.38, .008)]
    vertices = [(w*math.cos(i*math.tau/count), y, d*math.sin(i*math.tau/count))
                for y, w, d in sections for i in range(count)]
    faces = [tuple(reversed(range(count))), tuple(range(3*count, 4*count))]
    for ring in range(3):
        for i in range(count):
            a, b = ring*count+i, ring*count+(i+1)%count
            faces.append((a, b, b+count, a+count))
    obj = mesh('Soft phalange', vertices, faces, parent, cover, at)
    obj['clearanceProtected'] = True
    return obj


def hand(wrist, name, cover, low):
    """Four separated digits and an opposable thumb on the existing tendon frames."""
    existing = set(bpy.context.scene.objects)
    ball(wrist, .033, low=True, material='softCore', scale=(1, 1.2, .9))
    anatomy(wrist, [(.012, .027, .023, 0), (-.026, .043, .028, -.001),
                   (-.069, .044, .025, -.005), (-.086, .040, .019, -.010)], cover, True)
    first = pivot(name+'_fingers', wrist, (0, -.08, -.022))
    second = pivot(name+'_tips', first, (0, -.035, 0))
    third = pivot(name+'_distal', second, (0, -.029, 0))
    for i in range(4):
        x = (i-1.5)*.021
        for frame, length, width in [(first, .035, .018), (second, .029, .017), (third, .029, .015)]:
            if frame == first:
                bpy.ops.mesh.primitive_uv_sphere_add(segments=4 if low else 8, ring_count=3 if low else 4, radius=.009)
                finish(bpy.context.object, frame, 'softCore', (x, 0, 0))
            digit(frame, length, width, cover, low, (x, 0, 0))
    sign = -1 if name.startswith('left') else 1
    thumb = pivot(name+'_thumb', wrist, (sign*.041, -.037, .002))
    thumb.rotation_euler.z = sign*.55
    digit(thumb, .05, .030, cover, low)
    tip = pivot(name+'_thumb_tip', thumb, (0, -.05, -.003))
    digit(tip, .028, .023, cover, low)
    for obj in set(bpy.context.scene.objects)-existing:
        if obj.type == 'MESH':
            obj['clearanceProtected'] = True


def shoe(foot, cover):
    existing = set(bpy.context.scene.objects)
    ball(foot, .045, low=True, material='softCore')
    anatomy(foot, [(.028, .029, .031, 0), (-.014, .051, .066, -.029),
                   (-.051, .062, .120, -.046), (-.075, .058, .116, -.045)], cover, True)
    anatomy(foot, [(-.068, .059, .117, -.045), (-.080, .058, .116, -.045)], 'softGraphite', True)
    for obj in set(bpy.context.scene.objects)-existing:
        if obj.type == 'MESH':
            obj['clearanceProtected'] = True


def finish_cached(name, low):
    """Refresh independent small-part budgets without repeating the swept cuts."""
    MATERIALS.clear()
    MATERIALS.update({material.name: material for material in bpy.data.materials})
    scale = 1.73/1.8 if name.endswith('-i') else 1
    cover = name.split('-')[0]+'Cover'
    for side in ['left', 'right']:
        wrist = bpy.data.objects[side+'_arm_wrist_yaw']
        foot = bpy.data.objects[side+'_leg_ankle_roll']
        for root in [wrist, foot]:
            for obj in list(root.children_recursive):
                bpy.data.objects.remove(obj, do_unlink=True)
        existing = set(bpy.context.scene.objects)
        hand(wrist, side+'_arm', cover, low)
        shoe(foot, cover)
        for obj in set(bpy.context.scene.objects)-existing:
            obj.location *= scale
            if obj.type == 'MESH':
                for vertex in obj.data.vertices:
                    vertex.co *= scale
    soft_normals()
    trim_waist(scale)
    if name.startswith('hush-'):
        for obj in list(bpy.context.scene.objects):
            if obj.get('visorWelt'):
                bpy.data.objects.remove(obj, do_unlink=True)
        welt = visor_welt(bpy.data.objects['head_pitch'], low)
        for vertex in welt.data.vertices:
            vertex.co *= scale


def build_soft(name, low=False, clear=True):
    family, form = name.split('-')
    assert family in NAMES and form in ['i', 'ii']
    male = form == 'ii'
    scale = 1 if male else 1.73/1.8
    if clear:
        reset()
        soft_finishes()
    existing = set(bpy.context.scene.objects)
    cover = family+'Cover'
    nodes = joint_tree()
    for side, sign in [('left', -1), ('right', 1)]:
        nodes[side+'.arm.roll'].location.x = sign*(.26 if male else .225)
        nodes[side+'.leg.roll'].location.x = sign*(.15 if male else .18)
    torso, pelvis = nodes['spine.roll'], nodes['pelvis']
    # A narrow crotch and tapered waist meet the hip bearings within their envelope.
    # This continuous bridge is audited with the exterior covers, not hidden as core.
    bridge = anatomy(pelvis, [(-.028, .086, .063, .006), (0, .143 if male else .170, .068, .003),
                             (.040, .134 if male else .160, .075, 0), (.105, .070, .060, 0),
                             (.135, .060, .060, 0)], cover, low)
    bridge['clearanceProtected'] = True
    bridge['softWaistBridge'] = True
    ball(torso, .083, low=low, material=cover, scale=(1, 1.15, 1))
    anatomy(torso, [(-.045, .080, .065, .005), (-.025, .110 if male else .100, .081, .003),
                    (.080, .142 if male else .121, .090, 0), (.190, .189 if male else .169, .102, -.003),
                    (.287, .218 if male else .187, .109 if male else .117, -.008 if male else -.016),
                    (.369, .216 if male else .183, .092, .001), (.417, .103, .065, .014)], cover, low)
    # A closed inner sleeve spans every folding seam without a hollow limb core.
    anatomy(torso, [(-.13, .072, .063, .01), (.1, .086, .071, .005), (.41, .067, .047, .015)], 'softCore', low)
    neck = nodes['head.yaw']
    shaft = cylinder(neck, .041, .128, (0, -.014, .010), 'softGraphite', segments=16 if low else 24)
    shaft['clearanceProtected'] = True
    collar = anatomy(torso, [(.388, .081, .061, .01), (.436, .065, .054, .01), (.481, .057, .049, .009)], 'softCore', low)
    collar['clearanceProtected'] = True
    head = nodes['head.pitch']
    if family == 'hush':
        hood = anatomy(head, [(-.047, .044, .040, .010), (.008, .060, .051, .009),
                             (.064, .061, .055, .008)], cover, low)
        hood['clearanceProtected'] = True
        hood['softBearing'] = True
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24 if low else 48, ring_count=16 if low else 28, radius=1)
    shell = finish(bpy.context.object, head, cover if family != 'rill' else 'softGraphite', (0, .165, .008))
    for vertex in shell.data.vertices:
        vertex.co.x *= .094
        vertex.co.y *= .125
        vertex.co.z *= .093
    shell['clearanceProtected'] = True
    if family == 'cairn':
        patch(head, 0, .167, .070, .087, 'softGlass', low)
    elif family == 'rill':
        patch(head, 0, .167, .078, .093, 'softGlass', low, .78)
    else:
        patch(head, 0, .196, .072, .039, 'softGlass', low, .48, .0015)
        visor_welt(head, low)
    eye_y = .196 if family == 'hush' else .185
    if family == 'rill':
        patch(head, 0, eye_y, .065, .0018, 'softSignal', low, .5, .0023)
    else:
        for x in [-.027, .027]:
            patch(head, x, eye_y, .012, .0038, 'softSignal', low, .5, .0023)
    if family == 'cairn':
        ball(torso, .0018, (-.044, .341, -.122), True, 'softAccent', (4, 1, 1))
    for side, sign in [('left', -1), ('right', 1)]:
        a, l = side+'.arm', side+'.leg'
        shoulder = nodes[a+'.yaw']
        ball(shoulder, .077, low=low, material=cover)
        anatomy(shoulder, [(.025, .044, .047, .003), (-.011, .086 if male else .077, .075, .003),
                          (-.079, .079 if male else .067, .067, 0), (-.170, .052, .048, .005),
                          (-.269, .038, .031, .008)], cover, low)
        sleeve(shoulder, .025, .240, (0, -.148, .005))
        elbow = nodes[a+'.elbow']
        ball(elbow, .049, low=low, material=cover)
        anatomy(elbow, [(.014, .038, .030, .006), (-.043, .058, .047, .008),
                       (-.118, .054, .047, .012), (-.200, .037, .030, .009),
                       (-.248, .029, .024, .004)], cover, low)
        sleeve(elbow, .023, .249, (0, -.129, .003))
        hand(nodes[a+'.wrist.yaw'], a.replace('.', '_'), cover, low)
        thigh = nodes[l+'.yaw']
        ball(thigh, .076, low=low, material=cover)
        anatomy(thigh, [(.021, .068, .065, 0), (-.057, .087 if male else .094, .090, -.006),
                       (-.159, .083 if male else .092, .082, -.010), (-.283, .061, .054, -.004),
                       (-.403, .045, .036, 0)], cover, low)
        sleeve(thigh, .030, .426, (0, -.219, 0))
        knee = nodes[l+'.knee']
        ball(knee, .064, low=low, material=cover)
        anatomy(knee, [(.019, .043, .033, -.003), (-.042, .057, .054, -.001),
                      (-.136, .065, .065, .014), (-.232, .051, .052, .014),
                      (-.387, .030, .029, .002)], cover, low)
        sleeve(knee, .026, .396, (0, -.206, .004))
        foot = nodes[l+'.ankle.roll']
        shoe(foot, cover)
    if '--uncut' not in sys.argv:
        for obj in set(bpy.context.scene.objects)-existing:
            if obj.type != 'MESH':
                continue
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.triangulate(bm, faces=list(bm.faces))
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(obj.data)
            bm.free()
            obj.data.update()
        machine_openings(nodes, False, False, material=cover, extended=True)
    parts = [obj for obj in set(bpy.context.scene.objects)-existing if obj.type == 'MESH']
    for obj in parts:
        if obj.get('machined'):
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.triangulate(bm, faces=list(bm.faces))
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=.00003)
            bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=.00003)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(obj.data)
            bm.free()
            obj.data.normals_split_custom_set([(0, 0, 0)]*len(obj.data.loops))
            obj.data.set_sharp_from_angle(angle=math.radians(35))
    soft_normals()
    trim_waist(1)
    def triangles(obj):
        obj.data.calc_loop_triangles()
        return len(obj.data.loop_triangles)
    def protected(obj):
        return obj.get('clearanceProtected') or (obj.get('machined') and not low)
    fixed = sum(triangles(obj) for obj in parts if protected(obj))
    other = sum(triangles(obj) for obj in parts if not protected(obj))
    ratio = min(1, max(.02, ((9850 if low else 23800)-fixed)/max(1, other)))
    for obj in parts:
        if protected(obj) or ratio >= 1:
            continue
        mod = obj.modifiers.new('Soft cover tessellation', 'DECIMATE')
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        apply(obj)
    if scale != 1:
        for obj in set(bpy.context.scene.objects)-existing:
            obj.location *= scale
            if obj.type == 'MESH':
                for vertex in obj.data.vertices:
                    vertex.co *= scale
    return nodes


if __name__ == '__main__':
    selected = sys.argv[sys.argv.index('--only')+1] if '--only' in sys.argv else None
    for name in FORMS:
        if selected and name != selected:
            continue
        if '--start-from' in sys.argv and FORMS.index(name) < FORMS.index(sys.argv[sys.argv.index('--start-from')+1]):
            continue
        for low in [False, True]:
            if '--material-cache' in sys.argv:
                bpy.ops.wm.open_mainfile(filepath=str(ROOT/'artifacts/humanoid-third/build/source'/f'{name}{"-lod" if low else ""}.blend'))
                soft_sheen()
            elif '--finish-cache' in sys.argv:
                bpy.ops.wm.open_mainfile(filepath=str(ROOT/'artifacts/humanoid-third/build/source'/f'{name}{"-lod" if low else ""}.blend'))
                finish_cached(name, low)
            else:
                build_soft(name, low)
            if '--cache' in sys.argv:
                directory = ROOT/'artifacts/humanoid-third/build/source'
                directory.mkdir(parents=True, exist_ok=True)
                bpy.ops.wm.save_as_mainfile(filepath=str(directory/f'{name}{"-lod" if low else ""}.blend'))
            export(name+('-lod' if low else ''), repair_normals=True, position_bits=24)
