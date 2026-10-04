"""The humanoid extension of the shared kit: three finishes, no image textures.

Linear RGB values match the named runtime finishes. Export and studio rendering
use these nodes directly, so authoring cannot quietly replace the live materials.
"""
from common import *


def finishes():
    definitions = {
        'obsidian': ((.009, .012, .013), .58, .22, .65),
        'graphite': ((.026, .030, .032), .55, .44, 0),
        'elastomer': ((.0025, .004, .0045), .04, .92, 0),
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
        if name == 'elastomer':
            shader.inputs['Specular IOR Level'].default_value = .25
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
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
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


def anatomy(parent, sections, material='obsidian', low=False, at=(0, 0, 0), keep=None):
    """Smooth superellipse sections for pectoral, deltoid and muscle-led volume.

    The original joint centres stay fixed. These are authored shell envelopes,
    not copied anatomy or a physical soft-body/cloth simulation. `keep=(low, high)`
    closes the same shell between two of its own rings, so two bodies can share
    one continuous envelope and overlap where they bend.
    """
    rings = []
    count, subdivisions = (12, 2) if low else (16, 3)
    for i in range(len(sections)-1):
        before, a = sections[max(0, i-1)], sections[i]
        b, after = sections[i+1], sections[min(len(sections)-1, i+2)]
        for n in range(subdivisions):
            t = n/subdivisions
            values = [a[0]+(b[0]-a[0])*t]
            for axis in range(1, 4):
                p, q, r, s = before[axis], a[axis], b[axis], after[axis]
                values.append(.5*((2*q)+(-p+r)*t+(2*p-5*q+4*r-s)*t*t+(-p+3*q-3*r+s)*t*t*t))
            rings.append(values)
    rings.append(sections[-1])
    if keep:
        rings = [ring for ring in rings if keep[0]-1e-6 <= ring[0] <= keep[1]+1e-6]
    vertices = []
    for y, w, d, z in rings:
        for i in range(count):
            angle = math.tau*i/count
            x, depth = math.cos(angle), math.sin(angle)
            vertices.append((math.copysign(abs(x)**.72, x)*w, y,
                             z+math.copysign(abs(depth)**.72, depth)*d))
    faces = [tuple(reversed(range(count))), tuple(range((len(rings)-1)*count, len(rings)*count))]
    for ring_index in range(len(rings)-1):
        for i in range(count):
            a, b = ring_index*count+i, ring_index*count+(i+1)%count
            faces.append((a, b, b+count, a+count))
    obj = mesh('Anatomy-led shell', vertices, faces, parent, material, at)
    obj['anatomical'] = True
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def sheath(parent, points, radius=.0028, material='graphite'):
    """A small original tendon conduit, with geometric shading and no texture."""
    vertices, faces = [], []
    for i, p in enumerate(points):
        tangent = Vector(points[min(i+1, len(points)-1)])-Vector(points[max(0, i-1)])
        tangent.normalize()
        side = tangent.cross(Vector((0, 0, 1)))
        if side.length_squared < .01:
            side = tangent.cross(Vector((0, 1, 0)))
        side.normalize()
        normal = side.cross(tangent).normalized()
        for j in range(6):
            angle = j*math.tau/6
            vertices.append(tuple(Vector(p)+radius*(side*math.cos(angle)+normal*math.sin(angle))))
    for i in range(len(points)-1):
        for j in range(6):
            a, b = i*6+j, i*6+(j+1)%6
            faces.append((a, b, b+6, a+6))
    faces += [tuple(reversed(range(6))), tuple(range((len(points)-1)*6, len(points)*6))]
    return mesh('Tendon sheath', vertices, faces, parent, material)


def _spline(values, t):
    """Catmull-Rom through evenly spaced values; t runs from 0 to len-1."""
    i = min(len(values)-2, max(0, int(t)))
    u = t-i
    p, q = values[max(0, i-1)], values[i]
    r, s = values[i+1], values[min(len(values)-1, i+2)]
    return .5*((2*q)+(-p+r)*u+(2*p-5*q+4*r-s)*u*u+(-p+3*q-3*r+s)*u*u*u)


def contour(section, angle):
    """One point of a four-quadrant superellipse ring, used by anatomy2.

    A section has y, lat (+x half width), med (-x half width), front (-z half
    depth), back (+z half depth), centre offsets cx and cz, and exponent e (1 is
    an ellipse, lower is squarer). Optional `lobes` and `rear` are (amplitude,
    centre, width) pairs of mass either side of the midline on the front or back:
    bust, pectorals, scapulae or glutes. Front is -z, as in the live rigs.
    """
    c, s = math.cos(angle), math.sin(angle)
    e = section.get('e', .9)
    x = section['cx']+(section['lat'] if c >= 0 else section['med'])*math.copysign(abs(c)**e, c)
    z = section['cz']+(section['back'] if s >= 0 else section['front'])*math.copysign(abs(s)**e, s)
    for key, side in [('lobes', -1), ('rear', 1)]:
        amplitude, centre, width = section.get(key, (0, 0, 1))
        if amplitude and s*side > 0:
            z += side*amplitude*abs(s)**.5*math.exp(-((abs(x-section['cx'])-centre)/width)**2)
    return x, z


def anatomy2(parent, sections, material, count=24, per=3, caps=(0, 0), sign=1, at=(0, 0, 0),
             name='Anatomy shell', window=None, steps=None):
    """A closed, smooth cover lofted through four-quadrant superellipse sections.

    The v2 soft covers use this instead of `anatomy`: rings can sit off the joint
    axis (medial thigh, glute or bust mass) and each quadrant has its own radius.
    Every value interpolates on a Catmull-Rom spline, `per` rings per span.
    `caps=(start, end)` rounds each end over that length to a pole, so a cover
    finishes in a rolled lip rather than a flat cut. `sign=-1` mirrors x for a
    left limb. `window=(material, centres, half_angle, (y_low, y_high))` gives the
    faces of angular bands a second material, such as two-tone side panels.
    `steps` sets the rings in each rounded end.
    """
    defaults = {'cx': 0, 'cz': 0, 'e': .9}
    keys = sorted({key for section in sections for key in section} | set(defaults))
    # A section without lobes keeps its neighbours' centre and width at zero
    # amplitude, so the mass fades in and out in place rather than sweeping
    # across the cover; amplitude never undershoots into a dent.
    rest = {key: next(((0, *s[key][1:]) for s in sections if key in s), (0, 0, 1)) for key in ('lobes', 'rear')}
    rows = []
    for k in range((len(sections)-1)*per+1):
        t = k/per
        ring = {}
        for key in keys:
            if key in ('lobes', 'rear'):
                values = [section.get(key, rest[key]) for section in sections]
                ring[key] = tuple(_spline([v[j] for v in values], t) for j in range(3))
                ring[key] = (max(0, ring[key][0]), *ring[key][1:])
            else:
                ring[key] = _spline([section.get(key, defaults.get(key, section.get('lat'))) for section in sections], t)
        rows.append(ring)
    direction = 1 if rows[-1]['y'] > rows[0]['y'] else -1
    steps = steps or 3

    def rounded(ring, toward, length):
        out = []
        for j in range(1, steps+1):
            phi = math.pi/2*j/steps
            f = math.cos(phi)
            r = dict(ring)
            for key in ('lat', 'med', 'front', 'back'):
                r[key] = ring[key]*f
            for key in ('lobes', 'rear'):
                if key in ring:
                    r[key] = (ring[key][0]*f, ring[key][1], ring[key][2])
            r['y'] = ring['y']+toward*length*math.sin(phi)
            out.append(r)
        return out
    start = rounded(rows[0], -direction, caps[0])[::-1] if caps[0] else []
    end = rounded(rows[-1], direction, caps[1]) if caps[1] else []
    poles = [start[0] if start else None, end[-1] if end else None]
    rings = start[1:]+rows+end[:-1]
    vertices, faces = [], []
    for ring in rings:
        for i in range(count):
            x, z = contour(ring, math.tau*i/count)
            vertices.append((sign*x, ring['y'], z))
    for r in range(len(rings)-1):
        for i in range(count):
            a, b = r*count+i, r*count+(i+1) % count
            faces.append((a, b, b+count, a+count))
    last = (len(rings)-1)*count
    for index, pole in enumerate(poles):
        first = 0 if index == 0 else last
        if pole is None:
            loop = list(range(first, first+count))
            faces.append(tuple(reversed(loop)) if index == 0 else tuple(loop))
            continue
        vertices.append((sign*pole['cx'], pole['y'], pole['cz']))
        p = len(vertices)-1
        for i in range(count):
            a, b = first+i, first+(i+1) % count
            faces.append((b, a, p) if index == 0 else (a, b, p))
    if (direction < 0) != (sign < 0):
        faces = [tuple(reversed(face)) for face in faces]
    obj = mesh(name, vertices, faces, parent, material, at)
    if window:
        panel, centres, half, (low, high) = window
        obj.data.materials.append(MATERIALS[panel])
        for polygon in obj.data.polygons:
            if len(polygon.vertices) != 4:
                continue
            ids = sorted(polygon.vertices)
            index = ids[0] % count if ids[1]-ids[0] == 1 else ids[1] % count
            angle = math.tau*(index+.5)/count
            y = sum(obj.data.vertices[i].co.y for i in ids)/4
            for centre in centres:
                delta = math.atan2(math.sin(angle-centre), math.cos(angle-centre))
                if abs(delta) <= half and low <= y <= high:
                    polygon.material_index = 1
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj['anatomical'] = True
    return obj
