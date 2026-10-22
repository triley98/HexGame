import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/13.0.0";
const [appApi, authApi, dbApi] = await Promise.all([
  import(`${SDK}/firebase-app.js`),
  import(`${SDK}/firebase-auth.js`),
  import(`${SDK}/firebase-database.js`)
]);

let auth;
let db;
let user;

async function connect() {
  if (!firebaseConfig.databaseURL) {
    throw new Error("Firebase Realtime Database is not configured yet.");
  }
  if (!auth) {
    const app = appApi.initializeApp(firebaseConfig);
    auth = authApi.getAuth(app);
    db = dbApi.getDatabase(app);
  }
  if (!user) {
    const currentUser = await new Promise(resolve => {
      const unsubscribe = authApi.onAuthStateChanged(auth, value => {
        unsubscribe();
        resolve(value);
      });
    });
    user = currentUser || (await authApi.signInAnonymously(auth)).user;
  }
  return user;
}

function roomPath(code, leaf = "") {
  return `rooms/${code}${leaf ? `/${leaf}` : ""}`;
}

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join("");
}

export async function createRoom(initialState) {
  const player = await connect();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const exists = await dbApi.get(dbApi.ref(db, roomPath(code, "players")));
    if (exists.exists()) continue;
    await dbApi.set(dbApi.ref(db, roomPath(code, "players/0")), player.uid);
    await dbApi.set(dbApi.ref(db, roomPath(code, "state")), initialState);
    return { code, player: 0 };
  }
  throw new Error("Could not reserve a room code. Please try again.");
}

export async function joinRoom(rawCode) {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 10) throw new Error("Room codes are 10 characters long.");
  const player = await connect();
  const playersRef = dbApi.ref(db, roomPath(code, "players"));
  const players = await dbApi.get(playersRef);
  if (!players.exists() || !players.child("0").exists()) {
    throw new Error("That room was not found. Check the code and try again.");
  }
  if (players.child("0").val() === player.uid) return { code, player: 0, state: await loadRoom(code) };
  if (players.child("1").val() === player.uid) return { code, player: 1, state: await loadRoom(code) };
  const secondSeatRef = dbApi.ref(db, roomPath(code, "players/1"));
  const result = await dbApi.runTransaction(secondSeatRef, current => {
    if (current === null) return player.uid;
    return undefined;
  }, { applyLocally: false });
  if (!result.committed) throw new Error("That room already has two players.");
  return { code, player: 1, state: await loadRoom(code) };
}

export async function loadRoom(code) {
  const state = await dbApi.get(dbApi.ref(db, roomPath(code, "state")));
  if (!state.exists()) throw new Error("That room has not finished starting yet.");
  return state.val();
}

export function listenRoom(code, onState, onPlayers, onError) {
  const stopState = dbApi.onValue(
    dbApi.ref(db, roomPath(code, "state")),
    snapshot => { if (snapshot.exists()) onState(snapshot.val()); },
    onError
  );
  const stopPlayers = dbApi.onValue(
    dbApi.ref(db, roomPath(code, "players")),
    snapshot => onPlayers(snapshot.val() || {}),
    onError
  );
  return () => { stopState(); stopPlayers(); };
}

export async function saveRoomState(code, state) {
  await connect();
  await dbApi.set(dbApi.ref(db, roomPath(code, "state")), state);
}
