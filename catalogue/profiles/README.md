# Community controller profiles

Each file here is one controller profile: a JSON object with the shape of the built-in ones (`spec/CATALOGUE.md` §3). The build checks every file with `checkProfile()` from `@obpal/core`, the same check as the builder at [obpal.blackboxes.net/catalogue/](https://obpal.blackboxes.net/catalogue/#build). It refuses a file that fails. Accepted profiles appear in `/catalogue.json` under `community`.

**To add one** (a person or an AI agent):
1. Build it on the catalogue page, or write it by hand against [`/profile.schema.json`](https://obpal.blackboxes.net/profile.schema.json).
2. Save it here as `<id>.json`. The file name must match the `id`.
3. Open a pull request. Or open an issue with the JSON: the builder's "Propose" does that for you.

**Example** (`crane.json`):

```json
{
  "id": "crane",
  "name": "Crane",
  "for": "Lifting with a steady yoke: slow tilt, fine aim",
  "on": [],
  "aim": { "route": "stick.right", "gain": 0.6, "curve": 1.6, "deadzone": 0.15, "invertY": false, "edgeTurn": false },
  "steer": { "route": "stick.fly", "gain": 0.8, "curve": 1.4, "deadzone": 0.2, "invertY": false, "edgeTurn": false },
  "point": { "route": "pointer", "gain": 1, "curve": 1, "deadzone": 0.2, "invertY": false, "edgeTurn": false }
}
```
