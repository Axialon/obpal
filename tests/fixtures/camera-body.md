# Body camera fixture

`camera-body.png` is an original image generated with OpenAI imagegen on 2026-09-30 for this repository, distributed under its MIT licence. It depicts a synthetic anonymous adult, not a photograph of a participant. No reference image was used. Tests convert it to a 640×480 Y4M stream in a temporary folder; it is not shipped as a site asset.

Generation prompt:

> Create an original photorealistic testing fixture, landscape 4:3 composition. One anonymous adult person standing facing the camera, entire body from head to shoes visible with generous 15 percent margin, arms comfortably extended diagonally down about 30 degrees away from torso, hands open, feet shoulder-width apart. Neutral gray fitted long-sleeve sports shirt, dark blue straight athletic trousers, plain white shoes. Clearly visible elbows, wrists, hips, knees and ankles, no occlusions. Plain light gray studio background and floor, even bright diffuse lighting, camera level at waist height around 3 metres away, natural undistorted anatomy. No text, no logos, no extra people or objects. This will be an artificial input image for testing full-body pose estimation; make the entire body easy to detect.

This proves the real model pipeline on synthetic input. It does not prove phone cadence, heat, physical camera latency, moving-person accuracy or optical performance under occlusion. Separate synthetic landmark inputs exercise failure-state contracts.
