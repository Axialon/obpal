"""4K views, head studies and silhouettes of all six original soft-cover forms."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from humanoids_soft import build_soft, FORMS
from common import *
from mathutils import Matrix

OUT = ROOT/'artifacts/humanoid-third/renders'
OUT.mkdir(parents=True, exist_ok=True)
DRAFT = '--draft' in sys.argv
SILHOUETTES = '--silhouettes' in sys.argv


def aim(obj, at):
    forward = (Vector(at)-obj.location).normalized()
    right = forward.cross(Vector((0, 1, 0))).normalized()
    up = right.cross(forward).normalized()
    obj.rotation_euler = Matrix((right, up, -forward)).transposed().to_euler()


def studio():
    scene = bpy.context.scene
    scene.view_layers[0].material_override = None
    scene.render.film_transparent = False
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 16 if DRAFT else 48
    scene.cycles.use_denoising = True
    prefs = bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for device in prefs.devices:
            device.use = device.type != 'CPU'
        if any(device.use for device in prefs.devices):
            scene.cycles.device = 'GPU'
    except (TypeError, RuntimeError):
        pass
    scene.render.resolution_x = 1280 if DRAFT else 3840
    scene.render.resolution_y = 720 if DRAFT else 2160
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    scene.world.color = (.16, .16, .16)
    floor = block(None, (200, .04, 200), (0, -.022, 0), 'softCore')
    for name, position, energy, size, colour in [
        ('Key', (-3, 4, -3), 700, 4, (.82, .9, 1)),
        ('Rim', (2, 3, 2), 1050, 3, (.78, .91, 1)),
        ('Fill', (3, 1.7, -2), 350, 3, (1, 1, .9)),
    ]:
        light = bpy.data.lights.new(name, 'AREA')
        light.energy, light.shape, light.size, light.color = energy, 'DISK', size, colour
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = position
        aim(obj, (0, .8, 0))
    camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 3.65
    if SILHOUETTES:
        scene.render.resolution_x = scene.render.resolution_y = 512
        scene.render.film_transparent = True
        scene.cycles.samples = 8
        floor.hide_render = True
        black = bpy.data.materials.new('Silhouette')
        black.use_nodes = True
        black.node_tree.nodes.clear()
        output = black.node_tree.nodes.new('ShaderNodeOutputMaterial')
        emission = black.node_tree.nodes.new('ShaderNodeEmission')
        emission.inputs['Color'].default_value = (0, 0, 0, 1)
        black.node_tree.links.new(emission.outputs[0], output.inputs['Surface'])
        scene.view_layers[0].material_override = black
        camera.data.ortho_scale = 2.05
    return camera, floor


def silhouettes(camera, floor, name):
    scene = bpy.context.scene
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.film_transparent = True
    scene.cycles.samples = 8
    floor.hide_render = True
    black = bpy.data.materials.new('Silhouette')
    black.use_nodes = True
    black.node_tree.nodes.clear()
    output = black.node_tree.nodes.new('ShaderNodeOutputMaterial')
    emission = black.node_tree.nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value = (0, 0, 0, 1)
    black.node_tree.links.new(emission.outputs[0], output.inputs['Surface'])
    scene.view_layers[0].material_override = black
    camera.data.ortho_scale = 2.05
    for label, angle in [('front', 0), ('side', 90)]:
        a = math.radians(angle)
        camera.location = (4*math.sin(a), 1.08, -4*math.cos(a))
        aim(camera, (0, .88, 0))
        scene.render.filepath = str(OUT/f'{name}-{label}-silhouette.png')
        bpy.ops.render.render(write_still=True)


for name in FORMS:
    if '--only' in sys.argv and name != sys.argv[sys.argv.index('--only')+1]:
        continue
    if '--cache' in sys.argv:
        bpy.ops.wm.open_mainfile(filepath=str(ROOT/'artifacts/humanoid-third/build/source'/f'{name}.blend'))
        MATERIALS.clear()
        MATERIALS.update({material.name: material for material in bpy.data.materials})
        nodes = {obj.name.replace('_', '.'): obj for obj in bpy.context.scene.objects if obj.type == 'EMPTY'}
    else:
        nodes = build_soft(name)
    nodes['left.arm.roll'].rotation_euler.z = -.09
    nodes['right.arm.roll'].rotation_euler.z = .09
    bpy.context.view_layer.update()
    camera, floor = studio()
    views = [('front', 0), ('three-quarter', 35), ('side', 90), ('back', 180)]
    if SILHOUETTES:
        views = [('front', 0), ('side', 90)]
    else:
        views += [('head-front', 0), ('head-three-quarter', 35)]
    if '--heads' in sys.argv:
        views = [view for view in views if view[0].startswith('head')]
    for label, angle in views:
        head = label.startswith('head')
        target = (0, 1.60 if name.endswith('-i') else 1.66, 0) if head else (0, .88, 0)
        camera.data.ortho_scale = .62 if head else 2.05 if SILHOUETTES else 3.65
        a = math.radians(angle)
        camera.location = (4*math.sin(a), target[1]+(.04 if head else .2), -4*math.cos(a))
        aim(camera, target)
        suffix = '-silhouette' if SILHOUETTES else '-draft' if DRAFT else ''
        bpy.context.scene.render.filepath = str(OUT/f'{name}-{label}{suffix}.png')
        bpy.ops.render.render(write_still=True)
    if not DRAFT and not SILHOUETTES and '--heads' not in sys.argv:
        silhouettes(camera, floor, name)
