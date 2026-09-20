# Blossom Strap — Security

Blossom Strap is a local customization and configuration tool. This document
states what it does to your machine, what it deliberately does not do, and where
the boundaries are enforced in code.

---

## 1. Out of scope, permanently

Blossom Strap does not, and will not, implement:

- code injection, DLL injection or any form of process hollowing
- arbitrary Lua execution inside the client
- memory reading or writing against the Roblox process
- anti-cheat detection, evasion or interference
- credential, cookie, session or token access
- anything intended to obtain an advantage the client does not offer locally

These are not "not yet" items. The architecture has no seam where they would
fit: nothing in Blossom opens a handle to the Roblox process, and the only
Roblox-owned files it writes are the flag override file and the certificate
bundle, both of which are backed up and both of which `Repair` removes.

Asset replacement is a local rendering substitution. It changes what your own
client draws. It does not change what the server sends, what other players see,
or what the client reports.

---

## 2. What Blossom writes

Everything Blossom creates lives under `%LOCALAPPDATA%\BlossomStrap\`.

Outside that folder, Blossom writes exactly three things, all of them optional
and all of them reversible:

| Target | When | Reversed by |
|---|---|---|
| `<version>\ClientSettings\ClientAppSettings.json` | a profile has FastFlags | launch restore, `Repair`, or Clear from Roblox |
| `<version>\ssl\cacert.pem` (one fenced block) | the user installs the interception certificate | Remove certificate, or `Repair` |
| `<version>\content\...`, `ExtraContent\...` | the user has mod files | Restore, from the mod restore point |

Additionally, when the user turns them on:

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` — start with Windows
- `HKCU\Software\Classes\blossom-strap` — protocol handler

Both are per-user keys, and both are removed when the setting is turned off.

**Nothing is written machine-wide.** Blossom does not run elevated, does not
install a service, does not touch `HKLM`, does not modify the hosts file, does
not change the Windows proxy settings, and does not add anything to the Windows
certificate store.

Every write to a Roblox-owned file is preceded by a restore point that records
the file's prior contents — or records that it did not exist, which is what
makes "undo" able to delete it again.

---

## 3. The interception certificate

This is the most invasive thing Blossom can do, so it is the most constrained.

**What it is.** To read the client's asset requests, the proxy has to terminate
TLS, which means presenting a certificate the client trusts. Blossom generates a
2048-bit CA locally, stores it in the user's profile directory with owner-only
permissions, and uses it to mint short-lived leaf certificates for asset hosts.

**Where it goes.** Into `<version>\ssl\cacert.pem` — Roblox Player's own bundle —
inside a block fenced by sentinel comments, after the original file has been
captured in a restore point. The Windows trust store is never touched. No other
application on the machine, and no browser, is affected.

**How it is removed.** `stripBlock` removes exactly the fenced region and leaves
the rest of the file byte-for-byte unchanged. This is covered by tests,
including the case of a truncated block left by an interrupted write.

**What it can read.** Only hosts on the interception scope list. That list is a
*positive* allow-list of asset delivery hosts, checked in one function
(`src/main/interception/scope.ts`), and a second gate refuses authentication,
account, payment, presence and client-settings hosts even if a configuration
file asks for them. Everything out of scope is blind-tunnelled: Blossom sees the
hostname it was asked to connect to and nothing else.

**Consent.** The engine refuses to start until the certificate is installed, and
the install is refused unless the call carries an explicit confirmation flag.
The UI shows `interception:explain` — a literal list of every change, each
marked reversible — before the button that performs them.

---

## 4. Process boundaries

- The renderer runs with `nodeIntegration: false`, `contextIsolation: true` and
  `sandbox: true`. It has no `require`, no `process`, no module access.
- The preload script exposes two functions: `invoke` and `on`. Everything the UI
  can do is something a main-process handler chose to expose. This is asserted
  by a test that fails if the preload gains a reference to Node internals.
- Both HTML entry points declare `default-src 'none'`. The renderer loads no
  fonts, scripts, styles or images from the network.
- Navigation and window opening are refused; `https://` links are handed to the
  system browser instead.
- The overlay windows get a strictly receive-only bridge. They can be told
  things; they cannot ask for anything.

---

## 5. Input that comes from outside

| Source | Treated as | Handling |
|---|---|---|
| Profile and rule-set JSON | untrusted | coerced field by field, never `JSON.parse` straight into a typed object; invalid values fall back to defaults and are reported |
| FastFlag names and values | untrusted | validated against the type the prefix implies before anything is written |
| Rule sources (globs) | untrusted | every regex metacharacter escaped before wildcards are reintroduced, so a rule cannot become a pathological pattern |
| Blob hashes | untrusted | must match `^[0-9a-f]{64}$` before they are used to build a path |
| Restore point ids | untrusted | must match a strict character class and cannot contain `..` |
| Mod file paths | untrusted | resolved, then re-checked to be inside the version directory and under an allowed content root |
| `app:open-path` custom paths | untrusted | must be inside a directory Blossom owns |
| Replacement URLs | untrusted | `https://` only; `http:` and every other scheme is refused |
| Update manifests | untrusted | `https://` only, SHA-256 required, channel must match the one requested |
| Roblox's client-version API | untrusted | read-only, no credentials sent, failure means "unknown" |

---

## 6. What leaves the machine

Blossom makes outbound requests in exactly three situations:

1. **Client version check** — a `GET` to `clientsettingscdn.roblox.com`, no
   credentials, no identifiers.
2. **Update check and download** — only if update checking is on.
3. **Asset fetches through the proxy** — the client's own requests, forwarded.
   A `replace-url` rule fetches the URL the user configured.

There is no telemetry, no analytics, no crash reporting and no usage reporting.

Diagnostics reports are generated locally and go nowhere until the user copies
or saves one. Before that, they pass through the same redaction as the log
files: home directory paths, `C:\Users\<name>`, Roblox join tickets,
`.ROBLOSECURITY` cookies, browser tracker ids and bearer tokens are all replaced
with placeholders. This is covered by tests.

---

## 7. Supply chain

The application ships two runtime dependencies: `better-sqlite3` and
`node-forge`. Everything else is Node and Windows built-ins. Each dependency is
a liability that has to earn its place; a smaller surface is the only supply
chain defence that actually scales.

Updates are verified against a SHA-256 published in the release manifest. A
manifest without a checksum is refused, not warned about. A payload whose hash
does not match is deleted rather than kept for inspection. The running
executable is never overwritten in place; a separate updater performs the swap
after exit and rolls back if the new build fails to start.

---

## 8. Reporting a problem

Security issues should be reported privately rather than filed as public issues.
Please include the Blossom version, what you observed, and the smallest
reproduction you can manage.
