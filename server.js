/**
 * server.js — Brick Breaker Multiplayer Server
 * Server-authoritative model: physics run here, state broadcast at 60fps.
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

// ─── Express + HTTP + Socket.IO Setup ────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ─── Game Constants ───────────────────────────────────────────────────────────
const CANVAS_W     = 800;
const CANVAS_H     = 600;
const BALL_RADIUS  = 8;
const BALL_SPEED   = 5;          // pixels per tick
const PADDLE_H     = 12;
const PADDLE_W     = 100;
const BRICK_ROWS   = 3;
const BRICK_COLS   = 10;
const BRICK_W      = 70;
const BRICK_H      = 20;
const BRICK_PAD    = 6;
const BRICK_TOP    = 50;         // y offset for brick grid
const PADDLE_Y_BASE = CANVAS_H - 40; // y position for all paddles

// ─── Game State ───────────────────────────────────────────────────────────────
let players = {};  // { socketId: { id, paddleX, color, name } }
let ball    = resetBall();
let bricks  = buildBricks();
let scores  = {};  // { socketId: number }

/** Build a fresh grid of bricks */
function buildBricks() {
  const grid = [];
  for (let r = 0; r < BRICK_ROWS; r++) {
    for (let c = 0; c < BRICK_COLS; c++) {
      grid.push({
        x:      c * (BRICK_W + BRICK_PAD) + BRICK_PAD + 20,
        y:      r * (BRICK_H + BRICK_PAD) + BRICK_TOP,
        w:      BRICK_W,
        h:      BRICK_H,
        alive:  true,
        row:    r   // row used for color tinting on client
      });
    }
  }
  return grid;
}

/** Reset the ball to center with a random downward angle */
function resetBall() {
  const angle = (Math.random() * 60 + 60) * (Math.PI / 180); // 60°–120° downward
  return {
    x:  CANVAS_W / 2,
    y:  CANVAS_H / 2,
    vx: Math.cos(angle) * BALL_SPEED * (Math.random() < 0.5 ? 1 : -1),
    vy: Math.sin(angle) * BALL_SPEED
  };
}

// ─── Physics Tick ─────────────────────────────────────────────────────────────
function tick() {
  if (Object.keys(players).length === 0) return; // pause when no players

  // Move ball
  ball.x += ball.vx;
  ball.y += ball.vy;

  // Wall bounce (left / right)
  if (ball.x - BALL_RADIUS <= 0) {
    ball.x = BALL_RADIUS;
    ball.vx = Math.abs(ball.vx);
  } else if (ball.x + BALL_RADIUS >= CANVAS_W) {
    ball.x = CANVAS_W - BALL_RADIUS;
    ball.vx = -Math.abs(ball.vx);
  }

  // Ceiling bounce
  if (ball.y - BALL_RADIUS <= 0) {
    ball.y = BALL_RADIUS;
    ball.vy = Math.abs(ball.vy);
  }

  // Brick collision
  for (const brick of bricks) {
    if (!brick.alive) continue;
    if (
      ball.x + BALL_RADIUS > brick.x &&
      ball.x - BALL_RADIUS < brick.x + brick.w &&
      ball.y + BALL_RADIUS > brick.y &&
      ball.y - BALL_RADIUS < brick.y + brick.h
    ) {
      brick.alive = false;
      ball.vy = -ball.vy;

      // Award point to all players equally (or pick closest paddle — kept minimal)
      for (const id in scores) scores[id]++;

      // Rebuild bricks if all cleared
      if (bricks.every(b => !b.alive)) {
        bricks = buildBricks();
        io.emit('message', '🎉 All bricks cleared! New round!');
      }
      break; // one brick per tick
    }
  }

  // Paddle collision — check every player's paddle
  for (const id in players) {
    const p = players[id];
    const px = p.paddleX;
    const py = PADDLE_Y_BASE;

    if (
      ball.vy > 0 &&                              // moving downward
      ball.y + BALL_RADIUS >= py &&
      ball.y + BALL_RADIUS <= py + PADDLE_H + 4 && // small tolerance
      ball.x >= px &&
      ball.x <= px + PADDLE_W
    ) {
      // Angle the reflect based on hit position relative to paddle center
      const hitPos  = (ball.x - (px + PADDLE_W / 2)) / (PADDLE_W / 2); // -1 to 1
      const angle   = hitPos * (Math.PI / 3); // max 60° deflection
      const speed   = Math.hypot(ball.vx, ball.vy);
      ball.vx = Math.sin(angle) * speed;
      ball.vy = -Math.abs(Math.cos(angle) * speed);
      ball.y  = py - BALL_RADIUS - 1; // pop out of paddle
    }
  }

  // Ball fell below paddle line → reset
  if (ball.y - BALL_RADIUS > CANVAS_H) {
    ball = resetBall();
    io.emit('message', '💥 Ball lost! Resetting…');
  }
}

// ─── Game Loop at 60fps ───────────────────────────────────────────────────────
setInterval(() => {
  tick();

  io.emit('state', {
    ball,
    players,   // { id: { paddleX, color, name } }
    bricks,
    scores
  });
}, 1000 / 60);

// ─── Socket.IO Events ─────────────────────────────────────────────────────────
const PLAYER_COLORS = ['#00f5d4', '#f72585', '#fee440', '#4cc9f0', '#b5179e', '#3a86ff'];
let colorIndex = 0;

io.on('connection', (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);

  // Assign player a paddle starting at center
  players[socket.id] = {
    id:      socket.id,
    paddleX: CANVAS_W / 2 - PADDLE_W / 2,
    color:   PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length],
    name:    `P${Object.keys(players).length}`
  };
  scores[socket.id] = 0;

  // Send the new player their own ID + current bricks
  socket.emit('init', { playerId: socket.id, bricks, CANVAS_W, CANVAS_H });
  io.emit('message', `${players[socket.id].name} joined!`);

  // Client sends its paddle X position
  socket.on('paddleMove', (x) => {
    if (!players[socket.id]) return;
    // Clamp to canvas bounds
    players[socket.id].paddleX = Math.max(0, Math.min(CANVAS_W - PADDLE_W, x));
  });

  socket.on('disconnect', () => {
    console.log(`[-] Player disconnected: ${socket.id}`);
    const name = players[socket.id]?.name;
    delete players[socket.id];
    delete scores[socket.id];
    if (name) io.emit('message', `${name} left.`);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Brick Breaker server running → http://localhost:${PORT}`);
});
