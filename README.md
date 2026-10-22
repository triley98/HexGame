# HexFront

A static hex strategy game with optional online rooms.

## Multiplayer backend

Online rooms use Firebase Realtime Database and anonymous Firebase Authentication. The Firebase project is `hexfront-multiplayer`, and the default database is hosted in `us-central1` on the Firebase Spark plan.

`firebase-config.js` contains the public web app configuration. It must not contain Firebase Admin credentials or service account keys. Database authorization is enforced by `database.rules.json`; the currently deployed rules permit room participants to read game state and only the player whose turn it is to write it.

The GitHub Pages origin `triley98.github.io` is authorized for Firebase Authentication. Anonymous sign-in is enabled. To use a different deployment domain, add that hostname under Firebase Authentication → Settings → Authorized domains.

Rooms use random 10-character codes. The host shares the code, the second player enters it on the home screen, and the game state syncs through the database. This is a lightweight peer-authoritative implementation intended for casual play; clients are not protected against a participant deliberately modifying game state.

## Local deployment

The project has no build step. Serve `index.html`, `style.css`, `game.js`, `firebase-config.js`, and `multiplayer.js` from the same HTTPS site. Firebase's browser SDK is imported from the official Firebase CDN.
