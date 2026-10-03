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

OUT = Path(sys.argv[sys.argv.index('--out')+1]) if '--out' in sys.argv else ROOT / 'artifacts/humanoid/phase-5/v3/renders'
OUT.mkdir(parents=True, exist_ok=True)
DRAFT = '--draft' in sys.argv
SILHOUETTES = '--silhouettes' in sys.argv


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
    floor = block(None, (200, .04, 200), (0, -.18 if arena else -.02, 0), 'deckObsidian')
    floor.name = 'Studio floor'
    floor.data.materials[0] = MATERIALS['deckObsidian'].copy()
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


def lumbar_stills():
    """Waist close-ups at spine twist and bend extremes, one still per pose and view.

    `--lumbar [--lod] [--tile 640]` renders each pose of the three independent spine
    axes (they share one pivot) from the front, three-quarter and side, for Keel and
    Morrow. Files are named <robot>[-lod]-<pose>-<view>.png under --out.
    """
    tile = int(sys.argv[sys.argv.index('--tile')+1]) if '--tile' in sys.argv else 640
    poses = [('rest', {}), ('yaw-35', {'spine.yaw': -35}), ('yaw+35', {'spine.yaw': 35}),
             ('yaw+35-pitch+30', {'spine.yaw': 35, 'spine.pitch': 30}),
             ('yaw-35-pitch-20-roll+20', {'spine.yaw': -35, 'spine.pitch': -20, 'spine.roll': 20}),
             ('yaw+35-pitch+30-roll-20', {'spine.yaw': 35, 'spine.pitch': 30, 'spine.roll': -20})]
    axes = {'spine.yaw': 1, 'spine.pitch': 0, 'spine.roll': 2}
    for name in ['keel', 'morrow']:
        lod = '--lod' in sys.argv
        nodes = build_robot(name, lod)
        camera = studio()
        scene = bpy.context.scene
        scene.render.resolution_x = scene.render.resolution_y = tile
        camera.data.ortho_scale = .56
        # The arms hang beside the waist and hide the bend; the waist stills omit them.
        for side in ['left', 'right']:
            for obj in nodes[side+'.arm.roll'].children_recursive:
                obj.hide_render = True
        focus = nodes['spine.yaw'].matrix_world.translation + Vector((0, .05, 0))
        for label, angles in poses:
            for joint, axis in axes.items():
                nodes[joint].rotation_euler[axis] = math.radians(angles.get(joint, 0))
            bpy.context.view_layer.update()
            for view, angle in [('front', 0), ('three-quarter', 35), ('side', 90)]:
                a = math.radians(angle)
                camera.location = (4*math.sin(a), focus.y+.12, -4*math.cos(a))
                aim(camera, focus)
                scene.render.filepath = str(OUT / f'{name}{"-lod" if lod else ""}-{label}-{view}.png')
                bpy.ops.render.render(write_still=True)


if '--lumbar' in sys.argv:
    lumbar_stills()
    raise SystemExit


for name in ['keel', 'morrow']:
    nodes = build_robot(name)
    camera = studio()
    views = [('front', 0), ('three-quarter', 35), ('side', 90), ('back', 180)]
    if SILHOUETTES:
        views = [('front', 0), ('side', 90)]
        scene = bpy.context.scene
        scene.render.resolution_x = scene.render.resolution_y = 256
        scene.render.film_transparent = True
        scene.cycles.samples = 8
        bpy.data.objects['Studio floor'].hide_render = True
        black = bpy.data.materials.new('Flat silhouette')
        black.use_nodes = True
        black.node_tree.nodes.clear()
        output = black.node_tree.nodes.new('ShaderNodeOutputMaterial')
        emission = black.node_tree.nodes.new('ShaderNodeEmission')
        emission.inputs['Color'].default_value = (0, 0, 0, 1)
        black.node_tree.links.new(emission.outputs[0], output.inputs['Surface'])
        bpy.context.view_layer.material_override = black
        camera.data.ortho_scale = 2
    for label, angle in views:
        a = math.radians(angle)
        camera.location = (4 * math.sin(a), .86 if SILHOUETTES else 1.28, -4 * math.cos(a))
        aim(camera, (0, .86, 0))
        suffix = '-silhouette' if SILHOUETTES else '-draft' if DRAFT else ''
        bpy.context.scene.render.filepath = str(OUT / (name + '-' + label + suffix + '.png'))
        bpy.ops.render.render(write_still=True)

if not SILHOUETTES:
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
    camera.data.ortho_scale = 11.5
    camera.location = (5, 3.8, -7)
    aim(camera, (0, 1.3, 0))
    bpy.context.scene.render.filepath = str(OUT / ('arena-wide' + ('-draft' if DRAFT else '') + '.png'))
    bpy.ops.render.render(write_still=True)
