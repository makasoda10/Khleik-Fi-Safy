const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const RECONNECT_TTL = 15 * 60 * 1000;
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
function createToken(){ return crypto.randomBytes(18).toString("hex"); }
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
function cleanProfile(profile){
  const name=String(profile?.name||"").trim().slice(0,24) || "لاعب";
  const avatar=Math.max(1,Math.min(12,Number(profile?.avatar)||1));
  const coins=Math.max(0,Math.floor(Number(profile?.coins)||0));
  const stars=Math.max(0,Math.floor(Number(profile?.stars)||0));
  return {name,avatar,coins,stars};
}
function publicPlayer(p){ return {number:p.number,connected:!!p.ws,name:p.profile?.name||"لاعب",avatar:p.profile?.avatar||1}; }
function roomSnapshot(room){
  return {room:room.code, player:room.players.length, gameStarted:room.gameStarted, turn:room.turn, characters:room.characterSet, guessesLeft:3, players:room.players.map(publicPlayer)};
}
function sendState(room){
  room.players.forEach(p=>send(p.ws,{type:"game_state",turn:room.turn,phase:room.phase,guessesLeft:p.guessesLeft,players:room.players.filter(x=>x.ws).length}));
}
function switchTurn(room){
  room.turn=otherPlayer(room.turn);
  room.phase="ask";
  const p=getPlayer(room,room.turn); if(p) p.guessesLeft=3;
  room.pendingQuestion=null;
  sendState(room);
  broadcast(room,{type:"turn_changed",turn:room.turn,phase:room.phase});
}
function scheduleRoomCleanup(code){
  const room=rooms.get(code); if(!room) return;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer=setTimeout(()=>{
    const current=rooms.get(code); if(!current) return;
    const active=current.players.some(p=>p.ws);
    if(!active) rooms.delete(code);
  }, RECONNECT_TTL);
}
function sendResumeState(ws, room, p){
  p.lastSeen=Date.now();
  send(ws,{type:"resumed",room:room.code,player:p.number,gameStarted:room.gameStarted,turn:room.turn,phase:room.phase,characters:room.characterSet,guessesLeft:p.guessesLeft,secretSelected:room.secrets[p.number]!==undefined,secret:room.secrets[p.number]??null,eliminated:p.eliminated||[],messages:room.messages||[],pendingQuestion:room.pendingQuestion,opponentConnected:!!getPlayer(room,otherPlayer(p.number))?.ws,profile:p.profile||cleanProfile(),players:room.players.map(publicPlayer)});
  if(room.gameStarted){
    send(ws,{type:"game_start",turn:room.turn,phase:room.phase,characters:room.characterSet,resume:true});
    if(room.pendingQuestion){ const q=room.pendingQuestion; send(ws,{type:"question",text:q.text,from:q.from,resume:true}); }
    sendState(room);
  } else if(room.players.length===2){
    send(ws,{type:"room_ready",characters:room.characterSet});
  } else {
    send(ws,{type:"waiting_room",room:room.code});
  }
}

