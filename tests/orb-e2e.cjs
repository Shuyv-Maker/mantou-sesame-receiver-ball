// Native Electron acceptance test. Does not access a browser profile or register protocols.
const { app, BrowserWindow, Menu, ipcMain, nativeImage, screen } = require('electron');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'test-results');
let ball, socket, source, capturedMenu;
const errors = [];
const nap = ms => new Promise(r => setTimeout(r, ms));
async function until(test, label, timeout = 15000) {
  const start = Date.now();
  while (!await test()) {
    if (Date.now() - start > timeout) throw new Error('Timeout: ' + label);
    await nap(80);
  }
}
async function state() {
  return ball.webContents.executeJavaScript(`({ label:document.getElementById('receiver-state').textContent, orb:document.getElementById('receiver-orb').dataset.state, css:document.getElementById('receiver-ball').className })`);
}
async function capture(name) { await writeFile(path.join(evidence, name + '.png'), (await ball.webContents.capturePage()).toPNG()); }
async function mouse(from, to, click = false) {
  const args = ['-NoProfile','-File',path.join(__dirname,'native-drag.ps1'),'-FromX',String(from.x),'-FromY',String(from.y)];
  if (click) args.push('-Click');
  else args.push('-ToX',String(to.x),'-ToY',String(to.y));
  const proc = spawn('powershell.exe', args, {windowsHide:true});
  await new Promise((resolve,reject) => {proc.on('error',reject);proc.on('exit',c=>c===0?resolve():reject(Error('mouse failed')));});
}
const deadline = setTimeout(() => { console.error('Test timed out'); app.exit(1); }, 90000);
app.setAsDefaultProtocolClient = () => true;
app.setPath('userData', path.join(app.getPath('temp'), 'mantou-orb-acceptance'));
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = template => {
  const menu = buildMenu(template);
  const popup = menu.popup.bind(menu);
  menu.popup = options => { capturedMenu = menu; return popup(options); };
  return menu;
};

