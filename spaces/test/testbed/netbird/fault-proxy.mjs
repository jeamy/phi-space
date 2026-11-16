// Administrative component fault proxy. No credentials or request bodies are logged.
import http2 from 'node:http2';import http from 'node:http';import{readFileSync}from'node:fs';
const [certFile,keyFile]=process.argv.slice(2);if(!certFile||!keyFile)throw Error('certificate and key paths required');
const blocked=new Set(),live=new Set(),counts={management:0,signal:0,relay:0,other:0};
function component(path){return /^\/(api\/|management\.|ws-proxy\/management)/.test(path)?'management':/^\/(signalexchange\.|ws-proxy\/signal)/.test(path)?'signal':/^\/relay/.test(path)?'relay':'other';}
const server=http2.createSecureServer({cert:readFileSync(certFile),key:readFileSync(keyFile),allowHTTP1:true});
server.on('session',s=>{s.on('error',()=>{});if(!['127.0.0.1','::1','::ffff:127.0.0.1','152.53.239.133','::ffff:152.53.239.133'].includes(s.socket.remoteAddress))s.destroy();});
server.on('request',(req,res)=>{
 if(req.httpVersionMajor===2){
  const kind=component(req.url);counts[kind]++;
  if(blocked.has(kind)){res.writeHead(503);res.end();return;}
  const upstream=http2.connect('http://127.0.0.1:18081');upstream.on('error',()=>res.destroy());
  const request=upstream.request({...req.headers,':scheme':'http',':authority':'spacebird.eibrain.org'});request.on('error',()=>res.destroy());
  const record={kind,close:()=>{request.destroy();res.destroy();upstream.destroy();}};live.add(record);
  request.on('response',headers=>{const {':status':status,...rest}=headers;if(!res.destroyed)res.writeHead(status,rest);});
  request.on('trailers',headers=>{if(!res.destroyed)res.addTrailers(headers);});req.pipe(request);request.pipe(res);
  res.on('close',()=>{live.delete(record);request.destroy();upstream.close();});return;
 }
 const kind=component(req.url);counts[kind]++;
 if(blocked.has(kind)){res.writeHead(503);res.end();return;}
 const u=http.request({host:'127.0.0.1',port:18081,path:req.url,method:req.method,headers:{...req.headers,host:'spacebird.eibrain.org'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});u.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(u);
 const record={kind,close:()=>{u.destroy();res.destroy();}};live.add(record);res.on('close',()=>live.delete(record));
});
server.on('upgrade',(req,socket,head)=>{
 const kind=component(req.url);counts[kind]++;socket.on('error',()=>{});
 if(blocked.has(kind)){socket.destroy();return;}
 const u=http.request({host:'127.0.0.1',port:18081,path:req.url,headers:{...req.headers,host:'spacebird.eibrain.org'}});u.on('error',()=>socket.destroy());
 u.on('upgrade',(res,peer,data)=>{peer.on('error',()=>socket.destroy());socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(res.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(data.length)socket.write(data);if(head.length)peer.write(head);socket.pipe(peer).pipe(socket);const record={kind,close:()=>{socket.destroy();peer.destroy();}};live.add(record);socket.on('close',()=>{live.delete(record);peer.destroy();});});u.end();
});
const admin=http.createServer(async(req,res)=>{
 try{if(req.method==='POST'&&req.url==='/fault'){let body='';for await(const b of req){body+=b;if(body.length>4096)throw Error('oversize');}const kinds=JSON.parse(body).blocked;if(!Array.isArray(kinds)||kinds.some(k=>!['management','signal','relay'].includes(k)))throw Error('invalid components');blocked.clear();kinds.forEach(k=>blocked.add(k));for(const r of live)if(blocked.has(r.kind))r.close();}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({blocked:[...blocked],live:[...live].reduce((a,r)=>(a[r.kind]=(a[r.kind]||0)+1,a),{}),counts}));}catch{res.writeHead(400);res.end('{}');}
});admin.listen(19991,'127.0.0.1');server.listen(14443,'0.0.0.0',()=>console.log(JSON.stringify({ready:true,tlsPort:14443,adminLoopbackPort:19991})));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{for(const r of live)r.close();admin.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
