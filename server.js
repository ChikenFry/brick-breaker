/**
 * server.js — Brick Breaker Multiplayer (Mobile-Ready)
 * Server-authoritative: physics run here, state broadcast at 60fps.
 * Render.com free tier compatible.
 */

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const path           = require('path');

// ── App Setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  // Prefer websocket first; polling as fallback for restricted mobile networks
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

// Render.com requires binding to process.env.PORT
const PORT = process.env.PORT || 3000;

// ── Game Constants ───────────────────────────────────────────────────────────
// 400x600 logical units — client scales to fit any screen size
const W          = 400;
const H          = 600;
const BALL_R     = 7;
const BALL_SPEED = 4.5;
const PAD_H      = 10;
const PAD_Y      = H - 36;
const BRICK_COLS = 8;
const BRICK_ROWS = 4;
const BRICK_W    = Math.floor((W - 20) / BRICK_COLS) - 4;
const BRICK_H    = 16;
const BRICK_PAD  = 4;
const BRICK_TOP  = 44;

// ── Player Colors ────────────────────────────────────────────────────────────
const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#457b9d', '#f4a261', '#a8dadc'];
let colorIdx = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
// Divide game width equally — always visibly shorter with each new player
function computePadW(n) {
  return Math.max(20, Math.floor((W - 20) / n));
}

// Space all paddles evenly so they never start overlapping after a resize
function redistributePaddles(padW) {
  const ids = Object.keys(players);
  const n   = ids.length;
  ids.forEach((id, i) => {
    const zoneW           = W / n;
    players[id].padW    = padW;
    players[id].paddleX = Math.round(zoneW * i + (zoneW - padW) / 2);
  });
}

function makeBricks(hp = 1) {
  const list = [];
  for (let r = 0; r < BRICK_ROWS; r++) {
    for (let c = 0; c < BRICK_COLS; c++) {
      list.push({
        x:     10 + c * (BRICK_W + BRICK_PAD),
        y:     BRICK_TOP + r * (BRICK_H + BRICK_PAD),
        w:     BRICK_W,
        h:     BRICK_H,
        alive: true,
        hp,
        maxHp: hp,
        row:   r
      });
    }
  }
  return list;
}

function spawnBall() {
  const a = ((50 + Math.random() * 80) * Math.PI) / 180;
  return {
    x:  W / 2,
    y:  H / 2,
    vx: Math.cos(a) * BALL_SPEED * (Math.random() < 0.5 ? 1 : -1),
    vy: Math.sin(a) * BALL_SPEED
  };
}

// ── State ────────────────────────────────────────────────────────────────────
let players = {};
let scores  = {};
let balls   = [];          // one ball per player
let bricks  = makeBricks(1);

// ── Physics ──────────────────────────────────────────────────────────────────
function tick() {
  const playerCount = Object.keys(players).length;
  if (playerCount === 0) return;

  for (const ball of balls) {
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Walls
    if (ball.x - BALL_R <= 0) { ball.x = BALL_R;     ball.vx =  Math.abs(ball.vx); }
    if (ball.x + BALL_R >= W) { ball.x = W - BALL_R; ball.vx = -Math.abs(ball.vx); }
    if (ball.y - BALL_R <= 0) { ball.y = BALL_R;     ball.vy =  Math.abs(ball.vy); }

    // Bricks — N hits required (hp counts down to 0)
    for (const b of bricks) {
      if (!b.alive) continue;
      if (ball.x+BALL_R > b.x && ball.x-BALL_R < b.x+b.w &&
          ball.y+BALL_R > b.y && ball.y-BALL_R < b.y+b.h) {
        b.hp--;
        if (b.hp <= 0) {
          b.alive = false;
          for (const id in scores) scores[id]++;
          if (bricks.every(b => !b.alive)) {
            bricks = makeBricks(playerCount);
            io.emit('msg', 'All cleared!');
          }
        }
        ball.vy = -ball.vy;
        break;
      }
    }

    // Paddles — use per-player padW
    for (const id in players) {
      const p    = players[id];
      const padW = p.padW;
      if (ball.vy > 0 &&
          ball.y+BALL_R >= PAD_Y && ball.y+BALL_R <= PAD_Y+PAD_H+6 &&
          ball.x >= p.paddleX   && ball.x <= p.paddleX+padW) {
        const offset = (ball.x - (p.paddleX + padW/2)) / (padW/2);
        const angle  = offset * (Math.PI / 3);
        const spd    = Math.hypot(ball.vx, ball.vy);
        ball.vx = Math.sin(angle) * spd;
        ball.vy = -Math.abs(Math.cos(angle) * spd);
        ball.y  = PAD_Y - BALL_R - 1;
        break;
      }
    }
  }

  // Drop balls that fell off screen
  const prev = balls.length;
  balls = balls.filter(b => b.y - BALL_R <= H);
  if (balls.length < prev) io.emit('msg', 'Ball lost!');
  // Always keep at least one ball in play
  if (balls.length === 0) balls.push(spawnBall());
}

// ── Game Loop ────────────────────────────────────────────────────────────────
setInterval(() => {
  tick();
  io.emit('s', { balls, players, bricks, scores });
}, 1000 / 60);

// ── Sockets ───────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);
  const num      = Object.keys(players).length + 1;
  const newCount = num;
  const padW     = computePadW(newCount);

  // Add new player with a temp position, then redistribute everyone evenly
  players[socket.id] = {
    id:      socket.id,
    paddleX: 0,
    padW,
    color:   COLORS[colorIdx++ % COLORS.length],
    name:    'P' + num
  };
  scores[socket.id] = 0;
  redistributePaddles(padW);

  // One extra ball per player
  balls.push(spawnBall());

  // Reset bricks so each brick now requires newCount hits
  bricks = makeBricks(newCount);

  socket.emit('init', { id: socket.id, W, H, PAD_W: padW, PAD_H, PAD_Y, BALL_R });
  io.emit('msg', players[socket.id].name + ' joined');

  socket.on('p', x => {
    const me = players[socket.id];
    if (!me) return;
    const pw = me.padW;

    // Clamp to walls first
    let minX = 0;
    let maxX = W - pw;

    // Prevent overlap: find the nearest paddle on each side based on current position
    for (const id in players) {
      if (id === socket.id) continue;
      const other = players[id];
      if (other.paddleX >= me.paddleX + pw) {
        // Other is to our right — stop before their left edge
        maxX = Math.min(maxX, other.paddleX - pw);
      } else if (other.paddleX + other.padW <= me.paddleX) {
        // Other is to our left — stop at their right edge
        minX = Math.max(minX, other.paddleX + other.padW);
      }
    }

    me.paddleX = Math.max(minX, Math.min(maxX, x));
  });

  socket.on('disconnect', () => {
    const name = players[socket.id]?.name;
    delete players[socket.id];
    delete scores[socket.id];

    const remaining = Object.keys(players).length;
    if (remaining > 0) {
      const newPadW = computePadW(remaining);
      redistributePaddles(newPadW);
      if (balls.length > 1) balls.pop();
      bricks = makeBricks(remaining);
    } else {
      // Last player left — reset to blank slate
      balls  = [];
      bricks = makeBricks(1);
    }

    if (name) io.emit('msg', name + ' left');
  });
});

server.listen(PORT, () => console.log('Listening on', PORT));
