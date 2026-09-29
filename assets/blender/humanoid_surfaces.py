"""The humanoid extension of the shared kit: three finishes, no image textures.

Linear RGB values match the named runtime finishes. Export and studio rendering
use these nodes directly, so authoring cannot quietly replace the live materials.
"""
from common import *


def finishes():
    definitions = {
        'obsidian': ((.009, .012, .013), .58, .22, .65),
        'graphite': ((.026, .030, .032), .55, .44, 0),
        'smokedGlass': ((.021, .040, .044), .34, .115, 1),
        'arenaGlass': ((.065, .092, .096), .16, .18, .7),
        'deckObsidian': ((.012, .016, .017), .42, .31, .2),
        'etch': ((.064, .075, .077), .62, .44, 0),
        'halo': ((.45, .50, .47), .1, .3, 0),
        'lime': ((.376, .618, .035), .1, .3, 0),
    }
    for name, (colour, metalness, roughness, coat) in definitions.items():
        material = MATERIALS.get(name) or bpy.data.materials.new(name)
        MATERIALS[name] = material
        material.diffuse_color = (*colour, 1)
        material.use_nodes = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value = (*colour, 1)
        shader.inputs['Metallic'].default_value = metalness
        shader.inputs['Roughness'].default_value = roughness
        shader.inputs['Coat Weight'].default_value = coat
        shader.inputs['Coat Roughness'].default_value = .18
        if name == 'arenaGlass':
            shader.inputs['Alpha'].default_value = .34
            material.surface_render_method = 'DITHERED'
        if name in ['lime', 'halo']:
            shader.inputs['Emission Color'].default_value = (*colour, 1)
            shader.inputs['Emission Strength'].default_value = .7 if name == 'lime' else 1.4


def rounded_normals(obj):
    """Weight broad armour faces; keep the narrow bevels legible in grazing light."""
    for face in obj.data.polygons:
        face.use_smooth = True
    mod = obj.modifiers.new('Area weighted armour normals', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    mod.weight = 40
    apply(obj)
    return obj


def loft(parent, sections, material='obsidian', low=False, edge=.004):
    """Closed octagonal sections: (y, half width, half depth, z centre).

    The clipped rectangle gives a deliberately planar highlight rather than the
    inflated capsule shape of a scaled sphere. Section changes supply real taper.
    """
    vertices = []
    for y, w, d, z in sections:
        vertices += [(x*w, y, z+v*d) for x, v in
                     [(-.65, -1), (.65, -1), (1, -.65), (1, .65),
                      (.65, 1), (-.65, 1), (-1, .65), (-1, -.65)]]
    faces = [tuple(reversed(range(8))), tuple(range((len(sections)-1)*8, len(sections)*8))]
    for section in range(len(sections)-1):
        for i in range(8):
            a, b = section*8+i, section*8+(i+1)%8
            faces.append((a, b, b+8, a+8))
    obj = mesh('Tapered overlapping armour', vertices, faces, parent, material)
    bevel(obj, edge, 1 if low else 2)
    return rounded_normals(obj)


def ball(parent, radius, at=(0, 0, 0), low=False, material='graphite', scale=(1, 1, 1)):
    """A closed spherical bearing remains continuous under every joint rotation."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10 if low else 18, ring_count=6 if low else 8, radius=radius)
    obj = bpy.context.object
    obj.name = 'Enclosed articulation bearing'
    finish(obj, parent, material, at)
    for vertex in obj.data.vertices:
        vertex.co.x *= scale[0]
        vertex.co.y *= scale[1]
        vertex.co.z *= scale[2]
    return obj


def oval_band(parent, rx, ry, z, tube, material='obsidian', low=False, at_y=.25, depth=1):
    obj = ring(parent, 1, tube, (0, at_y, z), material, segments=20 if low else 48)
    # Build the tube in metres first. Scaling only the centreline keeps its section
    # constant around the oval instead of pinching the top and bottom.
    for vertex in obj.data.vertices:
        x, y = vertex.co.x, vertex.co.y
        angle = math.atan2(y, x)
        vertex.co.x += (rx-1)*math.cos(angle)
        vertex.co.y += (ry-1)*math.sin(angle)
        vertex.co.z *= depth
    return obj
