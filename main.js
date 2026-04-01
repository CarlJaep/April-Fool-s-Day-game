const socket = io("https://YOUR-SERVER.onrender.com");

const HEX_W = 40;
const HEX_H = 34;
const H_STEP = HEX_W * 0.75;
const V_STEP = HEX_H;
const R = 10;

let tiles = {};
let money = 0;
let team = null;

function key(q,r){ return q+","+r; }

function buildMap(){
  for(let q=-R;q<=R;q++){
    let r1=Math.max(-R,-q-R);
    let r2=Math.min(R,-q+R);
    for(let r=r1;r<=r2;r++){
      tiles[key(q,r)]={q,r,owner:null,active:true};
    }
  }
}

function draw(){
  const board=document.getElementById("board");
  board.innerHTML="";

  Object.values(tiles).forEach(t=>{
    const div=document.createElement("div");
    div.className="hex";

    let x=t.q*H_STEP+500;
    let y=t.r*V_STEP + t.q*(HEX_H/2)+300;

    div.style.left=x+"px";
    div.style.top=y+"px";

    if(!t.active) div.classList.add("dead");
    if(t.owner) div.style.background=t.owner;

    div.onclick=()=>clickTile(t);

    board.appendChild(div);
  });

  document.getElementById("money").innerText=money;
}

function start(){
  const id=document.getElementById("id").value;
  if(id.length<2) return;

  const map={"1":"blue","2":"red","3":"green","4":"yellow"};
  team=map[id[1]];

  buildMap();
  draw();

  socket.emit("join",{team});
}

function clickMoney(){
  money++;
  draw();
}

function clickTile(t){
  if(!t.active) return;

  const action=document.getElementById("action").value;

  socket.emit("action",{
    key:key(t.q,t.r),
    action,
    team
  });
}

socket.on("sync",(state)=>{
  tiles=state.tiles;
  draw();
});