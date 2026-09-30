import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

/* ------------------------------------------------------------------ *
 *  Konfigurasi (semua bisa diatur lewat environment variable)
 * ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim() || "*"; // contoh: https://situs-kamu.vercel.app
const ADMIN_PIN = process.env.ADMIN_PIN?.trim() || ""; // kosong = panel host terbuka untuk semua
const MAX_NAME_LENGTH = 24;

const origin = CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((o) => o.trim());

/* ------------------------------------------------------------------ *
 *  Tipe data
 * ------------------------------------------------------------------ */
type Entry = { clientId: string; name: string; at: number };

type PublicEntry = { rank: number; name: string; delta: number };

type PublicState = {
  round: number;
  locked: boolean;
  players: number;
  entries: PublicEntry[];
};

type BuzzResult =
  | { ok: true; rank: number }
  | { ok: false; reason: "locked" | "already" | "invalid_name"; rank?: number };

type ServerToClientEvents = {
  state: (state: PublicState) => void;
  me: (me: { rank: number | null }) => void;
};

type SocketData = { clientId: string; role: "player" | "admin"; isAdmin: boolean };

/* ------------------------------------------------------------------ *
 *  State ronde (disimpan di memori server)
 * ------------------------------------------------------------------ */
let round = 1;
let locked = false;
let entries: Entry[] = [];

/* ------------------------------------------------------------------ *
 *  Server
 * ------------------------------------------------------------------ */
const app = express();
app.use(cors({ origin }));

app.get("/", (_req, res) => {
  res.json({ name: "Nexus.Art Buzz server", status: "ok", round, buzzed: entries.length });
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const httpServer = createServer(app);
// Event dari client divalidasi manual di handler (payload dianggap `unknown`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientToServerEvents = Record<string, (...args: any[]) => void>;

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  httpServer,
  { cors: { origin } },
);

/* ------------------------------------------------------------------ *
 *  Helper
 * ------------------------------------------------------------------ */
function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

function countPlayers(): number {
  let total = 0;
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role === "player") total++;
  }
  return total;
}

function rankOf(clientId: string): number | null {
  const idx = entries.findIndex((e) => e.clientId === clientId);
  return idx === -1 ? null : idx + 1;
}

function buildState(): PublicState {
  const first = entries[0]?.at ?? 0;
  return {
    round,
    locked,
    players: countPlayers(),
    entries: entries.map((e, i) => ({ rank: i + 1, name: e.name, delta: e.at - first })),
  };
}

/** Kirim state ke semua orang + info personal ("kamu urutan ke berapa") ke tiap pemain. */
function broadcast() {
  io.emit("state", buildState());
  for (const s of io.sockets.sockets.values()) {
    s.emit("me", { rank: rankOf(s.data.clientId) });
  }
}

function safePinMatch(input: unknown): boolean {
  if (!ADMIN_PIN) return true;
  if (typeof input !== "string" || input.length !== ADMIN_PIN.length) return false;
  let diff = 0;
  for (let i = 0; i < ADMIN_PIN.length; i++) {
    diff |= ADMIN_PIN.charCodeAt(i) ^ input.charCodeAt(i);
  }
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 *  Socket handlers
 * ------------------------------------------------------------------ */
io.on("connection", (socket) => {
  const auth = socket.handshake.auth as { clientId?: unknown; role?: unknown };
  const clientId =
    typeof auth.clientId === "string" && auth.clientId.length > 0 && auth.clientId.length <= 64
      ? auth.clientId
      : socket.id;

  socket.data.clientId = clientId;
  socket.data.role = auth.role === "admin" ? "admin" : "player";
  socket.data.isAdmin = false;

  // Pendatang baru (atau yang reconnect / refresh) langsung mendapat kondisi terbaru.
  socket.emit("state", buildState());
  socket.emit("me", { rank: rankOf(clientId) });
  if (socket.data.role === "player") broadcast();

  // --- Pemain menekan buzzer -----------------------------------------
  socket.on("buzz", (rawName: unknown, ack?: (result: BuzzResult) => void) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const name = cleanName(rawName);

    if (!name) return reply({ ok: false, reason: "invalid_name" });

    const existing = rankOf(clientId);
    if (existing !== null) return reply({ ok: false, reason: "already", rank: existing });

    if (locked) return reply({ ok: false, reason: "locked" });

    entries.push({ clientId, name, at: Date.now() });
    reply({ ok: true, rank: entries.length });
    broadcast();
  });

  // --- Autentikasi host ----------------------------------------------
  socket.on(
    "admin:auth",
    (pin: unknown, ack?: (r: { ok: boolean; pinRequired: boolean }) => void) => {
      const ok = safePinMatch(pin);
      socket.data.isAdmin = ok;
      if (typeof ack === "function") ack({ ok, pinRequired: ADMIN_PIN.length > 0 });
    },
  );

  // --- Aksi host ------------------------------------------------------
  socket.on("admin:reset", () => {
    if (!socket.data.isAdmin) return;
    entries = [];
    round += 1;
    locked = false;
    broadcast();
  });

  socket.on("admin:lock", (value: unknown) => {
    if (!socket.data.isAdmin) return;
    locked = Boolean(value);
    broadcast();
  });

  socket.on("disconnect", () => {
    // Urutan buzz tetap tersimpan meskipun pemain terputus.
    broadcast();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Nexus.Art Buzz server berjalan di port ${PORT}`);
  console.log(ADMIN_PIN ? "Panel host dilindungi PIN." : "Panel host TIDAK dilindungi PIN (set ADMIN_PIN untuk mengaktifkan).");
});
