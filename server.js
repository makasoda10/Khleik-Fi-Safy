const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

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

const server = http.createServer((req, res) => {
  let requested = req.url.split("?")[0];

  if (requested === "/") {
    requested = "/index.html";
  }

  const filePath = path.join(
    __dirname,
    requested.replace(/^\/+/, "")
  );

  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const ext = path.extname(filePath);

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  res.writeHead(200, {
    "Content-Type":
      types[ext] || "application/octet-stream"
  });

  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

function createCode() {
  return Math.random()
    .toString(36)
    .substring(2, 7)
    .toUpperCase();
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  room.players.forEach(player => {
    send(player.ws, data);
  });
}

function otherPlayer(playerNumber) {
  return playerNumber === 1 ? 2 : 1;
}

function getPlayer(room, number) {
  return room.players.find(
    player => player.number === number
  );
}

function sendState(room) {
  room.players.forEach(player => {
    send(player.ws, {
      type: "game_state",
      turn: room.turn,
      guessesLeft: player.guessesLeft,
      players: room.players.length
    });
  });
}

wss.on("connection", ws => {

  ws.on("message", raw => {

    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        type: "error",
        message: "بيانات غير صحيحة."
      });
      return;
    }

    /*
     * إنشاء مباراة
     */
    if (message.type === "create") {

      let code = createCode();

      while (rooms.has(code)) {
        code = createCode();
      }

      const room = {
        players: [],
        turn: 1,
        secrets: {},
        gameStarted: false,
        finished: false,
        pendingQuestion: null
      };

      rooms.set(code, room);

      const player = {
        ws,
        number: 1,
        guessesLeft: 3
      };

      room.players.push(player);

      ws.room = code;
      ws.player = 1;

      send(ws, {
        type: "created",
        room: code,
        player: 1,
        guessesLeft: 3
      });

      return;
    }

    /*
     * الانضمام لمباراة
     */
    if (message.type === "join") {

      const code = String(message.room || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: "error",
          message: "الغرفة غير موجودة."
        });
        return;
      }

      if (room.players.length >= 2) {
        send(ws, {
          type: "error",
          message: "الغرفة ممتلئة."
        });
        return;
      }

      const player = {
        ws,
        number: 2,
        guessesLeft: 3
      };

      room.players.push(player);

      ws.room = code;
      ws.player = 2;

      room.players.forEach(p => {
        send(p.ws, {
          type: "joined",
          player: p.number,
          players: room.players.length,
          guessesLeft: p.guessesLeft
        });
      });

      if (room.players.length === 2) {
        broadcast(room, {
          type: "room_ready"
        });
      }

      return;
    }

    const room = rooms.get(ws.room);

    if (!room) {
      send(ws, {
        type: "error",
        message: "أنت لست داخل مباراة."
      });
      return;
    }

    if (room.finished) {
      send(ws, {
        type: "error",
        message: "المباراة انتهت."
      });
      return;
    }

    /*
     * اختيار الشخصية السرية
     */
    if (message.type === "secret_selected") {

      if (room.gameStarted) {
        return;
      }

      const character = Number(message.character);

      if (
        !Number.isInteger(character) ||
        character < 0 ||
        character >= characters.length
      ) {
        send(ws, {
          type: "error",
          message: "الشخصية غير صحيحة."
        });
        return;
      }

      room.secrets[ws.player] = character;

      send(ws, {
        type: "secret_confirmed"
      });

      if (
        room.secrets[1] !== undefined &&
        room.secrets[2] !== undefined
      ) {

        room.gameStarted = true;
        room.turn = 1;

        broadcast(room, {
          type: "game_start",
          turn: room.turn
        });

        sendState(room);
      }

      return;
    }

    /*
     * السؤال الحر
     */
    if (message.type === "question") {

      if (!room.gameStarted) {
        return;
      }

      if (room.turn !== ws.player) {
        send(ws, {
          type: "error",
          message: "ليس دورك الآن."
        });
        return;
      }

      const text = String(message.text || "")
        .trim()
        .slice(0, 500);

      if (!text) {
        send(ws, {
          type: "error",
          message: "اكتب السؤال أولًا."
        });
        return;
      }

      room.pendingQuestion = {
        from: ws.player
      };

      broadcast(room, {
        type: "question",
        text,
        from: ws.player
      });

      return;
    }

    /*
     * الإجابة الحرة
     */
    if (message.type === "answer") {

      if (!room.gameStarted) {
        return;
      }

      if (!room.pendingQuestion) {
        send(ws, {
          type: "error",
          message: "لا يوجد سؤال يحتاج إلى إجابة."
        });
        return;
      }

      if (room.pendingQuestion.from === ws.player) {
        send(ws, {
          type: "error",
          message: "لا يمكنك الإجابة على س
