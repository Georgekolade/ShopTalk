/* Drive Playwright MCP over stdio: navigate, snapshot, screenshot. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'pw-out');
fs.mkdirSync(OUT, { recursive: true });
const URL = process.argv[2];
if (!URL) { console.error('usage: node inspect.cjs <url>'); process.exit(2); }

const args = process.env.HEADED === '1' ? [] : ['--headless'];
const proc = spawn('playwright-mcp', args, { shell: true });
let buf = '';
const pending = new Map();
let nextId = 1;
const done = (code) => { try { proc.kill(); } catch {} process.exit(code); };
setTimeout(() => { console.error('TIMEOUT'); done(3); }, 120000);

function send(obj) { proc.stdin.write(JSON.stringify(obj) + '\n'); }
function call(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).res(msg); pending.delete(msg.id); }
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d.toString()));

(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'inspect', version: '1.0' } });
  console.log('INIT', JSON.stringify(init.result?.serverInfo || init));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await call('tools/list', {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  console.log('TOOLS', names.join(','));
  const nav = await call('tools/call', { name: 'browser_navigate', arguments: { url: URL } });
  console.log('NAV', JSON.stringify(nav.result?.content?.map((c) => c.text || c.type) || nav).slice(0, 500));
  await call('tools/call', { name: 'browser_wait_for', arguments: { time: 15 } });
  const nav2 = await call('tools/call', { name: 'browser_navigate', arguments: { url: URL } });
  console.log('NAV2', JSON.stringify(nav2.result?.content?.map((c) => c.text || c.type) || nav2).slice(0, 500));
  await call('tools/call', { name: 'browser_wait_for', arguments: { time: 8 } });
  const snap = await call('tools/call', { name: 'browser_snapshot', arguments: {} });
  const text = (snap.result?.content || []).map((c) => c.text || '').join('\n');
  fs.writeFileSync(path.join(OUT, 'linea-snapshot.txt'), text, 'utf8');
  console.log('SNAPSHOT chars', text.length);
  const full = process.env.FULL !== '0';
  const shot = await call('tools/call', { name: 'browser_take_screenshot', arguments: { filename: full ? 'linea-full.png' : 'linea-view.png', fullPage: full, type: 'png' } });
  const parts = shot.result?.content || [];
  for (const p of parts) {
    if (p.type === 'image' && p.data) fs.writeFileSync(path.join(OUT, 'linea-full.png'), Buffer.from(p.data, 'base64'));
    if (p.text) console.log('SHOT', p.text.slice(0, 300));
  }
  console.log('DONE');
  done(0);
})().catch((e) => { console.error(e); done(1); });
