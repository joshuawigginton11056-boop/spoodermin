// Static file host + WebSocket game server.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { Room } from './game.js';
import { TICK_MS, MATCH } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
// three.js is served straight out of node_modules; the client uses an import
// map so there is no build step at all.
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, phase: room.phase, players: room.players.size, alive: room.alivePlayers().length });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const room = new Room('main');

wss.on('connection', (socket, req) => {
  let player = null;

  const url = new URL(req.url, 'http://localhost');
  const wanted = (url.searchParams.get('name') || '').slice(0, 14);

  if (room.players.size >= MATCH.MAX_PLAYERS + 4) {
    socket.send(JSON.stringify({ t: 'full' }));
    socket.close();
    return;
  }

  player = room.addSocketPlayer(socket, wanted);
  socket.send(JSON.stringify(room.welcomePacket(player)));
  room.broadcast({ t: 'joined', player: { id: player.id, name: player.name, skin: player.skin, bot: false } });
  console.log(`[+] ${player.name} (#${player.id}) connected — ${room.players.size} in room`);

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    room.onMessage(player, msg);
  });

  socket.on('close', () => {
    if (!player) return;
    console.log(`[-] ${player.name} (#${player.id}) disconnected`);
    room.broadcast({ t: 'left', id: player.id, name: player.name });
    room.removePlayer(player.id);
  });

  socket.on('error', () => socket.close());
});

setInterval(() => {
  try { room.tick(); } catch (err) { console.error('tick error', err); }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`\n  SPOODERMIN server listening on http://localhost:${PORT}\n`);
});
