"""Form specification for the soft humanoids: pivots, landmark targets and cover sections.

Section values are metres in the 1.80 m authoring frame; form I is scaled by
1.73/1.80 after building, pivots included. Landmark targets and tolerances live
in humanoid-forms.json, which the vitest proportion check reads too. The pivot
spread is the live profile's (profile.ts softProfile) and is asserted here, so
the covers are always authored around the frames the physics model uses.

Width limits that follow from those frames, rather than from the concepts:
- Upper-arm covers must clear the thorax through 15 degrees of adduction, so the
  thorax is narrower than the arm's medial edge below the shoulder bearing.
- Torso and pelvis covers meet in a rolled waist seam inside the 0.115 m spine
  bearing envelope; above and below it they open out to the waist and hips.
- The thigh carries its mass toward the midline, because the hip pivots sit
  about twice an adult's hip-joint spacing apart (decision D1 keeps them).
"""
import json
from pathlib import Path

SPEC = json.loads((Path(__file__).resolve().parent/'humanoid-forms.json').read_text())
# Unscaled x of arm.roll and leg.roll; profile.ts softProfile owns these values.
PIVOTS = {'i': {'arm': .225, 'leg': .18}, 'ii': {'arm': .26, 'leg': .15}}
assert all(SPEC['forms'][form]['pivots'] == PIVOTS[form] for form in PIVOTS), 'humanoid-forms.json pivots differ from the profile'


def S(y, lat, front, back=None, med=None, cx=0, cz=0, e=.9, lobes=None, rear=None):
    """One cover section; see humanoid_surfaces.contour."""
    section = {'y': y, 'lat': lat, 'med': lat if med is None else med, 'front': front,
               'back': front if back is None else back, 'cx': cx, 'cz': cz, 'e': e}
    if lobes:
        section['lobes'] = lobes
    if rear:
        section['rear'] = rear
    return section


