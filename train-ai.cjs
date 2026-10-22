const fs = require('node:fs');
const vm = require('node:vm');

const STEPS = 10000;
const source = fs.readFileSync('game.js', 'utf8')
  .replace(/function render\(\)[\s\S]*?function gameData\(/, 'function render(){}function rowInset(r){return Math.max(0,10-Math.min(r,29-r))}function gameData(')
  .replace(/render\(\);\s*$/, '');
const policy = Array.from({ length: 162 }, () => Array(8).fill(0));
let seed = 0x51a7e;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const app = { querySelector: () => null, set innerHTML(_v) {} };
const document = {
  querySelector: (s) => s === '#app' ? app : null, getElementById: () => null, createElement: () => ({ classList: { add() {} } }),
  body: { insertAdjacentHTML() {}, appendChild() {} }
};
const window = { HEX_AI_POLICY: { q: policy }, scrollY: 0, scrollTo() {} };
const context = vm.createContext({ document, window, Math: Object.create(Math), setTimeout: () => 0, clearTimeout() {}, alert() {}, Blob: function() {}, URL: { createObjectURL() {}, revokeObjectURL() {} } });
context.Math.random = random;
vm.runInContext(`${source}\nglobalThis.api={S,UNIT,fresh,aiTurn,aiStateIndex,AI_STYLES,AI_STYLE_NAMES,dist,goldPos,rowInset};`, context);
const H = context.api;
const counts = Array(8).fill(0), wins = [0, 0], decisionsPerGame = [];
let gameSteps = 0, games = 0, lastTransition = null;
const alpha = 0.16, gamma = 0.92;

function reset() {
  H.S.screen = 'game'; H.S.mode = 'ai'; H.S.turn = 1; H.S.round = 1;
  H.S.gold = [4, 5]; H.S.energy = [10, 10]; H.S.units = []; H.S.aiTargets = {};
  H.S.aiPlan = null; H.S.selected = null; H.fresh(); gameSteps = 0; lastTransition = null;
}
function swapPerspective() {
  for (const u of H.S.units) {
    if (u.side === 0) u.side = 1; else if (u.side === 1) u.side = 0;
    u.q = 39 - u.q; u.r = 29 - u.r;
  }
  H.S.gold.reverse(); H.S.energy.reverse(); H.S.aiTargets = {};
  H.S.round = Math.max(1, H.S.round);
}
function value() {
  let v = (H.S.gold[1] - H.S.gold[0]) * 0.12 + (H.S.energy[1] - H.S.energy[0]) * 0.025;
  for (const u of H.S.units) {
    const sideSign = u.side === 1 ? 1 : u.side === 0 ? -1 : 0;
    const worth = u.type === 'commander' ? 4 + u.hp * 0.8 : u.type === 'miner' ? 1.4 : 1.1 + u.hp * 0.45;
    v += sideSign * worth;
    if (u.type === 'miner') {
      const reachableDeposit = H.goldPos().some(g => (u.side === 1 ? g.r >= 15 : g.r <= 14) && H.dist(u, g) <= 2);
      if (reachableDeposit) v += sideSign * 0.35;
      if (H.goldPos().some(g => H.dist(u, g) === 1)) v += sideSign * 1.2;
    }
  }
  return v;
}
function maxQ(s) { return Math.max(...policy[s]); }
function update(t, reward, nextState, terminal = false) {
  if (!t) return;
  const target = reward + (terminal ? 0 : gamma * maxQ(nextState));
  policy[t.state][t.action] += alpha * (target - policy[t.state][t.action]);
}
function commander(side) { return H.S.units.some(u => u.side === side && u.type === 'commander'); }

while (counts.reduce((a, b) => a + b, 0) < STEPS) {
  if (gameSteps === 0) { reset(); games++; }
  const actingAsOriginalZero = gameSteps % 2 === 1;
  if (actingAsOriginalZero) swapPerspective();
  H.S.screen = 'game'; H.S.turn = 1;
  H.S.round = Math.floor(gameSteps / 2) + 1;
  const state = H.aiStateIndex();
  const epsilon = 0.28 - 0.20 * Math.min(1, counts.reduce((a, b) => a + b, 0) / STEPS);
  let action;
  if (random() < epsilon) action = Math.floor(random() * 8);
  else {
    const best = Math.max(...policy[state]);
    const ties = policy[state].map((q, i) => q === best ? i : -1).filter(i => i >= 0);
    action = ties[Math.floor(random() * ties.length)];
  }
  const styleName = H.AI_STYLE_NAMES[action];
  const base = H.AI_STYLES[styleName];
  const secondaryIndex = (action + 1 + Math.floor(random() * 7)) % 8;
  const secondary = H.AI_STYLES[H.AI_STYLE_NAMES[secondaryIndex]];
  const weights = {};
  for (const k of Object.keys(base)) weights[k] = base[k] * 0.7 + secondary[k] * 0.3;
  H.S.aiPlan = { weights, style: styleName, locked: true };
  const before = value();
  H.aiTurn();
  const after = value();
  let reward = Math.max(-8, Math.min(8, after - before));
  counts[action]++;
  gameSteps++;
  const actorOriginalSide = actingAsOriginalZero ? 0 : 1;
  if (!commander(0) || !commander(1)) {
    const winner = commander(1) ? actorOriginalSide : 1 - actorOriginalSide;
    if (winner === actorOriginalSide) reward += 24;
    update(lastTransition, -24, state, true);
    wins[winner]++;
    update({ state, action }, reward, state, true);
    decisionsPerGame.push(gameSteps); gameSteps = 0; lastTransition = null;
  } else {
    swapPerspective();
    const nextStateForPreviousActor = H.aiStateIndex();
    swapPerspective();
    update(lastTransition, -reward, nextStateForPreviousActor);
    lastTransition = { state, action };
    if (gameSteps >= 120) {
      update(lastTransition, -1, nextState); decisionsPerGame.push(gameSteps); gameSteps = 0; lastTransition = null;
    }
  }
  if (actingAsOriginalZero) swapPerspective();
}

const trainedSteps = counts.reduce((a, b) => a + b, 0);
const report = {
  version: 'qlearn-10000', trainingSteps: trainedSteps, episodes: decisionsPerGame.length,
  wins, draws: decisionsPerGame.length - wins[0] - wins[1], averageDecisions: +(decisionsPerGame.reduce((a, b) => a + b, 0) / Math.max(1, decisionsPerGame.length)).toFixed(1),
  actionCounts: Object.fromEntries(H.AI_STYLE_NAMES.map((name, i) => [name, counts[i]])),
  trainedAt: new Date().toISOString(), stateCount: policy.length, actions: H.AI_STYLE_NAMES
};
const rows = JSON.stringify(policy.map(row => row.map(x => +x.toFixed(4))));
fs.writeFileSync('ai-policy.js', `// Learned by train-ai.cjs: ${trainedSteps} self-play Q-learning decisions.\nwindow.HEX_AI_POLICY=${JSON.stringify(report, null, 2).replace(/\n/g, '\n')} ;\nwindow.HEX_AI_POLICY.q=${rows};\n`);
console.log(JSON.stringify(report, null, 2));
