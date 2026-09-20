const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const characters = JSON.parse(fs.readFileSync(path.join(__dirname, "characters.json"), "utf8"));
const recentSets = [];
const MAX_RECENT_SETS = 25;

const server = http.createServer((req, res) => {
  let requested = req.url.split("?")[0];
  if (requested === "/") requested = "/index.html";
  const cleanPath = requested.replace(/^\/+/, "");
  const filePath = path.join(__dirname, cleanPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end("Forbidden"); }
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end("Not found"); }
  const ext = path.extname(filePath).toLowerCase();
  const types = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".svg":"image/svg+xml"};
  res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Cache-Control":ext===".jpg"?"public, max-age=86400":"no-cache"});
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function createCode(){ return Math.random().toString(36).substring(2,7).toUpperCase(); }
function send(ws,data){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(room,data){ room.players.forEach(p=>send(p.ws,data)); }
function getPlayer(room,n){ return room.players.find(p=>p.number===n); }
function otherPlayer(n){ return n===1?2:1; }
function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function makeCharacterSet(){
  const recent = new Set(recentSets.map(s=>s.join(",")));
  let chosen=[];
  for(let tries=0;tries<100;tries++){
    chosen=shuffle([...Array(characters.length).keys()]).slice(0,30).sort((a,b)=>a-b);
    if(!recent.has(chosen.join(","))) break;
  }
  recentSets.push(chosen);
  if(recentSets.length>MAX_RECENT_SETS) recentSets.shift();
  return chosen.map((sourceIndex)=>({ ...characters[sourceIndex], sourceIndex }));
}
function sendState(room){
  room.players.forEach(p=>send(p.ws,{type:"game_state",turn:room.turn,guessesLeft:p.guessesLeft,players:room.players.length}));
}
function switchTurn(room){
  room.turn=otherPlayer(room.turn);
  const p=getPlayer(room,room.turn); if(p) p.guessesLeft=3;
  room.pendingQuestion=null;
  sendState(room);
  broadcast(room,{type:"turn_changed",turn:room.turn});
}

wss.on("connection",ws=>{
  ws.on("message",raw=>{
    let message; try{ message=JSON.parse(raw.toString()); }catch{ return send(ws,{type:"error",message:"بيانات غير صحيحة."}); }

    if(message.type==="create"){
      let code=createCode(); while(rooms.has(code)) code=createCode();
      const room={players:[],turn:1,secrets:{},gameStarted:false,finished:false,pendingQuestion:null,characterSet:makeCharacterSet()};
      rooms.set(code,room);
      room.players.push({ws,number:1,guessesLeft:3}); ws.room=code; ws.player=1;
      return send(ws,{type:"created",room:code,player:1,guessesLeft:3});
    }

    if(message.type==="join"){
      const code=String(message.room||"").trim().toUpperCase(), room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"الغرفة غير موجودة."});
      if(room.players.length>=2) return send(ws,{type:"error",message:"الغرفة ممتلئة."});
      room.players.push({ws,number:2,guessesLeft:3}); ws.room=code; ws.player=2;
      room.players.forEach(p=>send(p.ws,{type:"joined",player:p.number,players:room.players.length}));
      if(room.players.length===2){
        broadcast(room,{type:"room_ready",characters:room.characterSet});
      }
      return;
    }

    const room=rooms.get(ws.room);
    if(!room) return send(ws,{type:"error",message:"أنت لست داخل مباراة."});
    if(room.finished) return send(ws,{type:"error",message:"المباراة انتهت."});

    if(message.type==="secret_selected"){
      if(room.gameStarted) return;
      const index=Number(message.character);
      if(!Number.isInteger(index)||index<0||index>=room.characterSet.length) return send(ws,{type:"error",message:"الشخصية غير صحيحة."});
      room.secrets[ws.player]=index;
      send(ws,{type:"secret_confirmed"});
      if(room.secrets[1]!==undefined&&room.secrets[2]!==undefined){
        room.gameStarted=true; room.turn=1; room.players.forEach(p=>p.guessesLeft=3);
        broadcast(room,{type:"game_start",turn:room.turn,characters:room.characterSet}); sendState(room);
      }
      return;
    }

    if(message.type==="question"){
      if(!room.gameStarted) return;
      if(room.turn!==ws.player) return send(ws,{type:"error",message:"ليس دورك الآن."});
      if(room.pendingQuestion) return send(ws,{type:"error",message:"يوجد سؤال يحتاج إلى إجابة."});
      const text=String(message.text||"").trim().slice(0,300);
      if(!text) return send(ws,{type:"error",message:"اكتب السؤال أولًا."});
      room.pendingQuestion={from:ws.player}; broadcast(room,{type:"question",text,from:ws.player}); return;
    }

    if(message.type==="answer"){
      if(!room.gameStarted||!room.pendingQuestion) return send(ws,{type:"error",message:"لا يوجد سؤال يحتاج إلى إجابة."});
      if(room.pendingQuestion.from===ws.player) return send(ws,{type:"error",message:"لا يمكنك الإجابة على سؤالك."});
      const answer=String(message.answer||message.text||"").trim().slice(0,100);
      if(!answer) return send(ws,{type:"error",message:"اكتب الإجابة أولًا."});
      broadcast(room,{type:"answer",answer,from:ws.player}); room.pendingQuestion=null; return;
    }

    if(message.type==="guess"||message.type==="guess_character"){
      if(!room.gameStarted) return;
      if(room.turn!==ws.player) return send(ws,{type:"error",message:"ليس دورك الآن."});
      const guessed=Number(message.character!==undefined?message.character:message.guess), opponent=otherPlayer(ws.player), secret=room.secrets[opponent];
      if(!Number.isInteger(guessed)||guessed<0||guessed>=room.characterSet.length) return send(ws,{type:"error",message:"الشخصية غير صحيحة."});
      if(guessed===secret){ room.finished=true; return broadcast(room,{type:"game_over",winner:ws.player,loser:opponent,character:secret,message:"مبروك! لقد خمنت الشخصية السرية بشكل صحيح."}); }
      const p=getPlayer(room,ws.player); if(p) p.guessesLeft--;
      if(p&&p.guessesLeft<=0){ room.finished=true; return broadcast(room,{type:"game_over",winner:opponent,loser:ws.player,character:secret,message:"انتهت محاولات التخمين الثلاث. الخصم يفوز!"}); }
      sendState(room); send(ws,{type:"wrong_guess",guessesLeft:p.guessesLeft}); return;
    }

    if(message.type==="end_turn"||message.type==="finish_turn"){
      if(!room.gameStarted) return;
      if(room.turn!==ws.player) return send(ws,{type:"error",message:"ليس دورك الآن."});
      if(room.pendingQuestion) return send(ws,{type:"error",message:"يجب إنهاء السؤال الحالي أولًا."});
      switchTurn(room); return;
    }
  });

  ws.on("close",()=>{
    const room=rooms.get(ws.room); if(!room) return;
    room.players=room.players.filter(p=>p.ws!==ws);
    if(room.players.length===0) rooms.delete(ws.room);
    else { broadcast(room,{type:"player_left",message:"الخصم غادر المباراة."}); rooms.delete(ws.room); }
  });
});
server.listen(PORT,"0.0.0.0",()=>console.log(`Yalla Nasafy server running on port ${PORT}`));