# Thorax on spine.roll (spine pivot at y=0, neck at .47, shoulders at .36).
TORSO = {
    'i': [S(-.012, .088, .070, .066), S(0, .104, .081, .075), S(.022, .110, .085, .079),
          S(.046, .124, .089, .083, e=.96), S(.080, .128, .092, .086, e=1), S(.130, .128, .096, .088, e=1),
          S(.180, .132, .102, .092, e=1, lobes=(.010, .054, .048)),
          S(.226, .139, .106, .096, e=.98, lobes=(.022, .054, .048), rear=(.004, .072, .050)),
          S(.266, .146, .106, .098, e=.95, lobes=(.014, .054, .048), rear=(.006, .072, .050)),
          S(.305, .155, .096, .099, rear=(.004, .072, .050)), S(.345, .180, .083, .090),
          S(.385, .196, .066, .075), S(.415, .162, .056, .066), S(.440, .100, .052, .060),
          S(.456, .060, .050, .056)],
    'ii': [S(-.012, .090, .070, .066), S(0, .106, .082, .078), S(.022, .110, .087, .081),
           S(.046, .134, .095, .089), S(.080, .142, .100, .094), S(.130, .150, .106, .098),
           S(.180, .160, .113, .103, lobes=(.004, .062, .050)),
           S(.226, .168, .116, .107, lobes=(.009, .062, .050), rear=(.006, .082, .055)),
           S(.266, .176, .113, .110, lobes=(.006, .062, .050), rear=(.008, .082, .055)),
           S(.305, .188, .104, .108, rear=(.006, .082, .055)), S(.345, .222, .090, .097),
           S(.385, .238, .073, .081), S(.415, .200, .061, .071), S(.440, .112, .056, .064),
           S(.456, .064, .054, .058)],
}
# Pelvis (hip pivots at y=0, spine pivot at .12). The front recedes where the
# flexing thigh sweeps up; the crotch below the cover is the dark under-suit.
PELVIS = {
    'i': [S(.132, .088, .068, .066), S(.118, .100, .076, .074), S(.098, .106, .080, .080),
          S(.078, .130, .084, .088), S(.050, .158, .078, .098, rear=(.012, .070, .050)),
          S(.020, .170, .058, .106, rear=(.018, .075, .050)),
          S(-.008, .112, .040, .104, rear=(.020, .065, .045)), S(-.026, .056, .030, .090, rear=(.012, .050, .040))],
    'ii': [S(.132, .090, .068, .066), S(.118, .102, .078, .074), S(.098, .108, .084, .080),
           S(.078, .132, .088, .086), S(.050, .150, .080, .094, rear=(.008, .070, .050)),
           S(.020, .156, .060, .102, rear=(.012, .070, .050)),
           S(-.008, .104, .042, .102, rear=(.014, .060, .045)), S(-.026, .054, .032, .088, rear=(.010, .050, .040))],
}
# Limbs along -y from their own pivot; x is lateral for the right side.
UPPER_ARM = {
    'i': [S(.046, .032, .034, med=.030, cx=.007), S(.028, .046, .045, med=.041, cx=.006),
          S(0, .050, .047, med=.044, cx=.004), S(-.040, .048, .045, med=.043, cx=.003),
          S(-.090, .043, .041, .040, med=.041, cx=.001), S(-.150, .040, .038, .038, med=.039),
          S(-.205, .036, .032, .035, med=.035), S(-.254, .033, .027, .032, med=.032)],
    'ii': [S(.050, .036, .038, med=.034, cx=.008), S(.030, .052, .052, med=.046, cx=.006),
           S(0, .057, .055, .054, med=.050, cx=.005), S(-.040, .055, .053, .052, med=.049, cx=.004),
           S(-.090, .050, .050, .048, med=.047, cx=.002), S(-.150, .047, .047, .045, med=.046),
           S(-.205, .043, .039, .041, med=.042), S(-.254, .039, .032, .038, med=.038)],
}
FOREARM = {
    'i': [S(-.028, .031, .020, .036, med=.032, cz=.004), S(-.075, .037, .024, .036, med=.035, cz=.003),
          S(-.115, .036, .031, .031, med=.034), S(-.160, .031, .027, .026, med=.030),
          S(-.205, .026, .021, .020, med=.025), S(-.228, .024, .018, .017, med=.023)],
    'ii': [S(-.028, .036, .022, .040, med=.036, cz=.004), S(-.075, .042, .026, .041, med=.040, cz=.003),
           S(-.115, .042, .035, .035, med=.040), S(-.160, .036, .031, .030, med=.034),
           S(-.205, .030, .025, .024, med=.029), S(-.228, .027, .021, .020, med=.026)],
}
THIGH = {
    # The hip crease slants: the thigh rises high on the outside and starts at
    # the crotch on the inside, so its medial mass sits below the pelvis.
    'i': [S(.050, .044, .046, .048, med=.040, cx=-.020), S(.020, .052, .062, .066, med=.052, cx=-.027),
          S(-.020, .060, .070, .074, med=.070, cx=-.035), S(-.060, .064, .073, .074, med=.090, cx=-.047),
          S(-.110, .066, .073, .071, med=.084, cx=-.050), S(-.180, .062, .068, .064, med=.070, cx=-.036),
          S(-.260, .055, .060, .055, med=.058, cx=-.020),
          S(-.335, .050, .052, .048, med=.050, cx=-.008), S(-.380, .047, .047, .043, med=.047, cx=-.003)],
    'ii': [S(.050, .044, .048, .050, med=.042, cx=-.004), S(.020, .056, .066, .068, med=.054, cx=-.012),
           S(-.020, .062, .074, .078, med=.070, cx=-.022), S(-.060, .066, .078, .080, med=.084, cx=-.034),
           S(-.110, .068, .080, .078, med=.080, cx=-.034), S(-.180, .064, .074, .068, med=.068, cx=-.025),
           S(-.260, .057, .064, .058, med=.058, cx=-.012),
           S(-.335, .051, .055, .050, med=.051, cx=-.004), S(-.380, .048, .050, .045, med=.048)],
}
SHIN = {
    'i': [S(-.030, .043, .045, .038), S(-.080, .044, .044, .048, med=.045, cz=.004),
          S(-.140, .043, .039, .051, med=.046, cz=.005), S(-.220, .036, .033, .040, med=.037, cz=.004),
          S(-.300, .029, .028, .029), S(-.358, .026, .025, .025)],
    'ii': [S(-.030, .046, .048, .040), S(-.080, .047, .047, .051, med=.048, cz=.004),
           S(-.140, .046, .042, .054, med=.049, cz=.005), S(-.220, .039, .036, .043, med=.040, cz=.004),
           S(-.300, .031, .030, .031), S(-.358, .028, .027, .027)],
}
# Shoe stations along -z (toe) to +z (heel): (z, half width, top y). The sole
# plane is the physics foot box's bottom, 0.08 m below the ankle pivot.
SOLE = -.08
SHOE = [(-.192, .028, -.058), (-.174, .043, -.048), (-.140, .052, -.042), (-.095, .055, -.036),
        (-.052, .051, -.024), (-.016, .045, -.006), (.020, .042, -.001), (.052, .040, -.002),
        (.072, .031, -.012)]


def cover_sections(family, form):
    """Select covers before either rigid lofting or skinned limb construction.

    Cairn I's lateral thigh tapers away from the fixed palm frames. The medial
    contour and joint offsets stay put; every other form uses the original tables.
    """
    sections = {'torso': TORSO[form], 'pelvis': PELVIS[form], 'upper_arm': UPPER_ARM[form],
                'forearm': FOREARM[form], 'thigh': THIGH[form], 'shin': SHIN[form]}
    if (family, form) == ('cairn', 'i'):
        inset = [0, .012, .024, .024, .024, .018, .008, 0, 0]
        sections['thigh'] = [{**section, 'lat': section['lat']-amount}
                             for section, amount in zip(THIGH[form], inset)]
    return sections
