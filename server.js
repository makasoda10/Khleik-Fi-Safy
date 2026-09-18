const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {

  let file = req.url === "/"
    ? "index.html"
    : req.url.substring(1);

  file = path.join(__dirname, file);

  if (!file.startsWith(__dirname) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };

  res.writeHead(200, {
    "Content-Type":
      types[path.extname(file)] ||
      "application/octet-stream"
  });

  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

const characters = [
  "عادل إمام",
  "أحمد زكي",
  "محمود عبد العزيز",
  "نور الشريف",
  "يحيى الفخراني",
  "سعاد حسني",
  "فاتن حمامة",
  "شادية",
  "يسرا",
  "ليلى علوي",
  "إسعاد يونس",
  "إلهام شاهين",
  "أحمد حلمي",
  "كريم عبد العزيز",
  "أحمد السقا",
  "محمد هنيدي",
  "خالد النبوي",
  "محمد منير",
  "عمرو دياب",
  "محمد فؤاد",
  "تامر حسني",
  "هاني شاكر",
  "أنغام",
  "شيرين عبد الوهاب",
  "لطيفة",
  "رامي جمال",
  "أمير كرارة",
  "مي عز الدين",
  "منى زكي",
  "هند صبري"
];

function createCode() {

  return Math.random()
    .toString(36)
    .substring(2, 7)
    .toUpperCase();

}

function send(ws, data) {

  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {

    ws.send(
      JSON.stringify(data)
    );

  }

}

function broadcast(room, data) {

  room.players.forEach(player => {

    send(player.ws, data);

  });

}

wss.on("connection", ws => {

  ws.on("message", raw => {

    let message;

    try {

      message =
        JSON.parse(raw);

    } catch {

      return;

    }

    // إنشاء مباراة

    if (message.type === "create") {

      let code =
        createCode();

      while (rooms.has(code)) {

        code =
          createCode();

      }

      const room = {

        players: [],

        turn: 1,

        secrets: {},

        characters:
          [...characters]
            .sort(() =>
              Math.random() - 0.5
            )

      };

      rooms.set(
        code,
        room
      );

      room.players.push({

        ws: ws,

        number: 1

      });

      ws.room = code;

      ws.player = 1;

      send(ws, {

        type: "created",

        room: code,

        player: 1

      });

      return;

    }

    // الانضمام

    if (message.type === "join") {

      const code =
        String(
          message.room || ""
        ).toUpperCase();

      const room =
        rooms.get(code);

      if (!room) {

        send(ws, {

          type: "error",

          message:
            "الغرفة غير موجودة."

        });

        return;

      }

      if (room.players.length >= 2) {

        send(ws, {

          type: "error",

          message:
            "الغرفة ممتلئة."

        });

        return;

      }

      room.players.push({

        ws: ws,

        number: 2

      });

      ws.room = code;

      ws.player = 2;

      room.players.forEach(
        (p, index) => {

          send(p.ws, {

            type: "joined",

            player: index + 1,

            players:
              room.players.length

          });

        }
      );

      if (
        room.players.length === 2
      ) {

        broadcast(
          room,
          {
            type: "room_ready"
          }
        );

      }

      return;

    }

    const room =
      rooms.get(ws.room);

    if (!room) return;

    // اختيار الشخصية السرية

    if (
      message.type ===
      "secret_selected"
    ) {

      const character =
        Number(message.character);

      if (
        !Number.isInteger(character) ||
        character < 0 ||
        character >= characters.length
      ) {

        return;

      }

      room.secrets[ws.player] =
        character;

      if (
        room.secrets[1] !== undefined &&
        room.secrets[2] !== undefined
      ) {

        room.turn = 1;

        broadcast(
          room,
          {
            type: "game_start",
            turn: 1
          }
        );

      }

      return;

    }

    // السؤال

    if (
      message.type === "question"
    ) {

      broadcast(
        room,
        {
          type: "question",
          text:
            String(
              message.text || ""
            ).slice(0, 300),
          from: ws.player
        }
      );

      return;

    }

    // الإجابة

    if (
      message.type === "answer"
    ) {

      room.turn =
        ws.player === 1
          ? 2
          : 1;

      broadcast(
        room,
        {
          type: "answer",
          text:
            String(
              message.text || ""
            ).slice(0, 300),
          from: ws.player
        }
      );

      broadcast(
        room,
        {
          type: "turn",
          player: room.turn
        }
      );

      return;

    }

    // التخمين

    if (
      message.type === "guess"
    ) {

      const opponent =
        ws.player === 1
          ? 2
          : 1;

      const target =
        room.secrets[opponent];

      const guessed =
        Number(message.character);

      if (
        guessed === target
      ) {

        broadcast(
          room,
          {
            type: "winner",
            player: ws.player
          }
        );

      } else {

        room.turn =
          opponent;

        broadcast(
          room,
          {
            type: "wrong_guess",
            player: ws.player
          }
        );

        broadcast
