# Blossom Strap — Modding

Two ways to change what your client shows: **asset rules**, which swap assets as
they are requested, and **client mods**, which overlay files onto the Roblox
content folders. They solve different problems.

| | Asset rules | Client mods |
|---|---|---|
| Works by | Intercepting requests | Copying files over the client's own |
| Needs interception | Yes | No |
| Needs the certificate | Yes | No |
| Survives a Roblox update | Yes | No — re-applied at launch |
| Granularity | One asset id | One file |
| Good for | Textures, sounds, meshes by id | Interface artwork, default sounds |

Everything here is a local rendering substitution. It changes what your own
client draws. It does not change what the server sends or what anyone else sees.

---

## Asset rules

A **rule** maps a source onto a replacement. Rules live in **rule sets**, and a
profile enables the sets it wants.

### Sources

| Form | Example | Matches |
|---|---|---|
| Asset id | `13456789` | exactly that asset |
| Glob | `*rbxcdn.com/textures/*` | the whole request URL |
| Substring | `deadbeefcafe` | any URL containing it |

Numeric sources are checked first because they are the common case and the
cheapest.

### Actions

| Action | Target | Effect |
|---|---|---|
| Replace with another asset | a numeric asset id | serves that asset's bytes instead |
| Replace with a local file | a full path | serves the file's bytes |
| Replace from a URL | an `https://` URL | fetches and serves it |
| Remove entirely | — | serves an empty 200 |
| Always use the original | — | shadows lower-priority rules |

`Remove` answers 200 with no body rather than 404 on purpose: the client treats
a missing asset as an error and retries, while an empty success is simply
nothing to draw.

### Order

Rules are evaluated by **priority descending**, then by **creation order**. The
first enabled match wins. Rule sets have their own order, used to break ties
between sets.

Use "Always use the original" at a high priority to carve an exception out of a
broad rule below it.

### The rule that cannot break your client

If a replacement cannot be served — the file is gone, the URL is unreachable,
the target id is not a number, the rule points at itself, the disk is full — the
proxy serves the **original upstream response**. There is no failure mode where
a customization mistake produces a broken client.

This is enforced in the resolver rather than at each call site, and it is
covered by tests that feed it deliberately malformed rules.

### Sharing

`Export` writes a portable document:

```jsonc
{
  "schemaVersion": 1,
  "name": "Low Texture",
  "description": "Flat replacement textures for visibility",
  "rules": [
    { "source": "13456789", "action": "replace-asset", "target": "98765432",
      "assetType": "texture", "enabled": true, "priority": 0, "notes": "" }
  ]
}
```

Import never rejects a whole file for one bad rule: valid rules are imported,
invalid ones are skipped, and the count of each is reported. Rules referencing
local paths from another machine will fall back to the original asset, which is
the point of the fallback policy.

---

## Client mods

Put files under `%LOCALAPPDATA%\BlossomStrap\mods\`, mirroring the layout inside
a Roblox version folder:

```
mods\
  content\sounds\ouch.ogg
  content\textures\ui\LuaApp\icons\ic-home.png
  ExtraContent\...
```

Only `content`, `ExtraContent` and `PlatformContent` are accepted. Anything else
is skipped and counted, because overlaying files outside the asset trees is how
a mod manager turns into something that modifies the program itself.

Every file Blossom is about to overwrite — or create — is captured in a restore
point first, so `Restore` puts the client back exactly as Roblox shipped it,
including deleting files that did not exist before.

If any file fails to copy, the whole application is rolled back rather than
leaving a half-modified client.

Roblox replaces the version folder on update, so mods are re-applied at launch.

---

## Finding asset ids

Turn on **capture** and play. Every asset the client requests appears in the
live stream and is indexed in the cache, where you can filter by type, size and
time, preview it, and press **Replace** to create a rule from it.

Capture has two sources:

- **The interception proxy** — sees the request URL, the asset id and the
  response bytes.
- **Roblox's own cache** — used when interception is off. It needs no
  certificate, but newer clients strip request details from those files, so many
  assets appear without an id. The interface reports this as a degraded source
  rather than presenting it as equivalent.

---

## Previews

| Type | Viewer |
|---|---|
| PNG, JPEG, GIF, BMP, WEBP | zoom to fit or 1:1, transparency checkerboard, dimensions |
| OGG, MP3, WAV, FLAC | play, pause, seek, duration |
| Roblox mesh (text, version 1.x) | orbit, pan, zoom, wireframe, grid, auto-rotate, reset |
| Roblox mesh (binary, 2.0+) | not drawn — the panel says so and offers export |
| JSON, text | syntax-free text view |
| KTX, DDS and other compressed textures | not drawn — indexed and replaceable, export to view |

Where a format cannot be previewed, the panel says which format it found and
what can be done with it, rather than showing a broken image.

---

## FastFlags

Engine flags are a separate mechanism from assets: they change how the renderer
behaves, not what it draws from.

- Values are validated against the type the prefix implies (`FFlag` → boolean,
  `DFInt` → whole number, `FString` → text) before anything is written.
- Flags Blossom can describe carry a confidence level: `documented`,
  `community`, or `unverified` for anything you add yourself.
- The **Diff** view shows Roblox's own default beside your override. Where the
  default is not publicly known it says so rather than guessing.
- Roblox deletes the override file on every client update, which is why flags
  belong to a profile and are re-applied at launch rather than written once.

---

## Safety

Blossom's modding surface is deliberately limited to what the client draws.
Code injection, Lua execution, memory manipulation and anti-cheat interaction
are out of scope permanently — see [SECURITY.md](SECURITY.md).

Roblox's position on client modification is theirs to state, not ours to
summarise. Understand it before you use these features.
