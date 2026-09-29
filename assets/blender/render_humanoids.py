"""Studio turntable stills and the arena pair, authored geometry and lighting only.

Blender -b --factory-startup --python assets/blender/render_humanoids.py -- [--draft]
Evidence is ignored. Draft images are for iteration; final images are 3840 x 2160.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from humanoids import build_robot
from humanoid_arena import build_arena
from common import *
from mathutils import Matrix

OUT = ROOT / 'artifacts/humanoid/phase-3/renders'
OUT.mkdir(parents=True, exist_ok=True)
DRAFT = '--draft' in sys.argv


def aim(obj, at):
    forward = (Vector(at) - obj.location).normalized()
    right = forward.cross(Vector((0, 1, 0))).normalized()
    up = right.cross(forward).normalized()
    obj.rotation_euler = Matrix((right, up, -forward)).transposed().to_euler()


def studio(arena=False):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24 if DRAFT else 64
    scene.cycles.use_denoising = True
    # GPU when available; a CPU-only authoring machine remains supported.
    prefs = bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for device in prefs.devices:
            device.use = device.type != 'CPU'
        if any(d.use for d in prefs.devices):
            scene.cycles.device = 'GPU'
    except (TypeError, RuntimeError):
        pass
    scene.render.resolution_x = 1280 if DRAFT else 3840
    scene.render.resolution_y = 720 if DRAFT else 2160
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    scene.world.color = (.16, .16, .16)
    finishes = {
        'carbon': ((.014, .020, .022), .32, .38),
        'gunmetal': ((.047, .065, .078), .80, .26),
        'darkTitanium': ((.139, .181, .209), .88, .23),
        'optic': ((.019, .044, .052), .6, .12),
        'lime': ((.40, .62, .025), .1, .3),
    }
    for name, (colour, metalness, roughness) in finishes.items():
        m = MATERIALS[name]
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*colour, 1)
        bsdf.inputs['Metallic'].default_value = metalness
        bsdf.inputs['Roughness'].default_value = roughness
        if name == 'optic':
            bsdf.inputs['Coat Weight'].default_value = 1
        if name == 'lime':
            bsdf.inputs['Emission Color'].default_value = (.56, 1, .035, 1)
            bsdf.inputs['Emission Strength'].default_value = .8
    floor = block(None, (200, .04, 200), (0, -.18 if arena else -.02, 0), 'carbon')
    floor.data.materials[0] = MATERIALS['carbon'].copy()
    floor.data.materials[0].node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = .65
    for name, position, energy, size, colour in [
        ('Key', (-3, 4, -3), 700, 4, (.82, .9, 1)),
        ('Rim', (2, 3, 2), 1050, 3, (.78, .91, 1)),
        ('Fill', (3, 1.7, -2), 350, 3, (1, 1, .9)),
    ]:
        light = bpy.data.lights.new(name, 'AREA')
        light.energy, light.shape, light.size, light.color = energy, 'DISK', size, colour
        o = bpy.data.objects.new(name, light)
        scene.collection.objects.link(o)
        o.location = position
        aim(o, (0, .8, 0))
    camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 3.8
    return camera


for name in ['keel', 'morrow']:
    nodes = build_robot(name)
    camera = studio()
    for label, angle in [('front', 0), ('three-quarter', 35), ('side', 90), ('back', 180)]:
        a = math.radians(angle)
        camera.location = (4 * math.sin(a), 1.28, -4 * math.cos(a))
        aim(camera, (0, .86, 0))
        bpy.context.scene.render.filepath = str(OUT / (name + '-' + label + ('-draft' if DRAFT else '') + '.png'))
        bpy.ops.render.render(write_still=True)

build_arena()
for name, x, angle in [('keel', -.61, -.18), ('morrow', .64, .18)]:
    nodes = build_robot(name, clear=False)
    anchor = pivot(name)
    nodes['pelvis'].parent = anchor
    anchor.location.x = x
    anchor.rotation_euler.y = angle
    nodes['left.arm.elbow'].rotation_euler.x = .35
    nodes['right.arm.elbow'].rotation_euler.x = .2
camera = studio(arena=True)
camera.data.ortho_scale = 5.5
camera.location = (2.7, 2.4, -4.8)
aim(camera, (0, .77, 0))
bpy.context.scene.render.filepath = str(OUT / ('pair-arena' + ('-draft' if DRAFT else '') + '.png'))
bpy.ops.render.render(write_still=True)
