const fs = require('node:fs');
const vm = require('node:vm');

const EPISODES = Number(process.env.HEX_TRAIN_EPISODES) || 10000;
const POLICY_OUT = process.env.HEX_POLICY_OUT || 'ai-policy.js';
const MAX_DECISIONS_PER_GAME = 120;
const GAME_SOURCE = fs.readFileSync('game.js', 'utf8')
  .replace(/function render\(\)[\s\S]*?function gameData\(/, 'function render(){}function rowInset(r){return Math.max(0,10-Math.min(r,29-r))}function gameData(')
  .replace(/render\(\);\s*$/, '');
const savedPolicy = { window: {} };
vm.runInNewContext(fs.readFileSync('ai-policy.js', 'utf8'), savedPolicy);
const policy = savedPolicy.window.HEX_AI_POLICY.q.map(row => row.slice());

let seed = 0x20261022;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const app = { querySelector: () => null, set innerHTML(_value) {} };
const document = {
  querySelector: selector => selector === '#app' ? app : null,
  getElementById: () => null,
  createElement: () => ({ classList: { add() {} } }),
  body: { insertAdjacentHTML() {}, appendChild() {} }
};
const window = { HEX_AI_POLICY: { q: policy }, scrollY: 0, scrollTo() {} };
const context = vm.createContext({ document, window, Math: Object.create(Math), setTimeout: () => 0, clearTimeout() {}, alert() {}, Blob: function() {}, URL: { createObjectURL() {}, revokeObjectURL() {} } });
context.Math.random = random;
vm.runInContext(`${GAME_SOURCE}\nglobalThis.api={S,UNIT,fresh,aiTurn,aiStateIndex,AI_STYLES,AI_STYLE_NAMES,dist,goldPos};`, context);
const H = context.api;
const actionCounts = Array(8).fill(0), wins = [0, 0];
let draws = 0, totalDecisions = 0, decisionsSum = 0;
const alpha = 0.12, gamma = 0.9;

function reset() {
  H.S.screen = 'game'; H.S.mode = 'ai'; H.S.turn = 1; H.S.round = 1;
  H.S.gold = [4, 5]; H.S.energy = [10, 10]; H.S.units = []; H.S.aiTargets = {};
  H.S.aiPlan = null; H.S.selected = null; H.fresh();
}
function swapPerspective() {
  for (const unit of H.S.units) {
    if (unit.side === 0) unit.side = 1; else if (unit.side === 1) unit.side = 0;
    unit.q = 39 - unit.q; unit.r = 29 - unit.r;
  }
  H.S.gold.reverse(); H.S.energy.reverse(); H.S.aiTargets = {};
}
function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function strategyScore(weights) {
  const own = H.S.units.filter(unit => unit.side === 1);
  const enemies = H.S.units.filter(unit => unit.side === 0);
  const ownCommander = own.find(unit => unit.type === 'commander');
  const enemyCommander = enemies.find(unit => unit.type === 'commander');
  const ownMiners = own.filter(unit => unit.type === 'miner');
  const enemyMiners = enemies.filter(unit => unit.type === 'miner');
  const fighters = own.filter(unit => unit.type !== 'miner' && unit.type !== 'commander');
  const enemyFighters = enemies.filter(unit => unit.type !== 'miner');
  const rangers = own.filter(unit => unit.type === 'ranger');
  const archers = own.filter(unit => unit.type === 'archer');
  const nearestEnemyMiner = fighters.map(fighter => enemyMiners.length ? Math.min(...enemyMiners.map(miner => H.dist(fighter, miner))) : 12);
  const pairDistances = [];
  for (let i = 0; i < fighters.length; i++) for (let j = i + 1; j < fighters.length; j++) pairDistances.push(Math.min(8, H.dist(fighters[i], fighters[j])));
  const nearestAlly = fighters.map(unit => {
    const others = fighters.filter(other => other.id !== unit.id);
    return others.length ? Math.min(...others.map(other => H.dist(unit, other))) : 8;
  });
  const guardDistances = ownMiners.map(miner => fighters.length ? Math.min(...fighters.map(fighter => H.dist(miner, fighter))) : 8);
  const rangeDistances = archers.flatMap(archer => enemyFighters.map(enemy => Math.abs(H.dist(archer, enemy) - 3)));
  const enemyCommanderDistance = ownCommander && enemyCommander ? H.dist(ownCommander, enemyCommander) : 30;
  const nearestFighterToCommander = enemyCommander && fighters.length ? Math.min(...fighters.map(fighter => H.dist(fighter, enemyCommander))) : 30;
  const commanderDanger = ownCommander && enemies.some(enemy => enemy.type !== 'miner' && H.dist(enemy, ownCommander) <= 5) ? 1 : 0;

  const goals = {
    aggressive: -0.32 * nearestFighterToCommander - 0.16 * enemyCommanderDistance,
    passive: 0.22 * H.S.gold[1] + 0.12 * own.length - 2.5 * commanderDanger,
    minerSniping: -1.6 * enemyMiners.length - 0.2 * average(nearestEnemyMiner),
    spread: 0.28 * average(pairDistances),
    clump: -0.38 * average(nearestAlly),
    protect: -0.38 * average(guardDistances),
    rangerFocus: 1.35 * rangers.length - 0.12 * average(rangers.map(ranger => enemyCommander ? H.dist(ranger, enemyCommander) : 20)),
    archerFocus: 1.3 * archers.length - 0.18 * average(rangeDistances)
  };
  return Object.entries(goals).reduce((score, [key, goal]) => score + (weights[key] || 0) * goal, 0);
}
function value(weights) {
  let score = (H.S.gold[1] - H.S.gold[0]) * 0.13 + (H.S.energy[1] - H.S.energy[0]) * 0.025;
  for (const unit of H.S.units) {
    const sign = unit.side === 1 ? 1 : unit.side === 0 ? -1 : 0;
    const worth = unit.type === 'commander' ? 4 + unit.hp * 0.9 : unit.type === 'miner' ? 1.6 : 1.2 + unit.hp * 0.55;
    score += sign * worth;
    if (unit.type === 'miner') {
      const sideDeposit = H.goldPos().some(g => (unit.side === 1 ? g.r >= 14 : g.r <= 14) && H.dist(unit, g) <= 2);
      if (sideDeposit) score += sign * 0.5;
      if (H.goldPos().some(g => H.dist(unit, g) === 1)) score += sign * 1.5;
    }
  }
  return score + strategyScore(weights);
}
function maxQ(state) { return Math.max(...policy[state]); }
function update(state, action, reward, nextState, terminal = false) {
  const target = reward + (terminal ? 0 : gamma * maxQ(nextState));
  policy[state][action] += alpha * (target - policy[state][action]);
}
function commanderAlive(side) { return H.S.units.some(unit => unit.side === side && unit.type === 'commander'); }
function clampReward(reward) { return Math.max(-10, Math.min(10, reward)); }

for (let episode = 1; episode <= EPISODES; episode++) {
  reset();
  let decisions = 0, previous = null, finished = false;
  while (!finished && decisions < MAX_DECISIONS_PER_GAME) {
    const playingAsOriginalZero = decisions % 2 === 1;
    if (playingAsOriginalZero) swapPerspective();
    H.S.screen = 'game'; H.S.turn = 1; H.S.round = Math.floor(decisions / 2) + 1;
    const state = H.aiStateIndex();
    const epsilon = 0.2 - 0.16 * Math.min(1, (episode - 1) / (EPISODES - 1));
    let action;
    if (random() < epsilon) action = Math.floor(random() * 8);
    else {
      const best = Math.max(...policy[state]);
      const ties = policy[state].map((q, index) => q === best ? index : -1).filter(index => index >= 0);
      action = ties[Math.floor(random() * ties.length)];
    }
    const primary = H.AI_STYLE_NAMES[action];
    const secondaryIndex = (action + 1 + Math.floor(random() * 7)) % 8;
    const weights = {};
    const base = H.AI_STYLES[primary], secondary = H.AI_STYLES[H.AI_STYLE_NAMES[secondaryIndex]];
    for (const key of Object.keys(base)) weights[key] = base[key] * 0.7 + secondary[key] * 0.3;
    H.S.aiPlan = { weights, style: primary, locked: true };
    const before = value(weights);
    H.aiTurn();
    const after = value(weights);
    let reward = clampReward(after - before);
    actionCounts[action]++; totalDecisions++; decisions++;
    const actor = playingAsOriginalZero ? 0 : 1;
    const ownAlive = commanderAlive(1), enemyAlive = commanderAlive(0);
    const terminal = !ownAlive || !enemyAlive;
    if (terminal) {
      const winner = ownAlive ? actor : 1 - actor;
      if (ownAlive && !enemyAlive) reward += 36;
      else reward -= 36;
      update(state, action, reward, state, true);
      if (previous) update(previous.state, previous.action, winner === actor ? -36 : 36, state, true);
      wins[winner]++;
      finished = true;
    } else {
      const nextState = H.aiStateIndex();
      update(state, action, reward, nextState);
      if (previous) {
        swapPerspective();
        const previousActorNextState = H.aiStateIndex();
        swapPerspective();
        update(previous.state, previous.action, -reward, previousActorNextState);
      }
      previous = { state, action };
      if (playingAsOriginalZero) swapPerspective();
    }
    if (terminal && playingAsOriginalZero) swapPerspective();
  }
  if (!finished) {
    draws++;
    if (previous) update(previous.state, previous.action, -2, previous.state, true);
  }
  decisionsSum += decisions;
  if (episode % 1000 === 0) {
    process.stdout.write(`Completed ${episode}/${EPISODES} episodes (${totalDecisions} AI turns; wins ${wins[0]}–${wins[1]}, draws ${draws})\n`);
    fs.writeFileSync('.ai-policy-training-checkpoint.json', JSON.stringify({ episode, totalDecisions, wins, draws, q: policy }));
  }
}

const report = {
  version: 'qlearn-10000-episodes', episodes: EPISODES, trainingDecisions: totalDecisions,
  wins, draws, averageDecisions: +(decisionsSum / EPISODES).toFixed(1),
  actionCounts: Object.fromEntries(H.AI_STYLE_NAMES.map((name, index) => [name, actionCounts[index]])),
  trainedAt: new Date().toISOString(), stateCount: policy.length, actions: H.AI_STYLE_NAMES,
  rewardFocus: ['commander aggression', 'passive economy', 'miner denial', 'force spread', 'force cohesion', 'miner protection', 'ranger recruitment and advance', 'archer recruitment and firing positions']
};
const rows = JSON.stringify(policy.map(row => row.map(score => +score.toFixed(4))));
fs.writeFileSync(POLICY_OUT, `// Learned by train-ai.cjs: ${EPISODES} self-play reinforcement-learning episodes.\nwindow.HEX_AI_POLICY=${JSON.stringify(report, null, 2)};\nwindow.HEX_AI_POLICY.q=${rows};\n`);
fs.rmSync('.ai-policy-training-checkpoint.json', { force: true });
console.log(JSON.stringify(report, null, 2));
