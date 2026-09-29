"""Machine the fixed shell openings around the moving shoulder and hip sleeves.

The cutting tools are copies of our own moving parts, expanded by 8 mm. They are
sampled through each independent axis, then discarded. Pivots and limits stay
unchanged. Nested internal bearings are deliberately retained for continuity.
"""
from common import *
from mathutils.bvhtree import BVHTree


def tree(obj):
    return BVHTree.FromPolygons([obj.matrix_world @ v.co for v in obj.data.vertices],
                               [tuple(face.vertices) for face in obj.data.polygons])


def machine_openings(nodes, morrow, low):
    pairs = []
    machined = set()
    for parent in nodes.values():
        for obj in parent.children:
            if obj.type != 'MESH':
                continue
            # Lathes deliberately share coincident section endpoints. A Boolean
            # needs those welded now, not only when common.export batches them.
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
            bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=1e-9)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(obj.data)
            bm.free()
            obj.data.update()
    for side, sign in [('left', -1), ('right', 1)]:
        for hinge, leaf, parent, axis, limits in [
            ('arm.roll', 'arm.yaw', 'spine.roll', 2, (-15*sign, 110*sign)),
            ('arm.pitch', 'arm.yaw', 'spine.roll', 0, (-80, 130 if morrow else 140)),
            ('arm.yaw', 'arm.yaw', 'spine.roll', 1, (-70, 70)),
            ('leg.roll', 'leg.yaw', 'pelvis', 2, (-25*sign, 45*sign)),
            ('leg.pitch', 'leg.yaw', 'pelvis', 0, (-35, 100)),
            ('leg.yaw', 'leg.yaw', 'pelvis', 1, (-35, 35)),
        ]:
            pairs.append((nodes[side+'.'+hinge], nodes[side+'.'+leaf], nodes[parent], axis, limits))
    pairs.append((nodes['head.pitch'], nodes['head.pitch'], nodes['spine.roll'], 0, (-35, 45)))
    for moving, leaf, parent, axis, limits in pairs:
        shells = [o for o in parent.children if o.type == 'MESH' and o.data.materials[0].name == 'obsidian']
        sources = [o for o in leaf.children if o.type == 'MESH' and o.data.materials[0].name == 'obsidian']
        cutters = []
        for source in sources:
            cutter = source.copy()
            cutter.data = source.data.copy()
            bpy.context.collection.objects.link(cutter)
            for vertex in cutter.data.vertices:
                vertex.co += vertex.normal*.008
            cutter.data.update()
            cutters.append(cutter)
        for step in range(17):
            moving.rotation_euler[axis] = math.radians(limits[0]+(limits[1]-limits[0])*step/16)
            bpy.context.view_layer.update()
            for cutter in cutters:
                cutter_tree = tree(cutter)
                for shell in shells:
                    if not shell.data.polygons or not tree(shell).overlap(cutter_tree):
                        continue
                    mod = shell.modifiers.new('Swept sleeve clearance', 'BOOLEAN')
                    mod.operation = 'DIFFERENCE'
                    mod.solver = 'EXACT'
                    mod.object = cutter
                    apply(shell)
                    shell['machined'] = True
                    machined.add(shell)
        moving.rotation_euler[axis] = 0
        for cutter in cutters:
            bpy.data.objects.remove(cutter, do_unlink=True)
    bpy.context.view_layer.update()
    for obj in machined:
        if len(obj.data.polygons) > 3:
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            # Remove only coplanar cutter boundaries. Edge-collapse decimation
            # can cap a concave socket, undoing the cut it was meant to preserve.
            bmesh.ops.dissolve_limit(bm, angle_limit=.0001, use_dissolve_boundaries=False,
                                    verts=list(bm.verts), edges=list(bm.edges), delimit={'NORMAL'})
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(obj.data)
            bm.free()
            # Booleans invalidate interpolated custom corner normals. Rebuild the
            # newly machined faces rather than exporting the original panel's.
            obj.data.normals_split_custom_set([(0, 0, 0)]*len(obj.data.loops))
            for polygon in obj.data.polygons:
                polygon.use_smooth = False
