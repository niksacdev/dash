import assert from "node:assert/strict";
import {once} from "node:events";
import {test,type TestContext} from "node:test";
import {WebSocketServer,WebSocket} from "ws";
import {createLoopbackClient} from "../lib/lmstudio-client.cjs";
import {loadSdkModel} from "../lib/lmstudio-load.cjs";
import {isRecord} from "../lib/runtime-types.cjs";

const key="synthetic/inspection-test";
const info={
  type:"llm",modelKey:key,identifier:key,format:"gguf",displayName:"Inspection test",publisher:"synthetic",
  path:"synthetic/inspection-test.gguf",sizeBytes:1024,indexedModelIdentifier:key,deviceIdentifier:null,
  instanceReference:"synthetic-instance",ttlMs:null,lastUsedTime:null,contextLength:1024,
  vision:false,trainedForToolUse:false,maxContextLength:1024,
};
async function serverFor(t:TestContext,respond:(socket:WebSocket,message:Record<string,unknown>)=>void){
  const server=new WebSocketServer({host:"127.0.0.1",port:0});
  t.after(async()=>{
    for(const client of server.clients)client.terminate();
    await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  });
  server.on("connection",socket=>socket.on("message",raw=>{
    const message:unknown=JSON.parse(raw.toString());
    assert.ok(isRecord(message));
    respond(socket,message);
  }));
  await once(server,"listening");
  const address=server.address();
  assert.ok(address && typeof address!=="string");
  return address.port;
}
test("a failed SDK handshake cannot submit an old load during a later inventory RPC",async t=>{
  const commands:unknown[]=[];
  let deny=true;
  const port=await serverFor(t,(socket,msg)=>{
    if("authVersion" in msg){
      socket.send(JSON.stringify(deny?{success:false,error:"synthetic denial"}:{success:true}));
    }else{
      commands.push(msg.endpoint);
      if(msg.type==="rpcCall")socket.send(JSON.stringify({type:"rpcResult",callId:msg.callId,result:[]}));
    }
  });
  await assert.rejects(loadSdkModel(key,port,10000),/acknowledgement unavailable/);
  deny=false;
  const reader=await createLoopbackClient(port);
  try{await reader.llm.listLoaded();}finally{await reader[Symbol.asyncDispose]();}
  assert.deepEqual(commands,["listLoaded"]);
});
test("a hung SDK handshake expires and closes before the operator can retry",async t=>{
  let hold=true;
  let held:WebSocket|undefined;
  const commands:unknown[]=[];
  const port=await serverFor(t,(socket,msg)=>{
    if("authVersion" in msg){
      if(hold)held=socket;
      else socket.send(JSON.stringify({success:true}));
    }else{
      commands.push(msg.endpoint);
      if(msg.type==="rpcCall")socket.send(JSON.stringify({type:"rpcResult",callId:msg.callId,result:[]}));
    }
  });
  await assert.rejects(loadSdkModel(key,port,8000),/acknowledgement unavailable/);
  assert.ok(held);
  if(held.readyState!==WebSocket.CLOSED)await once(held,"close",{signal:AbortSignal.timeout(3000)});
  hold=false;
  const reader=await createLoopbackClient(port);
  try{await reader.llm.listLoaded();}finally{await reader[Symbol.asyncDispose]();}
  assert.deepEqual(commands,["listLoaded"]);
});
test("an authenticated SDK sends one local load and cancels its outstanding request at the deadline",async t=>{
  let reads=0,loads=0,cancels=0;
  const port=await serverFor(t,(socket,msg)=>{
    if("authVersion" in msg)socket.send(JSON.stringify({success:true}));
    else if(msg.type==="rpcCall"){
      assert.equal(msg.endpoint,"listLoaded");reads++;
      socket.send(JSON.stringify({type:"rpcResult",callId:msg.callId,result:[]}));
    }else if(msg.type==="channelCreate"){
      assert.equal(msg.endpoint,"loadModel");assert.ok(isRecord(msg.creationParameter));
      assert.equal(msg.creationParameter.modelKey,key);assert.equal(msg.creationParameter.identifier,key);
      assert.equal(msg.creationParameter.deviceIdentifier,null);loads++;
    }else if(msg.type==="channelSend" && isRecord(msg.message) && msg.message.type==="cancel")cancels++;
  });
  await assert.rejects(loadSdkModel(key,port,8000),/acknowledgement unavailable/);
  assert.deepEqual({reads,loads,cancels},{reads:1,loads:1,cancels:1});
});

test("the SDK reuses a locally resident alias discovered during preflight",async t=>{
  const local={...info,identifier:"inspection-alias"};
  const commands:unknown[]=[];
  const port=await serverFor(t,(socket,msg)=>{
    if("authVersion" in msg){socket.send(JSON.stringify({success:true}));return;}
    commands.push(msg.endpoint);
    if(msg.type==="rpcCall")socket.send(JSON.stringify({type:"rpcResult",callId:msg.callId,
      result:msg.endpoint==="listLoaded"?[local]:local}));
  });
  assert.deepEqual(await loadSdkModel(key,port,10000),{modelKey:key,identifier:local.identifier});
  assert.deepEqual(commands,["listLoaded","getModelInfo"]);
});

test("a remote resident instance cannot satisfy a local SDK load",async t=>{
  const remote={...info,deviceIdentifier:"synthetic-remote",identifier:"remote-alias"};
  const commands:unknown[]=[];
  const port=await serverFor(t,(socket,msg)=>{
    if("authVersion" in msg){socket.send(JSON.stringify({success:true}));return;}
    if(msg.type==="channelClose")return;
    commands.push(msg.endpoint);
    if(msg.type==="rpcCall")socket.send(JSON.stringify({type:"rpcResult",callId:msg.callId,
      result:msg.endpoint==="listLoaded"?[remote]:remote}));
    if(msg.type==="channelCreate"){
      assert.ok(isRecord(msg.creationParameter));
      assert.equal(msg.creationParameter.deviceIdentifier,null);
      socket.send(JSON.stringify({type:"channelSend",channelId:msg.channelId,message:{type:"success",info}}));
    }
  });
  assert.deepEqual(await loadSdkModel(key,port,10000),{modelKey:key,identifier:key});
  assert.deepEqual(commands,["listLoaded","getModelInfo","loadModel"]);
});
