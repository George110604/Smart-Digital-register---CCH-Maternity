# Smart Digital Register with Clinical Decision Support (CCH Maternity prototype)

Offline-first web app: patient register, observations by stage (antenatal, labour, postnatal, newborn),
rule-based decision support alerts, alert acknowledgement/override logging, dashboard indicators,
SUS questionnaire, anonymised CSV export for SPSS/SmartPLS, role-based login and audit trail.

## Run it
1. Install Node.js 22.13 or newer (LTS) from https://nodejs.org
2. Open this folder in Visual Studio Code (File > Open Folder), then Terminal > New Terminal
3. `npm test`   (optional: confirms the backend works)
4. `npm start`
5. Open http://localhost:3000

Demo logins (change them in Admin > Change my password, and create real users):
admin/admin123, midwife1/midwife123, doctor1/doctor123, records1/records123

## Files
- server.js       backend API + SQLite database (data/register.db is created automatically)
- public/rules.js decision support rules (shared by server and browser; EDIT THRESHOLDS HERE)
- public/app.js   user interface, offline queue (IndexedDB), sync
- public/sw.js    service worker (lets the app open offline)
- test.js         automated backend test

## Before real clinical use
Thresholds in rules.js are illustrative. They need sign-off by your clinical advisory panel,
the system needs HTTPS, hospital approval and MRCZ ethics clearance, and passwords must be changed.
Run in parallel with the paper register; alerts are advisory only.

## Putting it online
See START-HERE.md (Render + GitHub, step by step).
