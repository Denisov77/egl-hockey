const http=require('http');
const fs=require('fs');
const path=require('path');
const{WebSocketServer}=require('ws');

const PORT=process.env.PORT||3000;
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.ico':'image/x-icon'};

const server=http.createServer((req,res)=>{
  let fp=req.url==='/'?'/index.html':req.url.split('?')[0];
  fp=path.join(__dirname,fp);
  const ext=path.extname(fp);
  fs.readFile(fp,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return}
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/html','Cache-Control':'no-cache'});
    res.end(data);
  });
});

const wss=new WebSocketServer({server});

const FIELD_W=900,FIELD_H=500;
const PUCK_R=8,CIRCLE_R=30,GOAL_H=100,GOAL_W=10;
const WIN_SCORE=5;
const PUCK_SPEED_MAX=10;
const FRICTION=0.992;
const PLAYER_SPEED=4.5;
const ENEMY_PUSH=4;

let waiting=null;
const rooms=new Map();

function createRoom(p1,p2){
  const id=Date.now()+'';
  const room={
    id,players:[p1,p2],
    puck:{x:FIELD_W/2,y:FIELD_H/2,vx:0,vy:0},
    players_state:[
      {x:FIELD_W*0.28,y:FIELD_H/2,vx:0,vy:0,input:{dx:0,dy:0}},
      {x:FIELD_W*0.72,y:FIELD_H/2,vx:0,vy:0,input:{dx:0,dy:0}}
    ],
    score:[0,0],
    running:true,
    loop:null
  };
  p1.room=room;p1.side=0;
  p2.room=room;p2.side=1;
  rooms.set(id,room);

  p1.send(JSON.stringify({type:'matched',opponent:p2.name,side:0}));
  p2.send(JSON.stringify({type:'matched',opponent:p1.name,side:1}));

  resetPuck(room);
  room.loop=setInterval(()=>tick(room),1000/60);
  return room;
}

function resetPuck(room){
  room.puck.x=FIELD_W/2;room.puck.y=FIELD_H/2;
  const a=(Math.random()-.5)*Math.PI*.4;
  const d=Math.random()>.5?1:-1;
  room.puck.vx=Math.cos(a)*3*d;room.puck.vy=Math.sin(a)*3;
}

function tick(room){
  if(!room.running)return;
  const puck=room.puck;
  const ps=room.players_state;

  for(let i=0;i<2;i++){
    const p=ps[i];
    const inp=p.input;
    const len=Math.sqrt(inp.dx*inp.dx+inp.dy*inp.dy);
    if(len>0.1){
      const nx=inp.dx/len,ny=inp.dy/len;
      p.vx=nx*PLAYER_SPEED;p.vy=ny*PLAYER_SPEED;
    }else{
      p.vx*=.82;p.vy*=.82;
    }
    p.x+=p.vx;p.y+=p.vy;

    // Territory restriction: each player stays on their half
    if(i===0){
      p.x=Math.max(CIRCLE_R,Math.min(FIELD_W/2-CIRCLE_R,p.x));
    }else{
      p.x=Math.max(FIELD_W/2+CIRCLE_R,Math.min(FIELD_W-CIRCLE_R,p.x));
    }
    p.y=Math.max(CIRCLE_R,Math.min(FIELD_H-CIRCLE_R,p.y));

    // Circle-puck collision
    const dx=puck.x-p.x,dy=puck.y-p.y;
    const dist=Math.sqrt(dx*dx+dy*dy);
    const minD=CIRCLE_R+PUCK_R;
    if(dist<minD&&dist>0){
      const push=i===0?4+room.players[0].upgradePush*1.2:ENEMY_PUSH;
      const nx=dx/dist,ny=dy/dist;
      puck.vx=nx*push;puck.vy=ny*push;
      puck.x=p.x+nx*(minD+1);puck.y=p.y+ny*(minD+1);
    }
  }

  // Puck movement
  puck.x+=puck.vx;puck.y+=puck.vy;
  puck.vx*=FRICTION;puck.vy*=FRICTION;
  const speed=Math.sqrt(puck.vx*puck.vx+puck.vy*puck.vy);
  if(speed>PUCK_SPEED_MAX){puck.vx=(puck.vx/speed)*PUCK_SPEED_MAX;puck.vy=(puck.vy/speed)*PUCK_SPEED_MAX}

  // Wall bounce top/bottom
  if(puck.y-PUCK_R<0){puck.y=PUCK_R;puck.vy*=-1}
  if(puck.y+PUCK_R>FIELD_H){puck.y=FIELD_H-PUCK_R;puck.vy*=-1}

  // Goals
  const gY=FIELD_H/2-GOAL_H/2;

  // Left goal (player 0 defends) - puck in = player 1 scores
  if(puck.x-PUCK_R<GOAL_W){
    if(puck.y>gY&&puck.y<gY+GOAL_H){
      room.score[1]++;
      broadcast(room,{type:'goal',scorer:1,score:room.score});
      if(room.score[1]>=WIN_SCORE)endRoom(room,1);
      else resetPuck(room);
      return;
    }else{puck.x=GOAL_W+PUCK_R;puck.vx=Math.abs(puck.vx)*.8}
  }

  // Right goal (player 1 defends) - puck in = player 0 scores
  if(puck.x+PUCK_R>FIELD_W-GOAL_W){
    if(puck.y>gY&&puck.y<gY+GOAL_H){
      room.score[0]++;
      broadcast(room,{type:'goal',scorer:0,score:room.score});
      if(room.score[0]>=WIN_SCORE)endRoom(room,0);
      else resetPuck(room);
      return;
    }else{puck.x=FIELD_W-GOAL_W-PUCK_R;puck.vx=-Math.abs(puck.vx)*.8}
  }

  // Broadcast state
  broadcast(room,{
    type:'state',
    puck:{x:Math.round(puck.x*10)/10,y:Math.round(puck.y*10)/10,vx:Math.round(puck.vx*10)/10,vy:Math.round(puck.vy*10)/10},
    p0:{x:Math.round(ps[0].x*10)/10,y:Math.round(ps[0].y*10)/10},
    p1:{x:Math.round(ps[1].x*10)/10,y:Math.round(ps[1].y*10)/10},
    score:room.score
  });
}

