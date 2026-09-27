"""Original ob.Pal surfaces. Coordinates are metres, Y up, matching the live rigs.

Headless only. Every authoring script exports an intermediate GLB and runs the
meshopt encoder; no downloaded geometry or textures are used.
"""
import bpy
import bmesh
import math
import subprocess
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
MATERIALS = {}
DETAIL = .0005
HOUSING = .002
SEAM = .0015


def outline(w, h, clip=.18, taper=0):
    """Clipped rectangle, with a narrower nose along local negative Y."""
    return [(-w*(.5-clip)*(1-taper),-h/2), (w*(.5-clip)*(1-taper),-h/2),
            (w*.5*(1-taper),-h*(.5-clip)), (w*.5,h*(.5-clip)),
            (w*(.5-clip),h/2), (-w*(.5-clip),h/2),
            (-w*.5,h*(.5-clip)), (-w*.5*(1-taper),-h*(.5-clip))]


def inset_outline(points, distance):
    """Offset a convex CCW polygon by a physical distance, not a scale factor."""
    result = []
    for i,p in enumerate(points):
        a,b,c = Vector(points[i-1]),Vector(p),Vector(points[(i+1)%len(points)])
        u,v = (b-a).normalized(),(c-b).normalized()
        n,m = Vector((-u.y,u.x)),Vector((-v.y,v.x))
        bisector = (n+m).normalized()
        result.append(tuple(b+bisector*(distance/bisector.dot(n))))
    return result


def hard_mesh(name, points, faces, parent, material, at, axis, edge):
    if axis == 'z':
        points = [(x,z,y) for x,y,z in points]
        faces = [tuple(reversed(f)) for f in faces]
    o = mesh(name,points,faces,parent,material,at)
    # Flat facets meet a real 45-degree chamfer; smooth normals cannot inflate them.
    for p in o.data.polygons: p.use_smooth = False
    bevel(o,edge,1)
    return o


