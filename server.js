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
const PAD_W      = 80;
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

// ── State ────────────────────────────────────────────────────────────────────
let players = {};
let scores  = {};
let ball    = spawnBall();
let bricks  = makeBricks();

function makeBricks() {
  const list = [];
  for (let r = 0; r < BRICK_ROWS; r++) {
    for (let c = 0; c < BRICK_COLS; c++) {
      list.push({
        x: 10 + c * (BRICK_W + BRICK_PAD),
        y: BRICK_TOP + r * (BRICK_H + BRICK_PAD),
        w: BRICK_W,
        h: BRICK_H,
        alive: true,
        row: r
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

// ── Physics ──────────────────────────────────────────────────────────────────
function tick() {
  if (Object.keys(players).length === 0) return;

  ball.x += ball.vx;
  ball.y += ball.vy;

  // Walls
  if (ball.x - BALL_R <= 0) { ball.x = BALL_R;     ball.vx =  Math.abs(ball.vx); }
  if (ball.x + BALL_R >= W) { ball.x = W - BALL_R; ball.vx = -Math.abs(ball.vx); }
  if (ball.y - BALL_R <= 0) { ball.y = BALL_R;     ball.vy =  Math.abs(ball.vy); }

  // Bricks
  for (const b of bricks) {
    if (!b.alive) continue;
    if (ball.x+BALL_R > b.x && ball.x-BALL_R < b.x+b.w &&
        ball.y+BALL_R > b.y && ball.y-BALL_R < b.y+b.h) {
      b.alive = false;
      ball.vy = -ball.vy;
      for (const id in scores) scores[id]++;
      if (bricks.every(b => !b.alive)) { bricks = makeBricks(); io.emit('msg', 'All cleared!'); }
      break;
    }
  }

  // Paddles
  for (const id in players) {
    const p = players[id];
    if (ball.vy > 0 &&
        ball.y+BALL_R >= PAD_Y && ball.y+BALL_R <= PAD_Y+PAD_H+6 &&
        ball.x >= p.paddleX   && ball.x <= p.paddleX+PAD_W) {
      const offset = (ball.x - (p.paddleX + PAD_W/2)) / (PAD_W/2);
      const angle  = offset * (Math.PI / 3);
      const spd    = Math.hypot(ball.vx, ball.vy);
      ball.vx = Math.sin(angle) * spd;
      ball.vy = -Math.abs(Math.cos(angle) * spd);
      ball.y  = PAD_Y - BALL_R - 1;
      break;
    }
  }

  // Reset
  if (ball.y - BALL_R > H) { ball = spawnBall(); io.emit('msg', 'Ball lost!'); }
}

// ── Game Loop ────────────────────────────────────────────────────────────────
setInterval(() => {
  tick();
  io.emit('s', { ball, players, bricks, scores });
}, 1000 / 60);

// ── Sockets ───────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);
  const num = Object.keys(players).length + 1;
  players[socket.id] = {
    id: socket.id,
    paddleX: W/2 - PAD_W/2,
    color: COLORS[colorIdx++ % COLORS.length],
    name: 'P' + num
  };
  scores[socket.id] = 0;

  // Send constants so client renders in correct coordinate space
  socket.emit('init', { id: socket.id, W, H, PAD_W, PAD_H, PAD_Y, BALL_R });
  io.emit('msg', players[socket.id].name + ' joined');

  socket.on('p', x => {
    if (players[socket.id])
      players[socket.id].paddleX = Math.max(0, Math.min(W - PAD_W, x));
  });

  socket.on('disconnect', () => {
    const name = players[socket.id]?.name;
    delete players[socket.id];
    delete scores[socket.id];
    if (name) io.emit('msg', name + ' left');
  });
});

server.listen(PORT, () => console.log('Listening on', PORT));