(async () => {
  await mkdir(evidence, { recursive: true });
  // Load the actual app, IPC handlers and renderer, not a mock UI.
  await import(pathToFileURL(path.join(process.env.MANTOU_TEST_APP || root, 'main.mjs')).href);
  await until(() => BrowserWindow.getAllWindows().length, 'native window');
  ball = BrowserWindow.getAllWindows()[0];
  ball.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await until(async () => (await state()).orb === 'connecting', 'particle engine');
  ball.setBounds({x:550,y:280,width:88,height:88}); ball.show();
  await nap(250);
  ipcMain.on('receiver:drag', (_event,phase,offset) => { if(phase==='start') console.log('drag-anchor',JSON.stringify({offset,cursor:screen.getCursorScreenPoint(),bounds:ball.getBounds()})); });
  const initialBounds = ball.getBounds();
  const origin = screen.dipToScreenPoint({x:initialBounds.x+44,y:initialBounds.y+44});
  const target = screen.dipToScreenPoint({x:initialBounds.x+194,y:initialBounds.y+104});
  await mouse(origin,target);
  await nap(150);
  const movedBounds = ball.getBounds();
  assert.ok(Math.abs(movedBounds.x-initialBounds.x-150)<=3 && Math.abs(movedBounds.y-initialBounds.y-60)<=3, 'native cursor follows: '+JSON.stringify({initialBounds,movedBounds}));
  assert.equal(movedBounds.width,initialBounds.width);
  source = new BrowserWindow({width:210,height:150,x:220,y:260,show:true});
  await source.loadURL('data:text/html,<body style="margin:0"><button style="width:100vw;height:100vh" onclick="document.title=\'clicked\'">Click after drag</button>');
  const clickBounds = source.getContentBounds();
  await mouse(screen.dipToScreenPoint({x:clickBounds.x+60,y:clickBounds.y+40}),null,true);
  await until(()=>source.getTitle()==='clicked','background page click after drag');
  assert.deepEqual(ball.getBounds(),movedBounds,'no stuck follow after release');
  source.destroy();
  ball.setBounds({x:550,y:280,width:88,height:88});
  await capture('01-unpaired');
  const status = await ball.webContents.executeJavaScript('window.mantouReceiver.getStatus()');
  const token = status.pairingCode;
  const projectId = 'orb_visual_acceptance';
  socket = new WebSocket('ws://127.0.0.1:49731/socket', { origin: 'http://127.0.0.1:49731' });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let meta, received, receivedCount = 0;
  socket.on('message', async (data, binary) => {
    if (!binary) { const msg = JSON.parse(data); if (msg.type === 'image-meta') meta = msg; return; }
    received = Buffer.from(data);
    receivedCount++;
    await writeFile(path.join(evidence, 'received.png'), received);
    socket.send(JSON.stringify({type:'ack',version:1,token,projectId,id:meta.id,status:'saved'}));
  });
  socket.send(JSON.stringify({type:'pair',version:1,token,projectId,projectName:'粒子收图球验收',parentOrigin:'http://localhost:3000'}));
  await until(async () => (await state()).orb === 'searching', 'paired particles');
  await capture('02-ready');
  await ball.webContents.executeJavaScript(`window.dropEvents=[]; for(const t of ['dragenter','dragover','drop','contextmenu']) document.addEventListener(t,e=>window.dropEvents.push({type:t,files:e.dataTransfer?.files.length}),true);`);
  // Exercise the actual renderer through preload and the WebSocket bridge.
  const bytes = await readFile(path.join(root, '..', '收图球验收测试-20260831.png'));
  const imagePath = path.join(evidence, 'native-drag-source.png');
  await writeFile(imagePath, bytes);
  const imagePaths = [imagePath,path.join(evidence,'second.png'),path.join(evidence,'third.png')];
  await Promise.all(imagePaths.slice(1).map(p=>writeFile(p,bytes)));
  source = new BrowserWindow({width:210,height:150,x:220,y:260,show:true,webPreferences:{nodeIntegration:true,contextIsolation:false}});
  await source.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;background:#f4ebd8;display:grid;place-items:center;height:100vh"><div draggable="true" style="padding:25px">拖拽验收图片</div><script>document.querySelector('div').ondragstart=e=>{e.preventDefault();require('electron').ipcRenderer.send('test:native-drag')};</script>`));
  ipcMain.on('test:native-drag', event => {
    console.log('OS drag started');
    event.sender.startDrag({files:imagePaths,icon:nativeImage.createFromPath(imagePath).resize({width:32,height:32})});
  });
  await nap(400);
  // Windows mouse movement triggers an OS file drag from the test source into the real ball.
  const sb = source.getContentBounds(), bb = ball.getContentBounds();
  const from = screen.dipToScreenPoint({x:Math.round(sb.x+sb.width/2),y:Math.round(sb.y+sb.height/2)});
  const to = screen.dipToScreenPoint({x:bb.x+44,y:bb.y+44});
  console.log(JSON.stringify({from,to,sb,bb}));
  const driver = spawn('powershell.exe', ['-NoProfile','-File',path.join(__dirname,'native-drag.ps1'),'-FromX',String(from.x),'-FromY',String(from.y),'-ToX',String(to.x),'-ToY',String(to.y)], {windowsHide:true});
  let driverError = ''; driver.stderr.on('data', x => driverError += x);
  await new Promise((resolve,reject) => {driver.on('error',reject);driver.on('exit',code=>code===0?resolve():reject(new Error(driverError)));});
  console.log(JSON.stringify(await ball.webContents.executeJavaScript('({events:window.dropEvents,label:document.getElementById("receiver-state").textContent})')));
  await until(() => !!received, 'native file drop and ACK');
  await until(async () => (await state()).label === '已收录', 'saved feedback');
  assert.equal(receivedCount,3);
  assert.equal(await ball.webContents.executeJavaScript('document.querySelector(".receiver-badge").textContent'),'3');
  assert.deepEqual(received, bytes);
  await capture('03-saved');
  const unsupported = path.join(evidence,'unsupported.txt');
  await writeFile(unsupported,'not an image');
  imagePaths[1] = unsupported;
  await mouse(from,to);
  await until(async () => (await state()).css.includes('is-error'),'partial batch failure');
  assert.equal(receivedCount,5,'only two more valid images delivered');
  assert.equal(await ball.webContents.executeJavaScript('document.querySelector(".receiver-badge").textContent'),'2','partial batch counts confirmed images only');
  await capture('06-partial-count');
  source.destroy();
  await nap(1800);
  const fixedBounds = ball.getBounds();
  await ball.webContents.executeJavaScript(`document.getElementById('receiver-ball').dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}))`);
  await nap(400);
  assert.deepEqual(ball.getBounds(), fixedBounds);
  const visual = await ball.webContents.executeJavaScript(`({width:document.getElementById('receiver-ball').getBoundingClientRect().width,scatter:Number(document.getElementById('receiver-orb').dataset.scatter)})`);
  assert.ok(Math.abs(visual.width-76)<0.1, 'fixed CSS diameter at fractional DPI');
  assert.ok(visual.scatter>0.8);
  assert.equal(ball.webContents.getZoomFactor(),1);
  await capture('05-scatter-fixed-size');
  // A non-file drop should show failure rather than fake a successful upload.
  await ball.webContents.executeJavaScript(`document.getElementById('receiver-ball').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}))`);
  await until(async () => (await state()).css.includes('is-error'), 'failure state');
  await capture('04-failed');
  ball.focus();
  const center = await ball.webContents.executeJavaScript(`(() => {const r=document.getElementById('receiver-ball').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const right = screen.dipToScreenPoint({x:Math.round(ball.getContentBounds().x+center.x),y:Math.round(ball.getContentBounds().y+center.y)});
  const rightDriver = spawn('powershell.exe', ['-NoProfile','-File',path.join(__dirname,'native-drag.ps1'),'-FromX',String(right.x),'-FromY',String(right.y),'-RightClick'], {windowsHide:true});
  await new Promise((resolve,reject) => {rightDriver.on('error',reject);rightDriver.on('exit',code=>code===0?resolve():reject(new Error('Right-click driver failed')));});
  console.log('right-click', JSON.stringify({right,bounds:ball.getBounds(),content:ball.getContentBounds(),events:await ball.webContents.executeJavaScript('window.dropEvents')}));
  await until(() => !!capturedMenu, 'native context menu');
  assert.ok(!ball.isDestroyed(), 'right click must not quit');
  const close = capturedMenu.items.find(x => x.label === '关闭收图球');
  assert.ok(close, 'explicit close menu item');
  capturedMenu.closePopup(ball);
  assert.deepEqual(errors, []);
  const result = {nativeDrag:true,receivedCount,successfulBatch:3,partialBatch:2,nativeMoveDelta:{x:movedBounds.x-initialBounds.x,y:movedBounds.y-initialBounds.y},backgroundClickAfterDrag:true,fixedSize:true,visual,bytes:received.length,sha256:createHash('sha256').update(received).digest('hex'),rightClickKeepsWindow:true,explicitClose:true,rendererErrors:errors};
  await writeFile(path.join(evidence,'acceptance.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  socket.close(); clearTimeout(deadline);
  close.click();
})().catch(error => { console.error(error); clearTimeout(deadline); socket?.terminate(); app.exit(1); });
