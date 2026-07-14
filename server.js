const http=require('http');
const fs=require('fs');
const path=require('path');
const PORT=process.env.PORT||3000;
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json'};
http.createServer((req,res)=>{
  let filePath=req.url==='/'?'/index.html':req.url;
  filePath=path.join(__dirname,filePath);
  const ext=path.extname(filePath);
  fs.readFile(filePath,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return}
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/html'});
    res.end(data);
  });
}).listen(PORT,()=>console.log('EGL Hockey on '+PORT));