def plate(parent, size, at, material='gunmetal', axis='y', taper=0, shoulder=0, edge=DETAIL):
    """Purpose-shaped enclosure: planar top, tapered sides, clipped corners."""
    w,h,d = size
    base = outline(w,h,taper=taper)
    top = inset_outline(base,shoulder) if shoulder else base
    vertices = [(x,y,-d/2) for x,y in base]+[(x,y,d/2) for x,y in top]
    n=len(base)
    faces = [tuple(reversed(range(n))),tuple(range(n,n*2))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return hard_mesh('Faceted component housing',vertices,faces,parent,material,at,axis,edge)


def service(parent, size, at, axis='y', material='ceramic', frame='darkTitanium'):
    """A flush access inset with a metal border and a 1.5 mm Carbon seam."""
    w,h = size
    outer = outline(w,h)
    inner = inset_outline(outer,.004)
    insert = inset_outline(inner,SEAM)
    n=len(outer)
    vertices=[(x,y,z) for z in [-.003,.003] for ring in [outer,inner] for x,y in ring]
    faces=[]
    for i in range(n):
        j=(i+1)%n
        faces += [(i,j,2*n+j,2*n+i),(n+j,n+i,3*n+i,3*n+j),
                  (2*n+i,2*n+j,3*n+j,3*n+i),(j,i,n+i,n+j)]
    hard_mesh('Access panel metal frame',vertices,faces,parent,frame,at,axis,DETAIL)
    # The backing also forms the hidden tongue beneath the surrounding frame.
    plate(parent,(w-.002,h-.002,.004),at,'carbon',axis,edge=DETAIL)
    vertices=[(x,y,z) for z in [0,.003] for x,y in insert]
    faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return hard_mesh('Flush ceramic access insert',vertices,faces,parent,material,at,axis,DETAIL)


def status_slit(parent, cover, width, length, at):
    """Cut a real status recess into a horizontal cover; light stays 1 mm below it."""
    x,y,z=at
    cutter=block(parent,(width+2*SEAM,.008,length+2*SEAM),(x,y+.002,z),'carbon',DETAIL)
    mod=cover.modifiers.new('Recessed status aperture','BOOLEAN')
    mod.operation='DIFFERENCE'; mod.solver='EXACT'; mod.object=cutter
    apply(cover)
    bpy.data.objects.remove(cutter,do_unlink=True)
    block(parent,(width+2*SEAM,.001,length+2*SEAM),(x,y-.002,z),'carbon',DETAIL)
    block(parent,(width,.001,length),(x,y-.0015,z),'lime',DETAIL)


def reset():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for name, color in {'ceramic': (.83, .82, .77), 'warmShell': (.40, .41, .38),
                        'titanium': (.26, .30, .32), 'polished': (.55, .60, .62),
                        'darkTitanium': (.12, .15, .17), 'gunmetal': (.045, .060, .068),
                        'carbon': (.014, .020, .022), 'optic': (.01, .025, .03),
                        'lime': (.56, 1, .035), 'owner': (.56, 1, .035),
                        'rotor': (.26, .30, .32), 'head': (.8, .85, .9),
                        'tail': (.3, .01, .02)}.items():
        m = bpy.data.materials.new(name)
        m.diffuse_color = (*color, 1)
        MATERIALS[name] = m


def pivot(name, parent=None, at=(0, 0, 0)):
    o = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(o)
    o.parent = parent
    o.location = at
    return o


def finish(o, parent, material, at=(0, 0, 0)):
    o.parent = parent
    o.location = at
    o.data.materials.append(MATERIALS[material])
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def apply(o):
    bpy.context.view_layer.objects.active = o
    for mod in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def mesh(name, vertices, faces, parent, material, at=(0, 0, 0)):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    o = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(o)
    return finish(o, parent, material, at)


def bevel(o, width, segments=2):
    mod = o.modifiers.new('Machined edge', 'BEVEL')
    mod.width = width
    mod.segments = segments
    apply(o)


def block(parent, size, at, material='carbon', edge=.002):
    bpy.ops.mesh.primitive_cube_add()
    o = bpy.context.object
    o.name = 'Bevelled housing'
    o.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(o, parent, material, at)
    bevel(o, min(edge, min(size) * .5), 1)
    mod = o.modifiers.new('Face normals', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    apply(o)
    return o


def sector(parent, radius, height, at, start, span, material='darkTitanium', axis='y', segments=6):
    """A hollow turbine or bearing armour segment, with a recessed trailing lip."""
    profile = [(radius-.006,-height/2),(radius-.001,-height/2),(radius+.001,-height*.3),
               (radius+.001,height*.20),(radius-.002,height/2),(radius-.007,height/2),
               (radius-.008,height*.22),(radius-.006,-height/2)]
    vertices = []
    for r,y in profile:
        for i in range(segments+1):
            a = start+span*i/segments
            p = (r*math.cos(a),y,r*math.sin(a))
            vertices.append(p if axis == 'y' else (p[0],p[2],p[1]))
    stride = segments+1
    faces = [(j*stride+i,j*stride+i+1,(j+1)*stride+i+1,(j+1)*stride+i) for j in range(len(profile)-1) for i in range(segments)]
    if axis == 'y': faces = [tuple(reversed(face)) for face in faces]
    caps = [tuple(j*stride for j in reversed(range(len(profile)-1))),tuple(j*stride+segments for j in range(len(profile)-1))]
    faces += [tuple(reversed(face)) for face in caps] if axis == 'z' else caps
    o = mesh('Segmented mechanism guard',vertices,faces,parent,material,at)
    # The profile already contains the lip chamfers. Keep the radial cuts crisp
    # without spending another bevel on every short sector boundary.
    for p in o.data.polygons[-2:]: p.use_smooth = False
    turned_normals(o,profile,segments,axis,stride,start,span/segments)
    return o


def lathe(parent, profile, at=(0, 0, 0), material='titanium', axis='y', segments=48):
    verts = []
    for r, y in profile:
        for i in range(segments):
            a = i * 2 * math.pi / segments
            p = (r * math.cos(a), y, r * math.sin(a))
            verts.append(p if axis == 'y' else (p[0], p[2], p[1]))
    faces = []
    for j in range(len(profile) - 1):
        for i in range(segments):
            a, b = j * segments + i, j * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    if axis == 'y': faces = [tuple(reversed(face)) for face in faces]
    o = mesh('Turned mechanism', verts, faces, parent, material, at)
    turned_normals(o,profile,segments,axis,segments,0,2*math.pi/segments)
    return o


def turned_normals(o, profile, segments, axis, stride, start, step):
    """Smooth around the spindle, crisp across each machined profile transition."""
    normals=[None]*len(o.data.loops)
    for p in o.data.polygons:
        section=p.index//segments
        for loop in p.loop_indices:
            if section >= len(profile)-1:
                normal=p.normal.copy()
            else:
                dr=profile[section+1][0]-profile[section][0]
                dy=profile[section+1][1]-profile[section][1]
                a=start+(o.data.loops[loop].vertex_index%stride)*step
                normal=Vector((dy*math.cos(a),-dr,dy*math.sin(a))).normalized()
                if axis=='z': normal=Vector((normal.x,normal.z,normal.y))
            normals[loop]=normal
    o.data.normals_split_custom_set(normals)


def cylinder(parent, r, h, at=(0, 0, 0), material='titanium', axis='y', segments=24):
    e = DETAIL if h < .02 or r < .025 else HOUSING
    return lathe(parent, [(0, -h/2), (r-e, -h/2), (r, -h/2+e), (r, h/2-e), (r-e, h/2), (0, h/2)], at, material, axis, segments)


def ring(parent, radius, tube, at=(0, 0, 0), material='polished', axis='z', segments=48):
    profile = [(radius + tube * math.cos(i * math.pi / 3), tube * math.sin(i * math.pi / 3)) for i in range(7)]
    return lathe(parent, profile, at, material, axis, segments)


def cable(parent, points, radius=.002, material='carbon'):
    data = bpy.data.curves.new('Flexible loom', 'CURVE')
    data.dimensions = '3D'
    data.resolution_u = 2 if len(points) > 10 else 8
    data.bevel_depth = radius
    data.bevel_resolution = 1 if len(points) > 10 else 2
    curve = data.splines.new('BEZIER')
    curve.bezier_points.add(len(points) - 1)
    for p, xyz in zip(curve.bezier_points, points):
        p.co = xyz
        p.handle_left_type = p.handle_right_type = 'AUTO'
    o = bpy.data.objects.new('Flexible loom', data)
    bpy.context.collection.objects.link(o)
    o.parent = parent
    o.data.materials.append(MATERIALS[material])
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target='MESH')
    return o


def export(name):
    """Merge by material inside each rigid pivot, keeping all control frames separate."""
    bpy.ops.object.select_all(action='DESELECT')
    groups = [o for o in bpy.context.scene.objects if o.type == 'EMPTY']
    for group in groups:
        buckets = {}
        for o in list(group.children):
            if o.type == 'MESH':
                buckets.setdefault(o.data.materials[0].name, []).append(o)
        for material, parts in buckets.items():
            bpy.ops.object.select_all(action='DESELECT')
            for o in parts:
                o.select_set(True)
            bpy.context.view_layer.objects.active = parts[0]
            if len(parts) > 1:
                bpy.ops.object.join()
            parts[0].name = group.name + '_' + material
            bm = bmesh.new()
            bm.from_mesh(parts[0].data)
            # Close the lathe's coincident axis/seam vertices before orienting the solid.
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
            bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=1e-9)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(parts[0].data)
            bm.free()
    out = ROOT / 'artifacts/codex-style/authored'
    out.mkdir(parents=True, exist_ok=True)
    raw = out / (name + '.glb')
    bpy.ops.export_scene.gltf(filepath=str(raw), export_format='GLB', export_yup=False,
                              export_texcoords=False, export_normals=True, export_materials='EXPORT',
                              export_cameras=False, export_lights=False, export_animations=False,
                              export_extras=False, export_attributes=False)
    subprocess.run(['node', str(ROOT / 'assets/blender/compress.mjs'), str(raw), name], check=True, cwd=ROOT)