function endRoom(room,winner){
  room.running=false;
  clearInterval(room.loop);
  room.players.forEach((p,i)=>{
    if(p.readyState===1)p.send(JSON.stringify({type:'gameover',won:i===winner,score:room.score}));
  });
  setTimeout(()=>rooms.delete(room.id),5000);
}

function broadcast(room,msg){
  const s=JSON.stringify(msg);
  room.players.forEach(p=>{if(p.readyState===1)p.send(s)});
}

wss.on('connection',(ws)=>{
  ws.alive=true;
  ws.on('pong',()=>{ws.alive=true});

  ws.on('message',(data)=>{
    let msg;try{msg=JSON.parse(data)}catch{return}
    if(msg.type==='join'){
      ws.name=(msg.name||'Player').substring(0,20);
      ws.upgradePush=parseInt(msg.upgradePush)||0;
      ws.upgradeSpeed=parseInt(msg.upgradeSpeed)||0;
      if(waiting&&waiting.readyState===1&&waiting!==ws){
        createRoom(waiting,ws);
        waiting=null;
      }else{
        waiting=ws;
        ws.send(JSON.stringify({type:'queued'}));
      }
    }
    if(msg.type==='input'&&ws.room&&ws.room.running){
      ws.room.players_state[ws.side].input.dx=parseFloat(msg.dx)||0;
      ws.room.players_state[ws.side].input.dy=parseFloat(msg.dy)||0;
    }
    if(msg.type==='cancel'){
      if(waiting===ws)waiting=null;
    }
    if(msg.type==='leave'){
      if(waiting===ws)waiting=null;
      if(ws.room){
        ws.room.running=false;
        clearInterval(ws.room.loop);
        const other=ws.room.players.find(p=>p!==ws);
        if(other&&other.readyState===1)other.send(JSON.stringify({type:'opponent_left'}));
        rooms.delete(ws.room.id);
        ws.room=null;
      }
    }
  });

  ws.on('close',()=>{
    if(waiting===ws)waiting=null;
    if(ws.room){
      ws.room.running=false;
      clearInterval(ws.room.loop);
      const other=ws.room.players.find(p=>p!==ws);
      if(other&&other.readyState===1)other.send(JSON.stringify({type:'opponent_left'}));
      rooms.delete(ws.room.id);
    }
  });
});

// Heartbeat
setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(!ws.alive)return ws.terminate();
    ws.alive=false;ws.ping();
  });
},30000);

server.listen(PORT,()=>console.log('EGL Hockey server on '+PORT));