wss.on("connection",ws=>{
  ws.on("message",raw=>{
    let message; try{ message=JSON.parse(raw.toString()); }catch{ return send(ws,{type:"error",message:"بيانات غير صحيحة."}); }

    if(message.type==="resume_probe"){
      const code=String(message.room||"").trim().toUpperCase();
      const token=String(message.token||"");
      const room=rooms.get(code);
      const p=room?.players.find(x=>x.token===token);
      if(!room||!p) return send(ws,{type:"resume_unavailable"});
      if(p.ws && p.ws!==ws) { try{ p.ws.close(); }catch{} }
      p.ws=ws; p.lastSeen=Date.now(); ws.room=code; ws.player=p.number; ws.token=token;
      clearTimeout(room.cleanupTimer);
      return send(ws,{type:"resume_available",room:code,player:p.number,gameStarted:room.gameStarted});
    }

    if(message.type==="resume_accept"){
      const room=rooms.get(ws.room); const p=room?.players.find(x=>x.ws===ws && x.token===ws.token);
      if(!room||!p) return send(ws,{type:"error",message:"المباراة لم تعد متاحة."});
      return sendResumeState(ws,room,p);
    }

    if(message.type==="resume_decline"){
      const room=rooms.get(ws.room); const p=room?.players.find(x=>x.ws===ws && x.token===ws.token);
      if(p){ p.ws=null; p.lastSeen=Date.now(); }
      if(room) scheduleRoomCleanup(room.code);
      try{ws.close();}catch{}
      return;
    }

    if(message.type==="create"){
      let code=createCode(); while(rooms.has(code)) code=createCode();
      const room={code,players:[],turn:1,phase:"ask",secrets:{},gameStarted:false,finished:false,pendingQuestion:null,messages:[],characterSet:makeCharacterSet(),cleanupTimer:null};
      rooms.set(code,room);
      const token=createToken();
      room.players.push({ws,number:1,token,guessesLeft:3,eliminated:[],lastSeen:Date.now(),profile:cleanProfile(message.profile)}); ws.room=code; ws.player=1; ws.token=token;
      return send(ws,{type:"created",room:code,player:1,token,guessesLeft:3,profile:room.players[0].profile,players:room.players.map(publicPlayer)});
    }

    if(message.type==="join"){
      const code=String(message.room||"").trim().toUpperCase(), room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"الغرفة غير موجودة."});
      if(room.players.some(p=>p.ws===ws)) return;
      if(room.players.length>=2) return send(ws,{type:"error",message:"الغرفة ممتلئة. لو كنت لاعبًا فيها استخدم الرجوع للمباراة."});
      const number=room.players.length===0?1:2, token=createToken();
      room.players.push({ws,number,token,guessesLeft:3,eliminated:[],lastSeen:Date.now(),profile:cleanProfile(message.profile)}); ws.room=code; ws.player=number; ws.token=token;
      send(ws,{type:"joined",player:number,room:code,token,profile:room.players.find(p=>p.number===number).profile,players:room.players.map(publicPlayer)});
      room.players.forEach(p=>send(p.ws,{type:"joined",player:p.number,players:room.players.map(publicPlayer)}));
      if(room.players.filter(p=>p.ws).length===2){
        broadcast(room,{type:"room_ready",characters:room.characterSet,players:room.players.map(publicPlayer)});
      } else {
        send(ws,{type:"waiting_room",room:code});
      }
      return;
    }

    const room=rooms.get(ws.room);
    if(!room) return send(ws,{type:"error",message:"أنت لست داخل مباراة."});
    const me=room.players.find(p=>p.ws===ws && p.number===ws.player);
    if(me) me.lastSeen=Date.now();
    if(room.finished) return send(ws,{type:"error",message:"المباراة انتهت."});

    if(message.type==="secret_selected"){
      if(room.gameStarted) return;
      const index=Number(message.character);
      if(!Number.isInteger(index)||index<0||index>=room.characterSet.length) return send(ws,{type:"error",message:"الشخصية غير صحيحة."});
      room.secrets[ws.player]=index;
      send(ws,{type:"secret_confirmed"});
      if(room.secrets[1]!==undefined&&room.secrets[2]!==undefined){
        room.gameStarted=true; room.turn=1; room.phase="ask"; room.players.forEach(p=>p.guessesLeft=3);
        broadcast(room,{type:"game_start",turn:room.turn,characters:room.characterSet,players:room.players.map(publicPlayer)}); sendState(room);
      }
      return;
    }

    if(message.type==="question"){
      if(!room.gameStarted) return;
      if(room.turn!==ws.player) return send(ws,{type:"error",message:"ليس دورك الآن."});
      if(room.pendingQuestion) return send(ws,{type:"error",message:"يوجد سؤال يحتاج إلى إجابة."});
      const text=String(message.text||"").trim().slice(0,300);
      if(!text) return send(ws,{type:"error",message:"اكتب السؤال أولًا."});
      room.pendingQuestion={from:ws.player,text}; room.messages.push({type:"question",text,from:ws.player}); if(room.messages.length>100) room.messages.shift(); room.phase="answer"; broadcast(room,{type:"question",text,from:ws.player,phase:room.phase}); return;
    }

    if(message.type==="answer"){
      if(!room.gameStarted||!room.pendingQuestion) return send(ws,{type:"error",message:"لا يوجد سؤال يحتاج إلى إجابة."});
      if(room.pendingQuestion.from===ws.player) return send(ws,{type:"error",message:"لا يمكنك الإجابة على سؤالك."});
      const answer=String(message.answer||message.text||"").trim().slice(0,100);
      if(!answer) return send(ws,{type:"error",message:"اكتب الإجابة أولًا."});
      broadcast(room,{type:"answer",answer,from:ws.player,phase:"eliminate"}); room.messages.push({type:"answer",answer,from:ws.player}); if(room.messages.length>100) room.messages.shift(); room.pendingQuestion=null; room.phase="eliminate"; return;
    }

    if(message.type==="eliminate_state"){
      if(!room.gameStarted || room.turn!==ws.player || room.phase!=="eliminate") return send(ws,{type:"error",message:"يمكنك تصفية الشخصيات بعد إجابة الخصم فقط."});
      const list=Array.isArray(message.eliminated)?message.eliminated.map(Number).filter(i=>Number.isInteger(i)&&i>=0&&i<room.characterSet.length):[];
      const me2=getPlayer(room,ws.player); if(me2) me2.eliminated=[...new Set(list)];
      return;
    }

    if(message.type==="guess"||message.type==="guess_character"){
      if(!room.gameStarted) return;
      if(room.phase!=="eliminate") return send(ws,{type:"error",message:"التخمين متاح بعد إجابة الخصم وبدء التصفية."});
      if(room.turn!==ws.player) return send(ws,{type:"error",message:"ليس دورك الآن."});
      const guessed=Number(message.character!==undefined?message.character:message.guess), opponent=otherPlayer(ws.player), secret=room.secrets[opponent];
      if(!Number.isInteger(guessed)||guessed<0||guessed>=room.characterSet.length) return send(ws,{type:"error",message:"الشخصية غير صحيحة."});
      if(guessed===secret){ room.finished=true; const winner=getPlayer(room,ws.player), loser=getPlayer(room,opponent); if(winner){ winner.profile.coins=(winner.profile.coins||0)+50; winner.profile.stars=(winner.profile.stars||0)+3; } if(loser){ loser.profile.coins=(loser.profile.coins||0)+20; loser.profile.stars=(loser.profile.stars||0)+1; } return broadcast(room,{type:"game_over",winner:ws.player,loser:opponent,character:secret,message:"مبروك! لقد خمنت الشخصية السرية بشكل صحيح.",rewards:{[ws.player]:{coins:50,stars:3},[opponent]:{coins:20,stars:1}},players:room.players.map(publicPlayer),profiles:room.players.map(p=>({number:p.number,profile:p.profile}))}); }
      const p=getPlayer(room,ws.player); if(p) p.guessesLeft--;
      if(p&&p.guessesLeft<=0){ room.finished=true; const winner=getPlayer(room,opponent), loser=getPlayer(room,ws.player); if(winner){ winner.profile.coins=(winner.profile.coins||0)+50; winner.profile.stars=(winner.profile.stars||0)+3; } if(loser){ loser.profile.coins=(loser.profile.coins||0)+20; loser.profile.stars=(loser.profile.stars||0)+1; } return broadcast(room,{type:"game_over",winner:opponent,loser:ws.player,character:secret,message:"انتهت محاولات التخمين الثلاث. الخصم يفوز!",rewards:{[opponent]:{coins:50,stars:3},[ws.player]:{coins:20,stars:1}},players:room.players.map(publicPlayer),profiles:room.players.map(p=>({number:p.number,profile:p.profile}))}); }
      sendState(room); send(ws,{type:"wrong_guess",guessesLeft:p.guessesLeft}); return;
    }

    if(message.type==="end_turn"||message.type==="finish_turn"){
      if(!room.gameStarted) return;
      if(room.turn!==ws.player) return send(ws,{type:"error",message:"ليس دورك الآن."});
      if(room.phase!=="eliminate" || room.pendingQuestion) return send(ws,{type:"error",message:"اسأل، انتظر الإجابة، ثم صفِّ الشخصيات قبل إنهاء دورك."});
      switchTurn(room); return;
    }
  });

  ws.on("close",()=>{
    const room=rooms.get(ws.room); if(!room) return;
    const p=room.players.find(x=>x.ws===ws && x.number===ws.player);
    if(!p) return;
    p.ws=null; p.lastSeen=Date.now();
    broadcast(room,{type:"player_disconnected",player:p.number,message:"اللاعب خرج مؤقتًا. يمكنه الرجوع لنفس المباراة خلال 15 دقيقة."});
    scheduleRoomCleanup(room.code);
  });
});

server.listen(PORT,"0.0.0.0",()=>console.log(`Yalla Nasafy server running on port ${PORT}`));
